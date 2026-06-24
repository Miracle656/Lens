import type { FastifyInstance } from 'fastify'
import { getBestRoute } from '../aggregator/bestRoute'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getMedianPrice, type PriceSource } from '../pricing/median'
import { config } from '../config'
import { pgPool } from '../db'
import { price_requests_total } from '../metrics'
import { getCachedPrice, setCachedPrice } from '../redis'
import {
    historyResponseSchema,
    installResponseValidation,
    poolsResponseSchema,
    priceResponseSchema,
    routeResponseSchema,
    statusResponseSchema,
} from './schemas'

function makePairKey(a: string, b: string): string {
  return [a, b].sort().join('/')
}

function findPair(assetA: string, assetB: string) {
  const normalize = (a: string) => a.toLowerCase() === 'native' ? 'XLM' : a.split(':')[0].toUpperCase()
  const cA = normalize(assetA)
  const cB = normalize(assetB)
  return config.pairs.find(p => {
    const pA = p.assetA.code.toUpperCase()
    const pB = p.assetB.code.toUpperCase()
    return (cA === pA && cB === pB) || (cA === pB && cB === pA)
  })
}

async function extractSourcePrices(pairKey: string): Promise<PriceSource[]> {
  const sources: PriceSource[] = []

  try {
    // Get the latest SDEX price
    const sdexResult = await pgPool.query(
      `SELECT price::numeric, timestamp
       FROM price_points
       WHERE pair_key = $1 AND source = 'SDEX'
       ORDER BY timestamp DESC LIMIT 1`,
      [pairKey]
    )

    if (sdexResult.rows[0]) {
      const row = sdexResult.rows[0]
      sources.push({
        id: 'SDEX',
        price: parseFloat(row.price),
        timestamp: new Date(row.timestamp).getTime(),
        priority: 0,
      })
    }

    // Get the latest AMM price
    const ammResult = await pgPool.query(
      `SELECT AVG(ps.spot_price::numeric) AS spot_price, MAX(ps.timestamp) AS timestamp
       FROM pool_snapshots ps
       WHERE ps.pool_id IN (
         SELECT DISTINCT pool_id FROM price_points
         WHERE pair_key = $1 AND source = 'AMM' AND pool_id IS NOT NULL
       )`,
      [pairKey]
    )

    if (ammResult.rows[0] && ammResult.rows[0].spot_price) {
      sources.push({
        id: 'AMM',
        price: parseFloat(ammResult.rows[0].spot_price),
        timestamp: new Date(ammResult.rows[0].timestamp).getTime(),
        priority: 1,
      })
    }
  } catch (err) {
    // If source extraction fails, return empty sources and fall through
    // The aggregated price can still be returned
  }

  return sources
}

export async function registerRESTRoutes(app: FastifyInstance) {
  // Validate every response against its declared schema in dev/test (no-op in
  // production). Must run before the routes below are registered so they pick
  // up the validating serializer.
  installResponseValidation(app)

  // GET /status — public health/monitoring endpoint (no API key required)
  app.get('/status', { config: { public: true }, schema: { response: { 200: statusResponseSchema } } }, async () => {
    const result = await pgPool.query(
      `SELECT last_ledger, last_processed_at FROM indexer_state ORDER BY updated_at DESC LIMIT 1`
    )
    return {
      ok: true,
      watchedPairs: config.pairs.map(p => p.pairKey),
      lastIndexedLedger: result.rows[0]?.last_ledger ?? null,
      lastProcessedAt: result.rows[0]?.last_processed_at ?? null,
    }
  })


  // GET /price/:assetA/:assetB
  app.get<{ Params: { assetA: string; assetB: string } }>(
    '/price/:assetA/:assetB',
    { schema: { response: { 200: priceResponseSchema } } },
    async (req, reply) => {
      price_requests_total.inc()
      const { assetA, assetB } = req.params
      const pair = findPair(assetA, assetB)
      if (!pair) return reply.status(404).send({ error: `Pair ${assetA}/${assetB} not watched` })

      const cached = await getCachedPrice(pair.pairKey)
      if (cached) {
        try {
          reply.header('X-Cache', 'HIT')
          return JSON.parse(cached)
        } catch { /* fall through */ }
      }

      const [agg, route, sources] = await Promise.all([
        getAggregatedPrice(pair.pairKey),
        getBestRoute(pair.assetA, pair.assetB, pair.pairKey, 1000),
        extractSourcePrices(pair.pairKey),
      ])

      const medianResult = getMedianPrice(sources, {
        freshnessThresholdMs: 60_000,
        minFreshSources: 2,
        fallbackChain: [['SDEX', 'AMM']],
      })

      const result = {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        ...agg,
        bestRoute: route.route,
        medianPrice: medianResult.median,
        medianPriceSources: medianResult.includedSources,
        excludedSources: medianResult.excludedSources,
        medianFallbackEngaged: medianResult.fallbackEngaged,
        lastUpdated: new Date().toISOString(),
      }

      await setCachedPrice(pair.pairKey, result, config.cache.priceTtl)
      reply.header('X-Cache', 'MISS')
      return result
    }
  )

  // GET /price/:assetA/:assetB/route?amount=1000
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { amount?: string }
  }>(
    '/price/:assetA/:assetB/route',
    { schema: { response: { 200: routeResponseSchema } } },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      const amount = parseFloat(req.query.amount ?? '1000')
      const pair = findPair(assetA, assetB)
      if (!pair) return reply.status(404).send({ error: `Pair ${assetA}/${assetB} not watched` })
      if (isNaN(amount) || amount <= 0) return reply.status(400).send({ error: 'amount must be a positive number' })

      return getBestRoute(pair.assetA, pair.assetB, pair.pairKey, amount)
    }
  )

  // GET /price/:assetA/:assetB/history?window=1h&limit=100
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { window?: string; limit?: string }
  }>(
    '/price/:assetA/:assetB/history',
    { schema: { response: { 200: historyResponseSchema } } },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      const window = req.query.window ?? '1h'
      const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 1000)
      const pairKey = makePairKey(assetA, assetB)

      if (!['1m', '5m', '1h', '24h'].includes(window)) {
        return reply.status(400).send({ error: 'window must be one of: 1m, 5m, 1h, 24h' })
      }

      const result = await pgPool.query(
        `SELECT bucket, window, vwap::float, sdex_vwap::float, amm_vwap::float,
                volume::float, trade_count, open_price::float, close_price::float,
                high_price::float, low_price::float
         FROM price_aggregates
         WHERE pair_key = $1 AND window = $2
         ORDER BY bucket DESC
         LIMIT $3`,
        [pairKey, window, limit]
      )

      return {
        pairKey,
        window,
        buckets: result.rows.map(r => ({
          bucket: r.bucket,
          vwap: r.vwap,
          sdexVwap: r.sdex_vwap,
          ammVwap: r.amm_vwap,
          volume: r.volume,
          tradeCount: r.trade_count,
          open: r.open_price,
          close: r.close_price,
          high: r.high_price,
          low: r.low_price,
        })),
      }
    }
  )

  // GET /pools
  app.get('/pools', { schema: { response: { 200: poolsResponseSchema } } }, async () => {
    const result = await pgPool.query(
      `SELECT DISTINCT ON (pool_id) pool_id, asset_a, asset_b,
              reserve_a::float, reserve_b::float, spot_price::float, fee_bp, timestamp
       FROM pool_snapshots
       ORDER BY pool_id, timestamp DESC`
    )
    return { pools: result.rows }
  })
}
