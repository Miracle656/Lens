import type { FastifyInstance } from 'fastify'
import { getCachedPrice, setCachedPrice } from '../redis'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import { config } from '../config'

function makePairKey(a: string, b: string): string {
  return [a, b].sort().join('/')
}

function findPair(assetA: string, assetB: string) {
  const key = makePairKey(assetA, assetB)
  return config.pairs.find(p => p.pairKey === key)
}

export async function registerRESTRoutes(app: FastifyInstance) {
  // GET /status
  app.get('/status', async () => {
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

  // GET /pairs
  app.get('/pairs', async () => ({
    pairs: config.pairs.map(p => ({
      pairKey: p.pairKey,
      assetA: p.assetA,
      assetB: p.assetB,
    })),
  }))

  // GET /price/:assetA/:assetB
  app.get<{ Params: { assetA: string; assetB: string } }>(
    '/price/:assetA/:assetB',
    async (req, reply) => {
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

      const agg = await getAggregatedPrice(pair.pairKey)
      const route = await getBestRoute(pair.assetA, pair.assetB, pair.pairKey, 1000)
      const result = {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        ...agg,
        bestRoute: route.route,
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
  app.get('/pools', async () => {
    const result = await pgPool.query(
      `SELECT DISTINCT ON (pool_id) pool_id, asset_a, asset_b,
              reserve_a::float, reserve_b::float, spot_price::float, fee_bp, timestamp
       FROM pool_snapshots
       ORDER BY pool_id, timestamp DESC`
    )
    return { pools: result.rows }
  })
}
