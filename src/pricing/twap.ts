import { pgPool } from '../db'

// ─── TWAP — Time-Weighted Average Price ───────────────────────────────────────
// Computed by averaging the midpoints of successive price points weighted by
// the time interval between them. This gives more weight to prices that prevailed
// for longer, reducing the impact of brief manipulation spikes.

export interface TWAPResult {
  twap: number
  startTime: Date
  endTime: Date
  sampleCount: number
  outlierRejected: number
  filterMethod: string
}

export interface VWAPResult {
  vwap: number
  startTime: Date
  endTime: Date
  sampleCount: number
  volumeTotal: number
  outlierRejected: number
  filterMethod: string
}

/**
 * Reject outliers using the Interquartile Range (IQR) method.
 * Prices outside [Q1 - 1.5*IQR, Q3 + 1.5*IQR] are considered outliers.
 * Returns the filtered array and count of rejected points.
 */
function rejectOutliersIQR(prices: number[]): { filtered: number[]; rejected: number } {
  if (prices.length < 4) return { filtered: prices, rejected: 0 }

  const sorted = [...prices].sort((a, b) => a - b)
  const n = sorted.length

  // Q1 = median of lower half
  const lowerHalf = sorted.slice(0, Math.floor(n / 2))
  const upperHalf = sorted.slice(Math.ceil(n / 2))

  const q1 = median(lowerHalf)
  const q3 = median(upperHalf)
  const iqr = q3 - q1

  const lowerBound = q1 - 1.5 * iqr
  const upperBound = q3 + 1.5 * iqr

  const filtered = prices.filter(p => p >= lowerBound && p <= upperBound)
  return { filtered, rejected: prices.length - filtered.length }
}

/**
 * Reject outliers using the Modified Z-Score method (more robust for small samples).
 * Points with |z_score| > 3.5 are rejected.
 */
