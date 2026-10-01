import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'

// ── Controllable Redis double ─────────────────────────────────────────────────
// The daily counter is a MULTI of INCR + EXPIRE. This mock records the commands
// and, by default, applies them to an in-memory map, so the plugin sees the same
// read-your-writes behaviour a real Redis would give it. Tests can override
// `state.exec` to simulate an outage (rejection) or a dropped transaction (null).
const { state } = vi.hoisted(() => ({
  state: {
    counts: new Map<string, number>(),
    exec: undefined as ((ops: Array<{ op: string; key: string }>) => Promise<unknown>) | undefined,
  },
}))

vi.mock('../redis', () => ({
  redis: {
    multi: () => {
      const ops: Array<{ op: string; key: string; value?: number }> = []
      const chain: Record<string, unknown> = {}
      chain.incr = (key: string) => { ops.push({ op: 'incr', key }); return chain }
      chain.expire = (key: string, value: number) => { ops.push({ op: 'expire', key, value }); return chain }
      chain.exec = () => {
        if (state.exec) return state.exec(ops)
        const results: Array<[null, number]> = []
        for (const op of ops) {
          if (op.op === 'incr') {
            const next = (state.counts.get(op.key) ?? 0) + 1
            state.counts.set(op.key, next)
            results.push([null, next])
          } else {
            results.push([null, 1])
          }
        }
        return Promise.resolve(results)
      }
      return chain
    },
  },
}))

vi.mock('../db', () => ({
  prisma: { apiKey: { findUnique: vi.fn() } },
}))

import { prisma } from '../db'
import { registerApiKeyAuth } from '../api/auth'
import {
  registerDailyQuota,
  consumeDailyQuota,
  dailyQuotaKey,
  utcDayKey,
  secondsUntilUtcDayBoundary,
  formatDuration,
} from '../api/dailyQuota'

const mockFindUnique = prisma.apiKey.findUnique as unknown as ReturnType<typeof vi.fn>

/** The key every authenticated request resolves to, unless a test overrides it. */
function keyWith(overrides: Record<string, unknown> = {}) {
  return { id: 'key-1', label: 'acme', ratePerMin: 1000, ratePerDay: 1000, revokedAt: null, ...overrides }
}

interface LogSink { write: (chunk: string) => void }

/**
 * Builds an app wired like production: auth, then the per-minute limiter, then
 * the daily quota — the same order src/index.ts uses.
 */
