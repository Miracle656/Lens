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
       FIRST(price::numeric, timestamp) AS open,
       MAX(price::numeric) AS high,
       MIN(price::numeric) AS low,
       LAST(price::numeric, timestamp) AS close,
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
       FIRST(price::numeric, timestamp) AS price_24h_ago,
       LAST(price::numeric, timestamp) AS price_now
     FROM price_points
     WHERE pair_key = $1
       AND timestamp > NOW() - INTERVAL '24 hours'`,
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
}> {
  const [vwap1m, vwap5m, vwap1h, vwap24h, sdexVwap24h, ammVwap24h, priceChange24h] = await Promise.all([
    calculateVWAP(pairKey, 1),
    calculateVWAP(pairKey, 5),
    calculateVWAP(pairKey, 60),
    calculateVWAP(pairKey, 1440),
    calculateVWAP(pairKey, 1440, 'SDEX'),
    calculateVWAP(pairKey, 1440, 'AMM'),
    getPriceChange24h(pairKey),
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

  return {
    price: vwap1h || vwap24h || 0,
    sdexPrice: sdexVwap24h,
    ammPrice: ammVwap24h,
    volume24h: sdexVolume24h + ammVolume24h,
    sdexVolume24h,
    ammVolume24h,
    vwap1m,
    vwap5m,
    vwap1h,
    vwap24h,
    priceChange24h,
    sources: parseInt(sourcesResult.rows[0]?.sources ?? '1', 10),
  }
}
