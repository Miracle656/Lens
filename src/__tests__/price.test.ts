import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery, mockGetCachedPrice, mockGetBestRoute } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetCachedPrice: vi.fn(),
  mockGetBestRoute: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../redis', () => ({
  getCachedPrice: mockGetCachedPrice,
  setCachedPrice: vi.fn(),
}))

vi.mock('../aggregator/bestRoute', () => ({
  getBestRoute: mockGetBestRoute,
}))

vi.mock('../config', () => ({
  config: {
    pairs: [
      { 
        pairKey: 'USDC/XLM', 
        assetA: { code: 'XLM', issuer: null }, 
        assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' } 
      },
    ],
    cache: { priceTtl: 10 },
  },
}))

import { registerRESTRoutes } from '../api/rest'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerRESTRoutes(app)
  await app.ready()
  return app
}

describe('GET /price/:assetA/:assetB confidence score', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCachedPrice.mockResolvedValue(null)
    mockGetBestRoute.mockResolvedValue({ route: 'SDEX' })
  })

  it('returns high confidence for recent trades with multiple sources', async () => {
    const now = new Date()
    const recent = new Date(now.getTime() - 10000).toISOString() // 10s ago

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('AVG(spot_price::numeric)')) return { rows: [{ amm_price: '0.1' }] }
      if (sql.includes('MAX(timestamp) as last_trade')) return { rows: [{ last_trade: recent }] }
      if (sql.includes('GROUP BY source')) return { rows: [{ source: 'SDEX', vol: '100' }, { source: 'AMM', vol: '50' }] }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) return { rows: [{ sources: '2' }] }
      if (sql.includes('SUM(price::numeric * base_volume::numeric)')) return { rows: [{ vwap: '0.1' }] }
      if (sql.includes('price_24h_ago')) return { rows: [{ price_24h_ago: '0.09', price_now: '0.1' }] }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.volume24h).toBeGreaterThan(0)
    expect(body.sources).toBe(2)
    expect(body.confidence).toBe('high')
    expect(body.lastTradeAgeSeconds).toBeLessThan(30)
  })

  it('returns medium confidence for trades within 5 minutes', async () => {
    const now = new Date()
    const twoMinAgo = new Date(now.getTime() - 120000).toISOString() // 2m ago

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('AVG(spot_price::numeric)')) return { rows: [{ amm_price: '0.1' }] }
      if (sql.includes('MAX(timestamp) as last_trade')) return { rows: [{ last_trade: twoMinAgo }] }
      if (sql.includes('GROUP BY source')) return { rows: [{ source: 'SDEX', vol: '100' }] }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) return { rows: [{ sources: '1' }] }
      if (sql.includes('SUM(price::numeric * base_volume::numeric)')) return { rows: [{ vwap: '0.1' }] }
      if (sql.includes('price_24h_ago')) return { rows: [{ price_24h_ago: '0.09', price_now: '0.1' }] }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.confidence).toBe('medium')
  })

  it('returns low confidence for old trades', async () => {
    const now = new Date()
    const tenMinAgo = new Date(now.getTime() - 600000).toISOString() // 10m ago

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('MAX(timestamp) as last_trade')) return { rows: [{ last_trade: tenMinAgo }] }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) return { rows: [{ sources: '1' }] }
      if (sql.includes('GROUP BY source')) return { rows: [{ source: 'SDEX', vol: '100' }] }
      if (sql.includes('SUM(price::numeric * base_volume::numeric)')) return { rows: [{ vwap: '0.1' }] }
      if (sql.includes('price_24h_ago')) return { rows: [{ price_24h_ago: '0.09', price_now: '0.1' }] }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.confidence).toBe('low')
  })

  it('returns unknown confidence when no trades found', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('MAX(timestamp) as last_trade')) return { rows: [{ last_trade: null }] }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.confidence).toBe('unknown')
    expect(body.lastTradeAgeSeconds).toBeNull()
  })
})
