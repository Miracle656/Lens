import type { FastifyInstance } from 'fastify'
import { getActivePairs, parseAssetStr, makePairKey, registerPair, persistPair, hasPair } from '../pairsRegistry'

export async function registerPairsRoutes(app: FastifyInstance) {
  // GET /pairs — list all active pairs (already exists in rest.ts but this is the authoritative source)
  app.get('/pairs', async () => ({
    pairs: getActivePairs().map(p => ({
      pairKey: p.pairKey,
      assetA: p.assetA,
      assetB: p.assetB,
    })),
  }))

  // POST /pairs — add a new trading pair at runtime
  app.post<{
    Body: { assetA?: string; assetB?: string }
  }>('/pairs', async (req, reply) => {
    // Auth check — read at request time so env can be set after module load
    const ADMIN_API_KEY = process.env.ADMIN_API_KEY
    const key = req.headers['x-admin-key'] ?? req.headers['authorization']?.replace(/^Bearer /, '')
    if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
      return reply.status(401).send({ error: 'Unauthorized — provide a valid X-Admin-Key header' })
    }

    const { assetA: assetAStr, assetB: assetBStr } = req.body ?? {}

    if (!assetAStr || !assetBStr) {
      return reply.status(400).send({ error: 'assetA and assetB are required' })
    }

    const assetA = parseAssetStr(assetAStr)
    if (!assetA) {
      return reply.status(400).send({
        error: `Invalid assetA format "${assetAStr}". Expected CODE or CODE:ISSUER (e.g. XLM:native or USDC:GBBD47...)`,
      })
    }

    const assetB = parseAssetStr(assetBStr)
    if (!assetB) {
      return reply.status(400).send({
        error: `Invalid assetB format "${assetBStr}". Expected CODE or CODE:ISSUER (e.g. XLM:native or USDC:GBBD47...)`,
      })
    }

    const pairKey = makePairKey(assetA, assetB)

    if (hasPair(pairKey)) {
      return reply.status(409).send({ error: `Pair ${pairKey} is already being watched` })
    }

    const pair = { assetA, assetB, pairKey }
    registerPair(pair)
    await persistPair(pair)

    console.log(`[pairs] Added runtime pair: ${pairKey}`)
    return reply.status(201).send({ pairKey, assetA, assetB })
  })
}
