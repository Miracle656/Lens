import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

import { registerVolumeRoutes } from '../routes/volumes'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerVolumeRoutes(app)
  await app.ready()
  return app
}

describe('GET /volumes/:asset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the cross-venue sum and a per-venue breakdown', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { source: 'SDEX', volume: '100.5', trade_count: 3 },
        { source: 'AMM', volume: '49.5', trade_count: 2 },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/volumes/XLM?window=24h' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.asset).toBe('XLM')
    expect(body.window).toBe('24h')
    expect(body.byVenue).toEqual({ SDEX: 100.5, AMM: 49.5 })
    expect(body.totalVolume).toBeCloseTo(150)
    expect(body.venues.sort()).toEqual(['AMM', 'SDEX'])
    expect(body.tradeCount).toBe(5)
    await app.close()
  })

  it('defaults to the 24h window', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/volumes/XLM' })
    expect(res.statusCode).toBe(200)
    expect(res.json().window).toBe('24h')
    await app.close()
  })

  it.each(['24h', '7d', '30d'])('supports the %s window', async (window) => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: `/volumes/XLM?window=${window}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().window).toBe(window)
    // The query receives the asset and a Date cutoff.
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['XLM', expect.any(Date)])
    await app.close()
  })

  it('uses a wider lookback for longer windows', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()

    await app.inject({ method: 'GET', url: '/volumes/XLM?window=24h' })
    const start24h = (mockQuery.mock.calls[0][1] as [string, Date])[1].getTime()
    mockQuery.mockClear()
    await app.inject({ method: 'GET', url: '/volumes/XLM?window=30d' })
    const start30d = (mockQuery.mock.calls[0][1] as [string, Date])[1].getTime()

    expect(start30d).toBeLessThan(start24h)
    await app.close()
  })

  it('rejects an invalid window with 400', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/volumes/XLM?window=12h' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/window must be one of/)
    await app.close()
  })

  it('returns zero volume when there are no trades', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/volumes/XLM?window=7d' })
    const body = res.json()
    expect(body.totalVolume).toBe(0)
    expect(body.byVenue).toEqual({})
    expect(body.tradeCount).toBe(0)
    await app.close()
  })

  it('returns 500 when the query fails', async () => {
    mockQuery.mockRejectedValue(new Error('db down'))
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/volumes/XLM?window=24h' })
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toMatch(/Volume aggregation failed/)
    await app.close()
  })
})
