import { pgPool } from '../db'

export async function calculateVWAP(
  pairKey: string,
  windowMinutes: number,
  source?: 'SDEX' | 'AMM'
): Promise<number> {
  const sourceFilter = source ? `AND source = $3` : ''
  const params: (string | number)[] = [pairKey, windowMinutes]
  if (source) params.push(source)

  const result = await pgPool.query(
    `SELECT
       COALESCE(
         SUM(price::numeric * base_volume::numeric) / NULLIF(SUM(base_volume::numeric), 0),
         0
       ) AS vwap
     FROM price_points
     WHERE pair_key = $1
       AND timestamp > NOW() - ($2 || ' minutes')::interval
       ${sourceFilter}`,
    params
  )
  return parseFloat(result.rows[0]?.vwap ?? '0')
}

export async function calculateOHLCV(
  pairKey: string,
  windowMinutes: number
): Promise<{
  open: number; high: number; low: number; close: number
  volume: number; tradeCount: number
}> {
  const result = await pgPool.query(
    `SELECT
       (SELECT price::numeric FROM price_points
        WHERE pair_key = $1 AND timestamp > NOW() - ($2 || ' minutes')::interval
        ORDER BY timestamp ASC LIMIT 1) AS open,
       MAX(price::numeric) AS high,
       MIN(price::numeric) AS low,
       (SELECT price::numeric FROM price_points
        WHERE pair_key = $1 AND timestamp > NOW() - ($2 || ' minutes')::interval
        ORDER BY timestamp DESC LIMIT 1) AS close,
       SUM(base_volume::numeric) AS volume,
       COUNT(*) AS trade_count
     FROM price_points
     WHERE pair_key = $1
       AND timestamp > NOW() - ($2 || ' minutes')::interval`,
    [pairKey, windowMinutes]
  )
  const row = result.rows[0]
  return {
    open: parseFloat(row?.open ?? '0'),
    high: parseFloat(row?.high ?? '0'),
    low: parseFloat(row?.low ?? '0'),
    close: parseFloat(row?.close ?? '0'),
    volume: parseFloat(row?.volume ?? '0'),
    tradeCount: parseInt(row?.trade_count ?? '0', 10),
  }
}

export async function getPriceChange24h(pairKey: string): Promise<number> {
  const result = await pgPool.query(
    `SELECT
       (SELECT price::numeric FROM price_points
        WHERE pair_key = $1 AND timestamp > NOW() - INTERVAL '24 hours'
        ORDER BY timestamp ASC LIMIT 1) AS price_24h_ago,
       (SELECT price::numeric FROM price_points
        WHERE pair_key = $1 AND timestamp > NOW() - INTERVAL '24 hours'
        ORDER BY timestamp DESC LIMIT 1) AS price_now`,
    [pairKey]
  )
  const row = result.rows[0]
  const ago = parseFloat(row?.price_24h_ago ?? '0')
  const now = parseFloat(row?.price_now ?? '0')
  if (ago === 0) return 0
  return ((now - ago) / ago) * 100
}

export async function getAggregatedPrice(pairKey: string): Promise<{
  price: number; sdexPrice: number; ammPrice: number
  volume24h: number; sdexVolume24h: number; ammVolume24h: number
  vwap1m: number; vwap5m: number; vwap1h: number; vwap24h: number
  priceChange24h: number; sources: number
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  lastTradeAgeSeconds: number | null
}> {
  const [vwap1m, vwap5m, vwap1h, vwap24h, sdexVwap24h, priceChange24h, ammSpotResult, lastTradeResult] = await Promise.all([
    calculateVWAP(pairKey, 1),
    calculateVWAP(pairKey, 5),
    calculateVWAP(pairKey, 60),
    calculateVWAP(pairKey, 1440),
    calculateVWAP(pairKey, 1440, 'SDEX'),
    getPriceChange24h(pairKey),
    // AMM price: latest spot_price averaged across pools for this pair
    pgPool.query(
      `SELECT AVG(spot_price::numeric) AS amm_price
       FROM (
         SELECT DISTINCT ON (ps.pool_id) ps.spot_price
         FROM pool_snapshots ps
         WHERE ps.pool_id IN (
           SELECT DISTINCT pool_id FROM price_points
           WHERE pair_key = $1 AND source = 'AMM' AND pool_id IS NOT NULL
         )
         ORDER BY ps.pool_id, ps.timestamp DESC
       ) latest`,
      [pairKey]
    ),
    // Last trade timestamp
    pgPool.query(
      `SELECT MAX(timestamp) as last_trade FROM price_points WHERE pair_key = $1`,
      [pairKey]
    ),
  ])

  const volResult = await pgPool.query(
    `SELECT
       source,
       SUM(base_volume::numeric) AS vol
     FROM price_points
     WHERE pair_key = $1
       AND timestamp > NOW() - INTERVAL '24 hours'
     GROUP BY source`,
    [pairKey]
  )

  let sdexVolume24h = 0
  let ammVolume24h = 0
  for (const row of volResult.rows) {
    if (row.source === 'SDEX') sdexVolume24h = parseFloat(row.vol)
    else if (row.source === 'AMM') ammVolume24h = parseFloat(row.vol)
  }

  const sourcesResult = await pgPool.query(
    `SELECT COUNT(DISTINCT COALESCE(pool_id, 'sdex')) AS sources
     FROM price_points
     WHERE pair_key = $1
       AND timestamp > NOW() - INTERVAL '1 hour'`,
    [pairKey]
  )

  const ammPrice = parseFloat(ammSpotResult.rows[0]?.amm_price ?? '0')
  const lastTrade = lastTradeResult.rows[0]?.last_trade
  const lastTradeAgeSeconds = lastTrade ? Math.floor((Date.now() - new Date(lastTrade).getTime()) / 1000) : null
  const sources = parseInt(sourcesResult.rows[0]?.sources ?? '0', 10)
  const volume24h = sdexVolume24h + ammVolume24h


  let confidence: 'high' | 'medium' | 'low' | 'unknown' = 'unknown'
  if (lastTradeAgeSeconds === null) {
    confidence = 'unknown'
  } else if (lastTradeAgeSeconds < 30 && sources > 1 && volume24h > 0) {
    confidence = 'high'
  } else if (lastTradeAgeSeconds < 300) {
    confidence = 'medium'
  } else {
    confidence = 'low'
  }

  return {
    price: vwap1h || vwap24h || ammPrice || 0,
    sdexPrice: sdexVwap24h,
    ammPrice,
    volume24h,
    sdexVolume24h,
    ammVolume24h,
    vwap1m,
    vwap5m,
    vwap1h,
    vwap24h,
    priceChange24h,
    sources,
    confidence,
    lastTradeAgeSeconds,
  }
}