function rejectOutliersModifiedZScore(prices: number[]): { filtered: number[]; rejected: number } {
  if (prices.length < 4) return { filtered: prices, rejected: 0 }

  const sorted = [...prices].sort((a, b) => a - b)
  const med = median(sorted)
  const mad = median(sorted.map(v => Math.abs(v - med))) // Median Absolute Deviation

  // If MAD is 0 (all same values), no outliers
  if (mad === 0) return { filtered: prices, rejected: 0 }

  const threshold = 3.5
  const filtered = prices.filter(p => {
    const zScore = 0.6745 * (p - med) / mad
    return Math.abs(zScore) <= threshold
  })

  return { filtered, rejected: prices.length - filtered.length }
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// ─── TWAP Computation ─────────────────────────────────────────────────────────

/**
 * Compute Time-Weighted Average Price over a configurable window.
 * Uses IQR outlier rejection by default.
 *
 * TWAP = Σ(price_i * Δt_i) / Σ(Δt_i)  where Δt_i is the time to the next sample.
 *
 * Price points are fetched from the price_points table at a regular sample
 * interval. If no trades occur within a sub-interval, the last known price
 * is carried forward (prevents stale gap manipulation).
 */
export async function computeTWAP(
  pairKey: string,
  windowMinutes: number,
  options?: {
    sampleIntervalSeconds?: number
    outlierMethod?: 'iqr' | 'modified_zscore'
  }
): Promise<TWAPResult> {
  const sampleIntervalSeconds = options?.sampleIntervalSeconds ?? 60
  const outlierMethod = options?.outlierMethod ?? 'iqr'

  // Fetch price points within the window, ordered by timestamp
  const result = await pgPool.query(
    `SELECT price::numeric as price, timestamp
     FROM price_points
     WHERE pair_key = $1
       AND timestamp > NOW() - ($2 || ' minutes')::interval
     ORDER BY timestamp ASC`,
    [pairKey, windowMinutes]
  )

  const rows = result.rows
  if (rows.length === 0) {
    return {
      twap: 0,
      startTime: new Date(Date.now() - windowMinutes * 60_000),
      endTime: new Date(),
      sampleCount: 0,
      outlierRejected: 0,
      filterMethod: outlierMethod,
    }
  }

  // Extract raw prices for outlier rejection
  const rawPrices = rows.map((r: any) => parseFloat(r.price))

  // Reject outliers
  const { filtered: validPrices, rejected } = outlierMethod === 'iqr'
    ? rejectOutliersIQR(rawPrices)
    : rejectOutliersModifiedZScore(rawPrices)

  if (validPrices.length === 0) {
    return {
      twap: 0,
      startTime: rows[0].timestamp,
      endTime: rows[rows.length - 1].timestamp,
      sampleCount: rawPrices.length,
      outlierRejected: rejected,
      filterMethod: outlierMethod,
    }
  }

  // Build equi-spaced time grid and interpolate price at each sample point
  const startTime = new Date(rows[0].timestamp).getTime()
  const endTime = new Date(rows[rows.length - 1].timestamp).getTime()
  const totalDurationMs = endTime - startTime

  if (totalDurationMs <= 0) {
    // Single data point — use its price
    return {
      twap: validPrices[0],
      startTime: rows[0].timestamp,
      endTime: rows[rows.length - 1].timestamp,
      sampleCount: rawPrices.length,
      outlierRejected: rejected,
      filterMethod: outlierMethod,
    }
  }

  const sampleIntervalMs = sampleIntervalSeconds * 1000
  const sampleCount = Math.max(1, Math.floor(totalDurationMs / sampleIntervalMs))
  const interpolatedPrices: { price: number; weight: number }[] = []

  // Build sorted (timestamp, price) pairs for the valid points
  const validPoints = rows
    .map((r: any, i: number) => ({
      ts: new Date(r.timestamp).getTime(),
      price: validPrices[i],
    }))
    .filter((_: any, i: number) => i < validPrices.length)
    .sort((a: any, b: any) => a.ts - b.ts)

  for (let i = 0; i <= sampleCount; i++) {
    const sampleTs = startTime + i * sampleIntervalMs
    if (sampleTs > endTime) break

    // Find the closest price at or before this sample time (last observation carry forward)
    let interpolatedPrice = validPoints[0].price
    for (let j = 0; j < validPoints.length; j++) {
      if (validPoints[j].ts <= sampleTs) {
        interpolatedPrice = validPoints[j].price
      } else {
        break
      }
    }

    // Weight: time to next sample or to end
    const nextSampleTs = Math.min(startTime + (i + 1) * sampleIntervalMs, endTime)
    const weight = (nextSampleTs - sampleTs) / totalDurationMs
    interpolatedPrices.push({ price: interpolatedPrice, weight })
  }

  // Compute TWAP as weighted average
  const twap = interpolatedPrices.reduce((sum, p) => sum + p.price * p.weight, 0)

  return {
    twap,
    startTime: new Date(startTime),
    endTime: new Date(endTime),
    sampleCount: rawPrices.length,
    outlierRejected: rejected,
    filterMethod: outlierMethod,
  }
}

// ─── VWAP Computation ─────────────────────────────────────────────────────────

/**
 * Compute Volume-Weighted Average Price over a configurable window.
 * Uses IQR outlier rejection by default.
 *
 * VWAP = Σ(price_i * volume_i) / Σ(volume_i)
 *
 * Volume is base_volume. Only trades within the window contribute —
 * no interpolation needed since each trade is naturally volume-weighted.
 */
export async function computeVWAP(
  pairKey: string,
  windowMinutes: number,
  options?: {
    source?: 'SDEX' | 'AMM'
    outlierMethod?: 'iqr' | 'modified_zscore'
  }
): Promise<VWAPResult> {
  const outlierMethod = options?.outlierMethod ?? 'iqr'

  let query: string
  let params: any[]

  if (options?.source) {
    query = `SELECT price::numeric as price, base_volume::numeric as volume, timestamp
             FROM price_points
             WHERE pair_key = $1
               AND source = $3
               AND timestamp > NOW() - ($2 || ' minutes')::interval
             ORDER BY timestamp ASC`
    params = [pairKey, windowMinutes, options.source]
  } else {
    query = `SELECT price::numeric as price, base_volume::numeric as volume, timestamp
             FROM price_points
             WHERE pair_key = $1
               AND timestamp > NOW() - ($2 || ' minutes')::interval
             ORDER BY timestamp ASC`
    params = [pairKey, windowMinutes]
  }

  const result = await pgPool.query(query, params)
  const rows = result.rows

  if (rows.length === 0) {
    return {
      vwap: 0,
      startTime: new Date(Date.now() - windowMinutes * 60_000),
      endTime: new Date(),
      sampleCount: 0,
      volumeTotal: 0,
      outlierRejected: 0,
      filterMethod: outlierMethod,
    }
  }

  // For VWAP, outlier rejection considers the price dimension only
  // (volume dimension is not subject to manipulation in the same way)
  const rawPrices = rows.map((r: any) => parseFloat(r.price))

  // Reject outliers on prices
  const { rejectedIndices } = outlierMethod === 'iqr'
    ? rejectOutliersWithIndices(rawPrices)
    : rejectOutliersModifiedZScoreWithIndices(rawPrices)

  // Filter out outlier rows
  const validRows = rows.filter((_: any, i: number) => !rejectedIndices.has(i))

  if (validRows.length === 0) {
    return {
      vwap: 0,
      startTime: rows[0].timestamp,
      endTime: rows[rows.length - 1].timestamp,
      sampleCount: rawPrices.length,
      volumeTotal: 0,
      outlierRejected: rejectedIndices.size,
      filterMethod: outlierMethod,
    }
  }

  let totalVolume = 0
  let weightedPriceSum = 0

  for (const row of validRows) {
    const price = parseFloat(row.price)
    const volume = parseFloat(row.volume)
    weightedPriceSum += price * volume
    totalVolume += volume
  }

  const vwap = totalVolume > 0 ? weightedPriceSum / totalVolume : 0

  return {
    vwap,
    startTime: rows[0].timestamp,
    endTime: rows[rows.length - 1].timestamp,
    sampleCount: rawPrices.length,
    volumeTotal: totalVolume,
    outlierRejected: rejectedIndices.size,
    filterMethod: outlierMethod,
  }
}

// ─── Helper: Outlier rejection returning rejected indices ─────────────────────

function rejectOutliersWithIndices(prices: number[]): { rejectedIndices: Set<number> } {
  if (prices.length < 4) return { rejectedIndices: new Set() }

  const sorted = [...prices].sort((a, b) => a - b)
  const n = sorted.length

  const lowerHalf = sorted.slice(0, Math.floor(n / 2))
  const upperHalf = sorted.slice(Math.ceil(n / 2))

  const q1 = median(lowerHalf)
  const q3 = median(upperHalf)
  const iqr = q3 - q1

  const lowerBound = q1 - 1.5 * iqr
  const upperBound = q3 + 1.5 * iqr

  const rejectedIndices = new Set<number>()
  prices.forEach((p, i) => {
    if (p < lowerBound || p > upperBound) rejectedIndices.add(i)
  })

  return { rejectedIndices }
}

function rejectOutliersModifiedZScoreWithIndices(prices: number[]): { rejectedIndices: Set<number> } {
  if (prices.length < 4) return { rejectedIndices: new Set() }

  const sorted = [...prices].sort((a, b) => a - b)
  const med = median(sorted)
  const mad = median(sorted.map(v => Math.abs(v - med)))

  if (mad === 0) return { rejectedIndices: new Set() }

  const threshold = 3.5
  const rejectedIndices = new Set<number>()
  prices.forEach((p, i) => {
    const zScore = 0.6745 * (p - med) / mad
    if (Math.abs(zScore) > threshold) rejectedIndices.add(i)
  })

  return { rejectedIndices }
}