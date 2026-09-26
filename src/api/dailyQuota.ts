import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import type Redis from 'ioredis'
import { redis } from '../redis'
import { api_key_daily_quota_events_total } from '../metrics'

/**
 * Per-key **daily** quota enforcement (issue #175).
 *
 * `ratePerDay` was stored on every API key (column default 10000), settable via
 * `POST /admin/keys` and `scripts/issue-api-key.ts`, returned by the admin
 * response and loaded onto `req.apiKey` — but only `ratePerMin` was ever read by
 * the rate limiter. A key issued with `--per-day 100` still got 60 requests a
 * minute, roughly 86,400 a day. This module closes that gap.
 *
 * The counter lives in Redis, keyed by the UTC day, which is what makes it:
 *
 *   - **restart-safe** — the count is not in process memory, so a redeploy does
 *     not hand every key a fresh allowance (the in-memory per-minute limiter
 *     cannot offer this, and does not need to); and
 *   - **boundary-resetting** — a new UTC day is a new key, so the counter starts
 *     at zero at midnight for free. The TTL is only there to reclaim old keys.
 *
 * ## Redis unavailable: fail **open**, loudly
 *
 * The bazaar catalog-write limiter (`src/bazaar/rateLimit.ts`) fails **closed**
 * because it guards a trust boundary where the payment is unaffected either
 * way. This quota is deliberately the opposite. Lens treats Redis as a cache and
 * a job broker, not a source of truth (`src/redis.ts`), and the recent outage
 * work exists precisely so that a dead cache does not become a dead API.
 * Failing this quota closed would answer 429 to every authenticated request for
 * as long as Redis is down — including requests far inside their allowance —
 * turning a cache outage into a full API outage.
 *
 * So when Redis cannot be reached the request is allowed through, the
 * per-minute limiter (in-process, so it keeps working during the outage) still
 * applies, and the degradation is made **non-silent**: every affected request
 * logs an error and increments
 * `api_key_daily_quota_events_total{outcome="unavailable"}`. The residual risk —
 * a key can exceed its daily quota during a Redis outage — is the deliberate
 * trade for availability, and is documented in `docs/api-key-quotas.md`.
 */

/** Matches the `ApiKey.ratePerDay` column default, used if a key carries no usable limit. */
const DEFAULT_DAILY_LIMIT = 10_000

/**
 * Day bucket, e.g. `2026-09-26`. Part of the counter key, so the day boundary is
 * a different key rather than an eviction — the counter resets exactly at UTC
 * midnight.
 */
export function utcDayKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
}

/** Redis key holding one API key's request count for the current UTC day. */
export function dailyQuotaKey(keyId: string, now: Date = new Date()): string {
  return `lens:apikey:quota:day:${utcDayKey(now)}:${keyId}`
}

/** Whole seconds until the next UTC midnight — the `retryAfter` for a key over quota. */
export function secondsUntilUtcDayBoundary(now: Date = new Date()): number {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, Math.floor((end - now.getTime()) / 1000))
}

/** Human-readable duration, in the shape `@fastify/rate-limit` uses for `context.after`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(1, Math.floor(seconds))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const secs = total % 60
  const parts: string[] = []
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`)
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`)
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`)
  if (secs && parts.length === 0) parts.push(`${secs} second${secs === 1 ? '' : 's'}`)
  return parts.join(' ')
}

/**
 * Normalizes a limit from the key context.
 *
 * A finite value is taken literally (so an explicit `0` means "no requests
 * today", not "unlimited"). A missing/non-finite value falls back to the column
 * default rather than being compared as `NaN` — `count <= NaN` is always false,
 * which would block every request for such a key.
 */
function normalizeLimit(limit: number): number {
  if (typeof limit === 'number' && Number.isFinite(limit)) return Math.max(0, Math.floor(limit))
  return DEFAULT_DAILY_LIMIT
}

export interface DailyQuotaDecision {
  /** Whether the request is within the key's daily allowance. */
  allowed: boolean
  /** Requests left in the current day window (never negative). */
  remaining: number
  /** Seconds until the counter resets at the next UTC-day boundary. */
  retryAfterSeconds: number
  /** True when Redis was unreachable and the request was waved through (fail-open). */
  unavailable: boolean
}

/**
 * Counts one request against a key's daily quota and reports whether it is
 * allowed.
 *
 * The counter is incremented **before** the decision — the same order the
 * bazaar limiter uses — so a key that is already over its quota cannot buy
 * itself a reset by hammering the endpoint; every attempt costs a slot.
 *
 * `now` is injectable so the day boundary can be tested deterministically.
 */
export async function consumeDailyQuota(
  keyId: string,
  limit: number,
  now: Date = new Date(),
): Promise<DailyQuotaDecision> {
  const retryAfterSeconds = secondsUntilUtcDayBoundary(now)
  const key = dailyQuotaKey(keyId, now)
  const max = normalizeLimit(limit)
  const db = redis as unknown as Redis

  try {
    const results = await db.multi().incr(key).expire(key, retryAfterSeconds).exec()

    // A null reply means the transaction never ran (the connection dropped
    // mid-flight). Treat it exactly like a thrown error: fail open.
    if (!results) {
      return { allowed: true, remaining: 0, retryAfterSeconds, unavailable: true }
    }

    const count = Number(results[0]?.[1] ?? 0)
    return {
      allowed: count <= max,
      remaining: Math.max(0, max - count),
      retryAfterSeconds,
      unavailable: false,
    }
  } catch {
    return { allowed: true, remaining: 0, retryAfterSeconds, unavailable: true }
  }
}

/**
 * Fastify plugin that enforces each authenticated key's `ratePerDay`.
 *
 * Register it **after** the API-key auth hook (so `req.apiKey` is populated) and
 * **after** `@fastify/rate-limit` (so the per-minute window is evaluated first,
 * unchanged). Public routes and requests without a key (auth disabled) are
 * skipped — there is no per-key allowance to spend.
 */
async function dailyQuotaPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const routeConfig = (req.routeOptions?.config ?? {}) as { public?: boolean }
    if (routeConfig.public) return

    const apiKey = req.apiKey
    if (!apiKey) return

    const decision = await consumeDailyQuota(apiKey.id, apiKey.ratePerDay)

    if (decision.unavailable) {
      // Fail open, but never silently: a quota that has stopped being enforced
      // must be visible in the logs and the metrics, not merely absent.
      req.log.error(
        { keyId: apiKey.id },
        '[quota] Redis unavailable — daily quota not enforced for this request (fail-open)',
      )
      api_key_daily_quota_events_total.inc({ outcome: 'unavailable' })
      return
    }

    if (!decision.allowed) {
      api_key_daily_quota_events_total.inc({ outcome: 'exceeded' })
      const retryAfter = formatDuration(decision.retryAfterSeconds)
      // Same shape as the per-minute limiter's 429, with retryAfter pointing at
      // the next day boundary instead of the next minute.
      reply.header('retry-after', String(decision.retryAfterSeconds))
      return reply.status(429).send({
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Daily rate limit exceeded, retry in ${retryAfter}`,
        retryAfter,
      })
    }
  })
}

export const registerDailyQuota = fp(dailyQuotaPlugin, { name: 'api-key-daily-quota' })
