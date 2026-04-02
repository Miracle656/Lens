import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import { config } from './config'
import { redis } from './redis'
import { pgPool } from './db'
import { registerRESTRoutes } from './api/rest'
import { registerGraphQL } from './api/graphql'
import { registerX402 } from './middleware/x402'
import { startSDEXIngester } from './ingesters/sdex'
import { startAMMIngester } from './ingesters/amm'
import { createAggregateQueue, startAggregateWorker, scheduleAggregateRefresh } from './jobs/aggregateRefresh'

async function main() {
  // ── Connect dependencies ──────────────────────────────────────────────────
  await redis.connect()
  console.log('[lens] Redis connected')

  await pgPool.connect()
  console.log('[lens] PostgreSQL connected')

  // ── Fastify API server ────────────────────────────────────────────────────
  const app = Fastify({ logger: { level: 'warn' } })
  await app.register(cors, { origin: true })
  await app.register(compress)

  await app.register(registerX402)
  await registerRESTRoutes(app)
  await registerGraphQL(app)

  await app.listen({ port: config.api.port, host: config.api.host })
  console.log(`[lens] API listening on http://${config.api.host}:${config.api.port}`)
  console.log(`[lens] GraphiQL at http://localhost:${config.api.port}/graphiql`)

  // ── Aggregate refresh worker ──────────────────────────────────────────────
  const queue = createAggregateQueue()
  startAggregateWorker()
  await scheduleAggregateRefresh(queue)
  console.log('[lens] Aggregate refresh worker started')

  // ── Ingesters (run in background — infinite loops) ────────────────────────
  console.log('[lens] Starting ingesters...')
  startSDEXIngester().catch(err => {
    console.error('[lens] SDEX ingester crashed:', err)
    process.exit(1)
  })
  startAMMIngester().catch(err => {
    console.error('[lens] AMM ingester crashed:', err)
    process.exit(1)
  })

  console.log(`[lens] Watching ${config.pairs.length} pairs: ${config.pairs.map(p => p.pairKey).join(', ')}`)
}

main().catch(err => {
  console.error('[lens] Fatal startup error:', err)
  process.exit(1)
})
