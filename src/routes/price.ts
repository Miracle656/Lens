import type { FastifyInstance } from 'fastify'
import { computeTWAP, computeVWAP } from '../pricing/twap'

/**
 * Register manipulation-resistant TWAP/VWAP pricing endpoints.
 *
 * GET /price/twap/:assetA/:assetB?window=60&sampleInterval=60&method=iqr
 * GET /price/vwap/:assetA/:assetB?window=60&source=&method=iqr
 */
export async function registerPriceRoutes(app: FastifyInstance) {
  // ─── TWAP ────────────────────────────────────────────────────────────────────
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: {
      window?: string
      sampleInterval?: string
      method?: 'iqr' | 'modified_zscore'
    }
  }>(
    '/price/twap/:assetA/:assetB',
    async (req, reply) => {
      const { assetA, assetB } = req.params
      const windowMinutes = parseInt(req.query.window ?? '60', 10)
      const sampleInterval = parseInt(req.query.sampleInterval ?? '60', 10)
      const method = req.query.method ?? 'iqr'

      if (windowMinutes < 1 || windowMinutes > 1440) {
        return reply.status(400).send({ error: 'window must be between 1 and 1440 minutes' })
      }
      if (sampleInterval < 1 || sampleInterval > 3600) {
        return reply.status(400).send({ error: 'sampleInterval must be between 1 and 3600 seconds' })
      }

      const pairKey = [assetA, assetB].sort().join('/')

      try {
        const result = await computeTWAP(pairKey, windowMinutes, {
          sampleIntervalSeconds: sampleInterval,
          outlierMethod: method,
        })

        return {
          assetA,
          assetB,
          pairKey,
          twap: result.twap,
          windowMinutes,
          sampleIntervalSeconds: sampleInterval,
          startTime: result.startTime,
          endTime: result.endTime,
          sampleCount: result.sampleCount,
          outlierRejected: result.outlierRejected,
          filterMethod: result.filterMethod,
        }
      } catch (err) {
        return reply.status(500).send({ error: `TWAP computation failed: ${(err as Error).message}` })
      }
    }
  )

  // ─── VWAP ────────────────────────────────────────────────────────────────────
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: {
      window?: string
      source?: 'SDEX' | 'AMM'
      method?: 'iqr' | 'modified_zscore'
    }
  }>(
    '/price/vwap/:assetA/:assetB',
    async (req, reply) => {
      const { assetA, assetB } = req.params
      const windowMinutes = parseInt(req.query.window ?? '60', 10)
      const source = req.query.source
      const method = req.query.method ?? 'iqr'

      if (windowMinutes < 1 || windowMinutes > 1440) {
        return reply.status(400).send({ error: 'window must be between 1 and 1440 minutes' })
      }

      const pairKey = [assetA, assetB].sort().join('/')

      try {
        const result = await computeVWAP(pairKey, windowMinutes, {
          source,
          outlierMethod: method,
        })

        return {
          assetA,
          assetB,
          pairKey,
          vwap: result.vwap,
          windowMinutes,
          source: source ?? 'all',
          startTime: result.startTime,
          endTime: result.endTime,
          sampleCount: result.sampleCount,
          volumeTotal: result.volumeTotal,
          outlierRejected: result.outlierRejected,
          filterMethod: result.filterMethod,
        }
      } catch (err) {
        return reply.status(500).send({ error: `VWAP computation failed: ${(err as Error).message}` })
      }
    }
  )
}