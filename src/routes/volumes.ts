import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'

// Supported windows → lookback in hours.
const WINDOW_HOURS = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
} as const

type VolumeWindow = keyof typeof WINDOW_HOURS

const WINDOWS = Object.keys(WINDOW_HOURS) as VolumeWindow[]

/**
 * Register the aggregated cross-venue volume endpoint.
 *
 * GET /volumes/:asset?window=24h|7d|30d
 *
 * Sums traded volume for `asset` across every pair it appears in and across all
 * venues (SDEX, AMM, …) over the requested window. Volume is measured in the
 * asset's own units: when it is the base asset of a pair we count `base_volume`,
 * when it is the counter asset we count `counter_volume`. The response breaks the
 * total down per venue and also returns the cross-venue sum.
 */
export async function registerVolumeRoutes(app: FastifyInstance) {
  app.get<{
    Params: { asset: string }
    Querystring: { window?: string }
  }>('/volumes/:asset', async (req, reply) => {
    const { asset } = req.params
    const window = req.query.window ?? '24h'

    if (!(window in WINDOW_HOURS)) {
      return reply
        .status(400)
        .send({ error: `window must be one of: ${WINDOWS.join(', ')}` })
    }

    const hours = WINDOW_HOURS[window as VolumeWindow]
    const endTime = new Date()
    const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000)

    try {
      // Per-venue volume for the asset, summed over the window. The asset's volume
      // is base_volume when it's asset_a and counter_volume when it's asset_b.
      const { rows } = await pgPool.query(
        `SELECT source,
                SUM(
                  CASE
                    WHEN asset_a = $1 THEN base_volume
                    WHEN asset_b = $1 THEN counter_volume
                    ELSE 0
                  END
                )::numeric AS volume,
                COUNT(*)::int AS trade_count
           FROM price_points
          WHERE (asset_a = $1 OR asset_b = $1)
            AND timestamp >= $2
          GROUP BY source`,
        [asset, startTime],
      )

      const byVenue: Record<string, number> = {}
      let totalVolume = 0
      let tradeCount = 0

      for (const row of rows) {
        const volume = parseFloat(row.volume) || 0
        byVenue[row.source] = volume
        totalVolume += volume
        tradeCount += Number(row.trade_count) || 0
      }

      return {
        asset,
        window,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        // Cross-venue sum.
        totalVolume,
        // Per-venue breakdown that the total is summed from.
        byVenue,
        venues: Object.keys(byVenue),
        tradeCount,
      }
    } catch (err) {
      return reply
        .status(500)
        .send({ error: `Volume aggregation failed: ${(err as Error).message}` })
    }
  })
}
