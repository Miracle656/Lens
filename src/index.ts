import 'dotenv/config'
import { execSync } from 'child_process'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import rateLimit from '@fastify/rate-limit'
import { config } from './config'
import { redis } from './redis'
import { pgPool } from './db'
import { registerRESTRoutes } from './api/rest'
import { registerGraphQL } from './api/graphql'
import { registerWebhookRoutes } from './routes/webhooks'
import { registerCandleRoutes } from './routes/candles'
import { registerPairsRoutes } from './routes/pairs'
import { registerX402 } from './middleware/x402'
import { startSDEXIngester } from './ingesters/sdex'
import { startAMMIngester } from './ingesters/amm'
import { createAggregateQueue, startAggregateWorker, scheduleAggregateRefresh } from './jobs/aggregateRefresh'
import { loadPersistedPairs, getActivePairs } from './pairsRegistry'

async function main() {
  // ── Ensure DB schema is up-to-date ────────────────────────────────────────
  console.log('[lens] Running database migrations…')
  execSync('node node_modules/prisma/build/index.js db push --accept-data-loss', { stdio: 'inherit' })
  console.log('[lens] Database ready.')

  // ── Connect dependencies ──────────────────────────────────────────────────
  await redis.connect()
  console.log('[lens] Redis connected')

  await pgPool.connect()
  console.log('[lens] PostgreSQL connected')

  // ── Load persisted runtime pairs ──────────────────────────────────────────
  await loadPersistedPairs()

  // ── Fastify API server ────────────────────────────────────────────────────
  const app = Fastify({ logger: { level: 'warn' } })
  await app.register(cors, { origin: true })
  await app.register(compress)
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/status', // Allow /status to have its own limit or be bypassed
    errorResponseBuilder: (req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded, retry in ${context.after}`,
      retryAfter: context.after
    })
  })

  // Specific limit for /status (higher for monitoring)
  app.addHook('onRoute', (routeOptions) => {
    if (routeOptions.url === '/status') {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: 1000,
          timeWindow: '1 minute'
        }
      }
    }
  })

  await app.register(registerX402)
  await registerRESTRoutes(app)
  await registerWebhookRoutes(app)
  await registerCandleRoutes(app)
  await registerPairsRoutes(app)
  await registerGraphQL(app)

  await app.listen({ port: config.api.port, host: config.api.host })
  console.log(`[lens] API listening on http://${config.api.host}:${config.api.port}`)
  console.log(`[lens] GraphiQL at http://localhost:${config.api.port}/graphiql`)

  // ── Aggregate refresh worker (non-blocking — requires Redis) ─────────────
  try {
    const queue = createAggregateQueue()
    startAggregateWorker()
    await scheduleAggregateRefresh(queue)
    console.log('[lens] Aggregate refresh worker started')
  } catch (err) {
    console.warn('[lens] Aggregate refresh worker skipped (Redis unavailable):', (err as Error).message)
  }

  // ── Ingesters (run in background — infinite loops) ────────────────────────
  console.log('[lens] Starting ingesters...')
  const restartIngester = (name: string, fn: () => Promise<void>) => {
    fn().catch(err => {
      console.error(`[lens] ${name} ingester crashed, restarting in 10s:`, err.message)
      setTimeout(() => restartIngester(name, fn), 10_000)
    })
  }
  restartIngester('SDEX', startSDEXIngester)
  restartIngester('AMM', startAMMIngester)

  console.log(`[lens] Watching ${getActivePairs().length} pairs: ${getActivePairs().map(p => p.pairKey).join(', ')}`)
}

main().catch(err => {
  console.error('[lens] Fatal startup error:', err)
  process.exit(1)
})
