import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { redis } from '../redis'

/**
 * Per-API-key **daily** quota enforcement (#175).
 *
 * `ApiKey.ratePerDay` was stored, returned by `POST /admin/keys`, and loaded
 * into `req.apiKey` — but nothing ever read it. The global `@fastify/rate-limit`
 * registration only enforced `ratePerMin` over a one-minute window, so a key
 * issued with `--per-day 100` could still make ~86,400 requests a day.
 *
 * This plugin closes that gap using a counter in Redis rather than process
 * memory:
 *
 *     lens:api-key:quota:day:<UTC yyyy-mm-dd>:<keyId>
 *
 * so the count survives an API process restart and is shared across instances.
 * The key is day-scoped, so the counter resets at the next UTC midnight even if
 * the TTL never fires; a TTL until midnight is set as belt-and-braces cleanup.
 *
 * Ordering: register this AFTER `@fastify/rate-limit`. Both use the `onRequest`
 * phase and hooks run in registration order, so a request the per-minute limiter
 * already rejected never consumes a daily slot — the daily budget is spent only
 * on requests that got past the minute window.
 *
 * Failure mode: **fail closed**. If Redis is unreachable we cannot prove the key
 * is under its daily limit, and silently allowing the traffic is exactly the bug
 * this fixes, so the request is refused with 503 and the failure is logged. This
 * mirrors the Bazaar catalog-write limiter (`src/bazaar/rateLimit.ts`), which
 * also fails closed at a trust boundary. Deliberate trade-off: a Redis outage
 * tightens the API for keyed callers rather than letting quotas be exceeded
 * unnoticed.
 */

/** Minimal slice of an ioredis client that the daily counter needs. */
export interface DailyQuotaMulti {
  incr(key: string): DailyQuotaMulti
  expire(key: string, seconds: number): DailyQuotaMulti
  exec(): Promise<Array<[Error | null, unknown]> | null>
}

export interface DailyQuotaStore {
  multi(): DailyQuotaMulti
}

export interface DailyQuotaDecision {
  allowed: boolean
  /** The key's configured daily ceiling. */
  limit: number
  /** Count for the current UTC day after this request was counted. */
  count: number
  /** Seconds until the next UTC midnight — the reset boundary. */
  retryAfterSeconds: number
  /** True when the counter store could not be reached (fail-closed). */
  unavailable?: boolean
}

/** `yyyy-mm-dd` for the given instant in UTC. */
export function utcDayKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
}

/** Redis key holding one API key's request count for the current UTC day. */
export function apiKeyDayKey(keyId: string, now: Date): string {
  return `lens:api-key:quota:day:${utcDayKey(now)}:${keyId}`
}

/** Whole seconds until the next UTC midnight (never below 1). */
export function secondsUntilNextUtcDay(now: Date): number {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, Math.floor((end - now.getTime()) / 1000))
}

/**
 * Counts one request against the key's daily window and decides whether it is
 * within the limit. Counting happens before the decision so a rejected request
 * still costs a slot (matching the Bazaar limiter); `now` is injectable so the
 * day boundary is testable without waiting for midnight.
 */
export async function consumeDailyQuota(
  keyId: string,
  limit: number,
  store: DailyQuotaStore,
  now: Date,
): Promise<DailyQuotaDecision> {
  const retryAfterSeconds = secondsUntilNextUtcDay(now)
  const key = apiKeyDayKey(keyId, now)
  try {
    const results = await store.multi().incr(key).expire(key, retryAfterSeconds).exec()
    if (!results) {
      return { allowed: false, limit, count: 0, retryAfterSeconds, unavailable: true }
    }
    const count = Number(results[0]?.[1] ?? 0)
    return { allowed: count <= limit, limit, count, retryAfterSeconds }
  } catch {
    return { allowed: false, limit, count: 0, retryAfterSeconds, unavailable: true }
  }
}

export interface DailyQuotaPluginOptions {
  /** Counter store; defaults to the shared ioredis client. */
  store?: DailyQuotaStore
  /** Clock override for tests. */
  now?: () => Date
}

const dailyQuotaPlugin: FastifyPluginAsync<DailyQuotaPluginOptions> = async (app, opts) => {
  const store = opts.store ?? (redis as unknown as DailyQuotaStore)
  const now = opts.now ?? (() => new Date())

  app.addHook('onRequest', async (req, reply) => {
    const apiKey = req.apiKey
    if (!apiKey) return // unauthenticated / public route — no per-key quota

    const limit = apiKey.ratePerDay
    if (!Number.isFinite(limit) || limit <= 0) return // 0/absent = no daily ceiling

    const decision = await consumeDailyQuota(apiKey.id, limit, store, now())

    if (decision.allowed) return

    reply.header('Retry-After', String(decision.retryAfterSeconds))

    if (decision.unavailable) {
      req.log.error(
        { keyId: apiKey.id },
        '[daily-quota] counter store unavailable — failing closed',
      )
      return reply.status(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message:
          'Daily quota store unavailable; refusing the request rather than letting the quota be exceeded.',
        retryAfter: decision.retryAfterSeconds,
      })
    }

    return reply.status(429).send({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Daily quota exceeded (${limit}/day), retry after ${decision.retryAfterSeconds}s (next UTC midnight)`,
      retryAfter: decision.retryAfterSeconds,
    })
  })
}

export const registerDailyQuota = fp(dailyQuotaPlugin, { name: 'daily-quota' })
