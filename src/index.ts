import 'dotenv/config'
import { execSync } from 'child_process'
import Fastify from 'fastify'

if (!process.env.DIRECT_DATABASE_URL && process.env.DATABASE_URL) {
  process.env.DIRECT_DATABASE_URL = process.env.DATABASE_URL
}
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
import { registerScreenerRoutes } from './routes/screener'
import { registerX402 } from './middleware/x402'
import { registerWebSocket } from './api/websocket'
import { registerApiKeyAuth } from './api/auth'
import { registerAdminRoutes } from './api/admin'

import { startSDEXIngester } from './ingesters/sdex'
import { startAMMIngester } from './ingesters/amm'
import { startSoroswapIngester } from './ingesters/soroswap'
import { createAggregateQueue, startAggregateWorker, scheduleAggregateRefresh } from './jobs/aggregateRefresh'
import { loadPersistedPairs, getActivePairs } from './pairsRegistry'
import { getMetrics } from './metrics'

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

  // API-key authentication — validates Authorization: Bearer <key> and attaches
  // per-key quota metadata to req.apiKey. Registered BEFORE the rate limiter so
  // that req.apiKey is populated when the limiter evaluates its per-key quota
  // (both run in the onRequest phase, in registration order). Disabled when
  // REQUIRE_API_KEY=false. Routes marked `config.public` bypass auth.
  if (process.env.REQUIRE_API_KEY !== 'false') {
    await app.register(registerApiKeyAuth)
  } else {
    app.log.warn('[auth] REQUIRE_API_KEY=false — API key authentication disabled')
  }

  // Per-key rate quotas: the limit is derived from the authenticated key's
  // metadata (req.apiKey, set by the auth hook above). Unauthenticated/public
  // requests fall back to a conservative shared limit keyed by IP.
  await app.register(rateLimit, {
    max: (req) => req.apiKey?.ratePerMin ?? 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.apiKey?.id ?? req.ip,
    allowList: (req) => req.url === '/status',
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

  // Admin endpoints (key issuance/revocation) — gated by ADMIN_TOKEN. Marked
  // `config.public` so the API-key auth hook skips them.
  await registerAdminRoutes(app)

  await app.register(registerX402)
  await registerRESTRoutes(app)
  await registerWebhookRoutes(app)
  await registerCandleRoutes(app)
  await registerPairsRoutes(app)
  await registerScreenerRoutes(app)
  await registerGraphQL(app)
  await registerWebSocket(app)

  // Prometheus metrics endpoint (un-gated, public — no API key required)
  app.get('/metrics', { config: { public: true } }, async (req, reply) => {
    reply.type('text/plain; version=0.0.4; charset=utf-8')
    return await getMetrics()
  })

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
  // Each ingester is independently fault-isolated via restartIngester.
  // A crash in the Soroswap ingester cannot take down SDEX or AMM.
  console.log('[lens] Starting ingesters...')
  const restartIngester = (name: string, fn: () => Promise<void>) => {
    fn().catch(err => {
      console.error(`[lens] ${name} ingester crashed, restarting in 10s:`, err.message)
      setTimeout(() => restartIngester(name, fn), 10_000)
    })
  }
  restartIngester('SDEX', startSDEXIngester)
  restartIngester('AMM', startAMMIngester)
  restartIngester('Soroswap', startSoroswapIngester)

  console.log(`[lens] Watching ${getActivePairs().length} pairs: ${getActivePairs().map(p => p.pairKey).join(', ')}`)
}

main().catch(err => {
  console.error('[lens] Fatal startup error:', err)
  process.exit(1)
})