async function buildApp(sink?: LogSink) {
  const app = sink
    ? Fastify({ logger: { level: 'error', stream: sink } })
    : Fastify()
  await app.register(registerApiKeyAuth)
  await app.register(rateLimit, {
    max: (req) => req.apiKey?.ratePerMin ?? 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.apiKey?.id ?? req.ip,
    errorResponseBuilder: (req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded, retry in ${context.after}`,
      retryAfter: context.after,
    }),
  })
  await app.register(registerDailyQuota)
  app.get('/price/test', async () => ({ ok: true }))
  app.get('/status', { config: { public: true } }, async () => ({ ok: true }))
  await app.ready()
  return app
}

beforeEach(() => {
  state.counts = new Map()
  state.exec = undefined
  mockFindUnique.mockReset()
  mockFindUnique.mockResolvedValue(keyWith())
})

describe('day-boundary helpers', () => {
  it('names the counter by UTC day, so the boundary is a new key', () => {
    expect(utcDayKey(new Date('2026-09-26T23:59:59.999Z'))).toBe('2026-09-26')
    expect(utcDayKey(new Date('2026-09-27T00:00:00.000Z'))).toBe('2026-09-27')
    expect(dailyQuotaKey('key-1', new Date('2026-09-26T12:00:00.000Z')))
      .toBe('lens:apikey:quota:day:2026-09-26:key-1')
  })

  it('reports the seconds remaining until the next UTC midnight', () => {
    expect(secondsUntilUtcDayBoundary(new Date('2026-09-26T00:00:00.000Z'))).toBe(86_400)
    expect(secondsUntilUtcDayBoundary(new Date('2026-09-26T23:00:00.000Z'))).toBe(3_600)
    expect(secondsUntilUtcDayBoundary(new Date('2026-09-26T23:59:59.999Z'))).toBe(1)
  })

  it('formats durations the way the 429 body needs them', () => {
    expect(formatDuration(3_600)).toBe('1 hour')
    expect(formatDuration(86_400)).toBe('1 day')
    expect(formatDuration(45)).toBe('45 seconds')
    expect(formatDuration(3_661)).toBe('1 hour 1 minute')
    expect(formatDuration(0)).toBe('1 second')
  })
})

describe('consumeDailyQuota', () => {
  const now = new Date('2026-09-26T12:00:00.000Z')

  it('allows requests while the key is under its daily limit', async () => {
    const first = await consumeDailyQuota('key-1', 3, now)
    expect(first).toMatchObject({ allowed: true, remaining: 2, unavailable: false })

    const second = await consumeDailyQuota('key-1', 3, now)
    expect(second).toMatchObject({ allowed: true, remaining: 1, unavailable: false })

    const third = await consumeDailyQuota('key-1', 3, now)
    expect(third).toMatchObject({ allowed: true, remaining: 0, unavailable: false })
  })

  it('rejects once the key is over its daily limit, and keeps counting rejects', async () => {
    await consumeDailyQuota('key-1', 2, now)
    await consumeDailyQuota('key-1', 2, now)

    const over = await consumeDailyQuota('key-1', 2, now)
    expect(over.allowed).toBe(false)
    expect(over.remaining).toBe(0)

    // The attempt was counted, so shouting at the endpoint cannot buy a reset.
    const again = await consumeDailyQuota('key-1', 2, now)
    expect(again.allowed).toBe(false)
  })

  it('resets the counter at the UTC day boundary', async () => {
    const before = new Date('2026-09-26T23:59:00.000Z')
    const after = new Date('2026-09-27T00:01:00.000Z')

    expect((await consumeDailyQuota('key-1', 1, before)).allowed).toBe(true)
    expect((await consumeDailyQuota('key-1', 1, before)).allowed).toBe(false)

    // New day, new key, fresh allowance.
    const fresh = await consumeDailyQuota('key-1', 1, after)
    expect(fresh).toMatchObject({ allowed: true, remaining: 0, unavailable: false })
  })

  it('points retryAfterSeconds at the next UTC day boundary', async () => {
    const decision = await consumeDailyQuota('key-1', 1, new Date('2026-09-26T23:00:00.000Z'))
    expect(decision.retryAfterSeconds).toBe(3_600)
  })

  it('tracks each key separately', async () => {
    expect((await consumeDailyQuota('key-a', 1, now)).allowed).toBe(true)
    expect((await consumeDailyQuota('key-a', 1, now)).allowed).toBe(false)
    expect((await consumeDailyQuota('key-b', 1, now)).allowed).toBe(true)
  })

  it('fails open (and reports it) when Redis rejects', async () => {
    state.exec = () => Promise.reject(new Error('ECONNREFUSED'))

    const decision = await consumeDailyQuota('key-1', 1, now)
    expect(decision.allowed).toBe(true)
    expect(decision.unavailable).toBe(true)
  })

  it('fails open when the transaction returns no result', async () => {
    state.exec = async () => null

    const decision = await consumeDailyQuota('key-1', 1, now)
    expect(decision.allowed).toBe(true)
    expect(decision.unavailable).toBe(true)
  })

  it('falls back to the column default for a non-finite limit instead of blocking every request', async () => {
    const decision = await consumeDailyQuota('key-1', undefined as unknown as number, now)
    expect(decision.allowed).toBe(true)
    expect(decision.remaining).toBe(9_999)
  })
})

describe('daily quota plugin', () => {
  const headers = { authorization: 'Bearer good' }

  // The first Fastify app built and served in a process pays a one-time
  // module/route-compile cost (seconds on a cold Windows checkout). Warm it up
  // once so that cost is not charged to whichever integration test runs first.
  beforeAll(async () => {
    const warmup = await buildApp()
    await warmup.inject({ method: 'GET', url: '/status' })
    await warmup.close()
  }, 30_000)

  it('lets requests under the daily limit through', async () => {
    mockFindUnique.mockResolvedValue(keyWith({ ratePerDay: 3, ratePerMin: 1000 }))
    const app = await buildApp()

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/price/test', headers })
      expect(res.statusCode).toBe(200)
    }
    await app.close()
  })

  it('returns 429 with a retryAfter pointing at the next day boundary once the limit is exceeded', async () => {
    mockFindUnique.mockResolvedValue(keyWith({ ratePerDay: 2, ratePerMin: 1000 }))
    const app = await buildApp()

    expect((await app.inject({ method: 'GET', url: '/price/test', headers })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/price/test', headers })).statusCode).toBe(200)

    const over = await app.inject({ method: 'GET', url: '/price/test', headers })
    expect(over.statusCode).toBe(429)

    const body = over.json()
    // Same error shape as the per-minute limiter, different window.
    expect(body.statusCode).toBe(429)
    expect(body.error).toBe('Too Many Requests')
    expect(body.message).toMatch(/^Daily rate limit exceeded, retry in /)

    // retryAfter points at the next UTC midnight, not the next minute.
    const header = Number(over.headers['retry-after'])
    expect(header).toBeGreaterThan(0)
    expect(header).toBeLessThanOrEqual(86_400)
    expect(Math.abs(header - secondsUntilUtcDayBoundary())).toBeLessThanOrEqual(2)
    expect(body.retryAfter).toBe(formatDuration(header))

    await app.close()
  })

  it('keeps the per-minute limit working unchanged', async () => {
    // Generous daily allowance: the minute window must still be the one to trip.
    mockFindUnique.mockResolvedValue(keyWith({ ratePerMin: 2, ratePerDay: 1000 }))
    const app = await buildApp()

    expect((await app.inject({ method: 'GET', url: '/price/test', headers })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/price/test', headers })).statusCode).toBe(200)

    const over = await app.inject({ method: 'GET', url: '/price/test', headers })
    expect(over.statusCode).toBe(429)
    expect(over.json().message).toMatch(/^Rate limit exceeded, retry in /)
    expect(over.json().message).not.toMatch(/Daily/)

    await app.close()
  })

  it('survives a process restart because the counter lives in Redis', async () => {
    mockFindUnique.mockResolvedValue(keyWith({ ratePerDay: 2, ratePerMin: 1000 }))

    // "Process one": spends the whole allowance, then goes away.
    const first = await buildApp()
    await first.inject({ method: 'GET', url: '/price/test', headers })
    await first.inject({ method: 'GET', url: '/price/test', headers })
    await first.close()

    // "Process two": a brand-new app instance, same Redis counter.
    const second = await buildApp()
    const afterRestart = await second.inject({ method: 'GET', url: '/price/test', headers })
    expect(afterRestart.statusCode).toBe(429)

    await second.close()
  })

  it('skips public routes: no key, no daily spend', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/status' })
    expect(res.statusCode).toBe(200)
    expect(mockFindUnique).not.toHaveBeenCalled()
    expect(state.counts.size).toBe(0)

    await app.close()
  })

  it('fails open and logs loudly when Redis is unavailable', async () => {
    const lines: string[] = []
    const sink = { write: (chunk: string) => { lines.push(chunk) } }
    state.exec = () => Promise.reject(new Error('ECONNREFUSED'))
    mockFindUnique.mockResolvedValue(keyWith({ ratePerDay: 1, ratePerMin: 1000 }))

    const app = await buildApp(sink)

    // The key's limit is 1, but the quota cannot be read — requests go through.
    const r1 = await app.inject({ method: 'GET', url: '/price/test', headers })
    const r2 = await app.inject({ method: 'GET', url: '/price/test', headers })
    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)

    expect(lines.join('')).toContain('daily quota not enforced')

    await app.close()
  })
})
