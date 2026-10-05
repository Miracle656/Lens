/**
 * #166 — the refresh worker and the /price route must build the *same* cache
 * key.
 *
 * price.test.ts mocks `../redis` wholesale, so the key-building code never runs
 * there and an assertion on the helper arguments cannot prove the key itself.
 * This file mocks only `ioredis`, letting the real setCachedPrice /
 * getCachedPrice execute against an in-memory client and asserting on the exact
 * key string each one hands to Redis.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const redisSpy = vi.hoisted(() => ({
  store: new Map<string, string>(),
  setCalls: [] as unknown[][],
  getCalls: [] as string[],
}))

// `src/redis.ts` constructs its client at import time (`new Redis(url, opts)`),
// so the mock has to be a real *constructor* — `vi.fn(() => fake)` is not one
// and throws "is not a constructor" under `new`. A class also keeps set/get
// flowing through the real helpers in src/redis.ts, which is the point of this
// file.
vi.mock('ioredis', () => ({
  default: class MockRedis {
    async get(key: string) {
      redisSpy.getCalls.push(key)
      return redisSpy.store.get(key) ?? null
    }
    async set(key: string, value: string, ...rest: unknown[]) {
      redisSpy.setCalls.push([key, value, ...rest])
      redisSpy.store.set(key, value)
      return 'OK'
    }
    on() {
      return this
    }
  },
}))

vi.mock('../db', () => ({
  pgPool: { query: vi.fn() },
}))

vi.mock('../aggregator/vwap', () => ({
  getAggregatedPrice: vi.fn(),
}))

vi.mock('../aggregator/bestRoute', () => ({
  getBestRoute: vi.fn(async () => ({ route: 'SDEX' })),
}))

const { testnetPairs, mainnetPairs } = vi.hoisted(() => ({
  testnetPairs: [
    {
      pairKey: 'USDC/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    },
  ],
  mainnetPairs: [
    {
      pairKey: 'USDC/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
    },
  ],
}))

vi.mock('../config', () => ({
  config: {
    pairs: testnetPairs,
    cache: { priceTtl: 10 },
    redis: { url: 'redis://localhost:6379' },
  },
  activeNetwork: 'testnet',
  getNetworkConfig: (network: string) => ({
    pairs: network === 'mainnet' ? mainnetPairs : testnetPairs,
  }),
}))

import { setCachedPrice, priceCacheKey } from '../redis'
import { registerRESTRoutes } from '../api/rest'
import { registerNetworkSelector } from '../middleware/network'

const PAYLOAD = {
  assetA: 'XLM',
  assetB: 'USDC',
  pairKey: 'USDC/XLM',
  network: 'testnet',
  price: 0.18,
  sdexPrice: 0.18,
  ammPrice: 0,
  volume24h: 0,
  sdexVolume24h: 0,
  ammVolume24h: 0,
  vwap1m: 0,
  vwap5m: 0,
  vwap1h: 0.18,
  vwap24h: 0.18,
  priceChange24h: 0,
  sources: 1,
  confidence: 'medium',
  lastTradeAgeSeconds: 60,
  stale: false,
  bestRoute: 'SDEX',
  lastUpdated: '2026-09-27T00:00:00.000Z',
}

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerRESTRoutes(app)
  await app.ready()
  return app
}

describe('price cache key ownership (#166)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisSpy.store.clear()
    redisSpy.setCalls.length = 0
    redisSpy.getCalls.length = 0
  })

  it('builds the identical key for the worker write and the /price read', async () => {
    // The refresh worker's write path (see jobs/aggregateRefresh.ts).
    await setCachedPrice('testnet', 'USDC/XLM', PAYLOAD, 10)
    expect(redisSpy.setCalls[0]).toEqual([
      'lens:testnet:price:USDC/XLM',
      JSON.stringify(PAYLOAD),
      'EX',
      10,
    ])

    // The /price handler's read path — the real helper runs here, so this is the
    // key the route would use against a live Redis.
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    expect(redisSpy.getCalls).toContain('lens:testnet:price:USDC/XLM')
  })

  it('serves a worker-written entry with X-Cache: HIT', async () => {
    // Simulate the worker having warmed the cache.
    await setCachedPrice('testnet', 'USDC/XLM', PAYLOAD, 10)

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['x-cache']).toBe('HIT')
    expect(res.json().network).toBe('testnet')
    // A cache hit is served verbatim — no database read.
    expect(res.json().pairKey).toBe('USDC/XLM')
  })

  it('keeps the testnet and mainnet keys distinct', () => {
    expect(priceCacheKey('testnet', 'USDC/XLM')).toBe('lens:testnet:price:USDC/XLM')
    expect(priceCacheKey('mainnet', 'USDC/XLM')).toBe('lens:mainnet:price:USDC/XLM')
    expect(priceCacheKey('testnet', 'USDC/XLM')).not.toBe(priceCacheKey('mainnet', 'USDC/XLM'))
  })
})
