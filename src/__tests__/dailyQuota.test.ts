import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'

// ── Mock Redis so importing the plugin never dials a real client ──────────────
vi.mock('../redis', () => ({
  redis: {
    multi: () => ({
      incr() { return this },
      expire() { return this },
      exec: async () => [],
    }),
  },
}))

// ── Mock Prisma (mirrors the pattern used by auth.test.ts / webhooks.test.ts) ──
vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { prisma } from '../db'
import { registerApiKeyAuth } from '../api/auth'
import {
  registerDailyQuota,
  consumeDailyQuota,
  apiKeyDayKey,
  secondsUntilNextUtcDay,
  type DailyQuotaStore,
} from '../api/dailyQuota'

const mockFindUnique = prisma.apiKey.findUnique as unknown as ReturnType<typeof vi.fn>

/**
 * In-memory stand-in for the Redis counter store. It keeps counts in a Map that
 * can be shared between two app instances, which is how the "process restart"
 * case is exercised without a real Redis.
 */
class FakeStore {
  counts = new Map<string, number>()
  ttls = new Map<string, number>()
  fail = false

  multi() {
    const counts = this.counts
    const ttls = this.ttls
    const shouldFail = () => this.fail
    const chain = {
      key: '',
      ttl: 0,
      incr(key: string) {
        this.key = key
        return this
      },
      expire(_key: string, seconds: number) {
        this.ttl = seconds
        return this
      },
      async exec() {
        if (shouldFail()) throw new Error('redis unavailable')
        const next = (counts.get(this.key) ?? 0) + 1
        counts.set(this.key, next)
        ttls.set(this.key, this.ttl)
        return [
          [null, next],
          [null, 1],
        ]
      },
    }
    return chain
  }
}

function store(): DailyQuotaStore {
  return new FakeStore() as unknown as DailyQuotaStore
}

async function buildApp(opts: { store: DailyQuotaStore; now?: () => Date }) {
  const app = Fastify()
  // Auth registers before both limiters: they run in `onRequest` and read
  // req.apiKey, which the auth hook populates.
  await app.register(registerApiKeyAuth)
  await app.register(rateLimit, {
    max: (req) => req.apiKey?.ratePerMin ?? 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.apiKey?.id ?? req.ip,
  })
  // Daily quota registers AFTER the minute limiter, exactly as src/index.ts does.
  await app.register(registerDailyQuota, { store: opts.store, now: opts.now })
  app.get('/price/test', async () => ({ ok: true }))
  await app.ready()
  return app
}

const headers = { authorization: 'Bearer test-key' }

beforeEach(() => {
  mockFindUnique.mockReset()
})

describe('daily quota helpers', () => {
  it('scopes the counter to both the key and the UTC day', () => {
    const day1 = new Date('2026-09-26T10:00:00Z')
    const day2 = new Date('2026-09-27T00:00:01Z')
    expect(apiKeyDayKey('key-1', day1)).toBe('lens:api-key:quota:day:2026-09-26:key-1')
    expect(apiKeyDayKey('key-1', day2)).toBe('lens:api-key:quota:day:2026-09-27:key-1')
  })

  it('reports seconds until the next UTC midnight', () => {
    expect(secondsUntilNextUtcDay(new Date('2026-09-26T23:59:30Z'))).toBe(30)
    expect(secondsUntilNextUtcDay(new Date('2026-09-26T00:00:00Z'))).toBe(86400)
  })

  it('fails closed when the counter store throws', async () => {
    const failing = new FakeStore()
    failing.fail = true
    const decision = await consumeDailyQuota(
      'key-1',
      5,
      failing as unknown as DailyQuotaStore,
      new Date('2026-09-26T12:00:00Z'),
    )
    expect(decision.allowed).toBe(false)
    expect(decision.unavailable).toBe(true)
  })
})

describe('per-key daily quota (#175)', () => {
  it('allows requests under the daily limit', async () => {
    mockFindUnique.mockResolvedValue({ id: 'k1', label: 'a', ratePerMin: 100, ratePerDay: 3, revokedAt: null })
    const app = await buildApp({ store: store() })

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/price/test', headers })
      expect(res.statusCode).toBe(200)
    }
  })

  it('returns 429 with retryAfter pointing at the next day boundary once exceeded', async () => {
    mockFindUnique.mockResolvedValue({ id: 'k2', label: 'a', ratePerMin: 100, ratePerDay: 2, revokedAt: null })
    const now = new Date('2026-09-26T12:00:00Z')
    const app = await buildApp({ store: store(), now: () => now })

    expect((await app.inject({ method: 'GET', url: '/price/test', headers })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/price/test', headers })).statusCode).toBe(200)

    const res = await app.inject({ method: 'GET', url: '/price/test', headers })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ statusCode: 429, error: 'Too Many Requests' })
    // 12:00 UTC -> next midnight is 12 hours out.
    expect(res.json().retryAfter).toBe(43200)
    expect(res.headers['retry-after']).toBe('43200')
  })

  it('resets the counter at the UTC day boundary', async () => {
    mockFindUnique.mockResolvedValue({ id: 'k3', label: 'a', ratePerMin: 100, ratePerDay: 1, revokedAt: null })
    let clock = new Date('2026-09-26T20:00:00Z')
    const app = await buildApp({ store: store(), now: () => clock })

    expect((await app.inject({ method: 'GET', url: '/price/test', headers })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/price/test', headers })).statusCode).toBe(429)

    clock = new Date('2026-09-27T00:00:01Z') // a new UTC day
    expect((await app.inject({ method: 'GET', url: '/price/test', headers })).statusCode).toBe(200)
  })

  it('keeps the per-minute limit working unchanged', async () => {
    mockFindUnique.mockResolvedValue({ id: 'k4', label: 'a', ratePerMin: 1, ratePerDay: 100, revokedAt: null })
    const app = await buildApp({ store: store() })

    expect((await app.inject({ method: 'GET', url: '/price/test', headers })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/price/test', headers })).statusCode).toBe(429)
  })

  it('survives an API process restart because the counter lives in the shared store', async () => {
    mockFindUnique.mockResolvedValue({ id: 'k5', label: 'a', ratePerMin: 100, ratePerDay: 1, revokedAt: null })
    const shared = store()

    const beforeRestart = await buildApp({ store: shared })
    expect((await beforeRestart.inject({ method: 'GET', url: '/price/test', headers })).statusCode).toBe(200)

    const afterRestart = await buildApp({ store: shared })
    expect((await afterRestart.inject({ method: 'GET', url: '/price/test', headers })).statusCode).toBe(429)
  })

  it('fails closed (503) when the counter store is unavailable', async () => {
    mockFindUnique.mockResolvedValue({ id: 'k6', label: 'a', ratePerMin: 100, ratePerDay: 10, revokedAt: null })
    const failing = new FakeStore()
    failing.fail = true
    const app = await buildApp({ store: failing as unknown as DailyQuotaStore })

    const res = await app.inject({ method: 'GET', url: '/price/test', headers })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ statusCode: 503, error: 'Service Unavailable' })
  })
})
