import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

import { computeTWAP, computeVWAP } from '../pricing/twap'

describe('TWAP Computation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns zero TWAP when no price points exist', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const result = await computeTWAP('XLM/USDC', 60)
    expect(result.twap).toBe(0)
    expect(result.sampleCount).toBe(0)
    expect(result.outlierRejected).toBe(0)
  })

  it('computes TWAP from several price points', async () => {
    const now = Date.now()
    const oneMinMs = 60_000
    mockQuery.mockResolvedValue({
      rows: [
        { price: '100', timestamp: new Date(now - 4 * oneMinMs) },
        { price: '101', timestamp: new Date(now - 3 * oneMinMs) },
        { price: '102', timestamp: new Date(now - 2 * oneMinMs) },
        { price: '103', timestamp: new Date(now - 1 * oneMinMs) },
        { price: '104', timestamp: new Date(now) },
      ],
    })

    const result = await computeTWAP('XLM/USDC', 10, { sampleIntervalSeconds: 60 })
    expect(result.sampleCount).toBe(5)
    expect(result.twap).toBeGreaterThan(0)
    expect(result.outlierRejected).toBe(0)
    // TWAP should be between min and max
    expect(result.twap).toBeGreaterThan(99)
    expect(result.twap).toBeLessThan(105)
  })

  it('rejects a single extreme outlier with IQR', async () => {
    const now = Date.now()
    const oneMinMs = 60_000
    // 10 normal prices around 100, 1 extreme at 1000
    const rows = Array.from({ length: 10 }, (_, i) => ({
      price: String(98 + Math.random() * 4),
      timestamp: new Date(now - (10 - i) * oneMinMs),
    }))
    rows.push({ price: '1000', timestamp: new Date(now) })

    mockQuery.mockResolvedValue({ rows })

    const result = await computeTWAP('XLM/USDC', 60, {
      sampleIntervalSeconds: 30,
      outlierMethod: 'iqr',
    })
    expect(result.sampleCount).toBe(11)
    expect(result.outlierRejected).toBeGreaterThanOrEqual(1)
    // TWAP should be close to 100, not ~180
    expect(result.twap).toBeLessThan(200)
    expect(result.twap).toBeGreaterThan(90)
  })

  it('rejects multiple outliers with modified Z-score', async () => {
    const now = Date.now()
    const oneMinMs = 60_000
    // Normal prices around 50
    const rows = Array.from({ length: 8 }, (_, i) => ({
      price: String(48 + Math.random() * 4),
      timestamp: new Date(now - (8 - i) * oneMinMs),
    }))
    // Two extreme outliers
    rows.push({ price: '500', timestamp: new Date(now - 3 * oneMinMs) })
    rows.push({ price: '2', timestamp: new Date(now - 2 * oneMinMs) })

    mockQuery.mockResolvedValue({ rows })

    const result = await computeTWAP('XLM/USDC', 60, {
      sampleIntervalSeconds: 30,
      outlierMethod: 'modified_zscore',
    })
    expect(result.sampleCount).toBe(10)
    expect(result.outlierRejected).toBeGreaterThanOrEqual(2)
    // TWAP should be close to 50
    expect(result.twap).toBeLessThan(100)
    expect(result.twap).toBeGreaterThan(40)
  })
})

describe('VWAP Computation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns zero VWAP when no price points exist', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const result = await computeVWAP('XLM/USDC', 60)
    expect(result.vwap).toBe(0)
    expect(result.sampleCount).toBe(0)
    expect(result.volumeTotal).toBe(0)
  })

  it('computes VWAP correctly from price/volume pairs', async () => {
    const now = Date.now()
    mockQuery.mockResolvedValue({
      rows: [
        { price: '100', volume: '1000', timestamp: new Date(now - 300_000) },
        { price: '102', volume: '2000', timestamp: new Date(now - 200_000) },
        { price: '98', volume: '1500', timestamp: new Date(now - 100_000) },
        { price: '101', volume: '500', timestamp: new Date(now) },
      ],
    })

    const result = await computeVWAP('XLM/USDC', 60)
    expect(result.sampleCount).toBe(4)
    expect(result.volumeTotal).toBe(5000)

    // Manual VWAP: Σ(price*volume)/Σ(volume)
    // = (100*1000 + 102*2000 + 98*1500 + 101*500) / 5000
    const expectedVWAP = (100 * 1000 + 102 * 2000 + 98 * 1500 + 101 * 500) / 5000
    expect(Math.abs(result.vwap - expectedVWAP)).toBeLessThan(0.01)
    expect(result.outlierRejected).toBe(0)
  })

  it('rejects outlier prices in VWAP computation', async () => {
    const now = Date.now()
    // 5 normal trades around 100, 1 extreme at 10000 with high volume
    const rows = Array.from({ length: 5 }, (_, i) => ({
      price: String(98 + Math.random() * 4),
      volume: String(1000),
      timestamp: new Date(now - (5 - i) * 60_000),
    }))
    rows.push({ price: '10000', volume: '50000', timestamp: new Date(now) })

    mockQuery.mockResolvedValue({ rows })

    const result = await computeVWAP('XLM/USDC', 60)
    expect(result.sampleCount).toBe(6)
    expect(result.outlierRejected).toBeGreaterThanOrEqual(1)
    // Without outlier rejection, VWAP would be heavily skewed by 10000*50000
    // With rejection, VWAP should be close to 100
    expect(result.vwap).toBeLessThan(500)
    expect(result.vwap).toBeGreaterThan(90)
  })

  it('computes VWAP filtered by source', async () => {
    const now = Date.now()
    mockQuery.mockResolvedValue({
      rows: [
        { price: '100', volume: '1000', timestamp: new Date(now - 60_000) },
        { price: '101', volume: '2000', timestamp: new Date(now) },
      ],
    })

    const result = await computeVWAP('XLM/USDC', 60, { source: 'SDEX' })
    expect(result.sampleCount).toBe(2)
    expect(result.vwap).toBeGreaterThan(0)

    // Verify the query had source filter
    const queryCall = mockQuery.mock.calls[0]
    expect(queryCall[0]).toContain('source = $3')
    expect(queryCall[1][2]).toBe('SDEX')
  })

  it('handles synthetic manipulation: pump-and-dump scenario', async () => {
    const now = Date.now()
    const oneMinMs = 60_000

    // Simulate a pump-and-dump: most trades around 100, then a rapid pump
    // to 150 and dump back to 95
    const normalTrades = Array.from({ length: 20 }, (_, i) => ({
      price: String(95 + Math.random() * 10), // 95-105
      volume: String(1000 + Math.random() * 500),
      timestamp: new Date(now - (20 - i) * oneMinMs),
    }))

    const pumpTrades = [
      { price: '130', volume: '2000', timestamp: new Date(now - 3 * oneMinMs) },
      { price: '150', volume: '3000', timestamp: new Date(now - 2 * oneMinMs) },
    ]

    const dumpTrades = [
      { price: '80', volume: '5000', timestamp: new Date(now - 1 * oneMinMs) },
      { price: '95', volume: '2000', timestamp: new Date(now) },
    ]

    const allTrades = [...normalTrades, ...pumpTrades, ...dumpTrades]
    mockQuery.mockResolvedValue({ rows: allTrades })

    // TWAP with outlier rejection should be resilient
    const twapResult = await computeTWAP('XLM/USDC', 30, {
      sampleIntervalSeconds: 30,
      outlierMethod: 'iqr',
    })
    expect(twapResult.sampleCount).toBe(24) // includes all raw samples
    expect(twapResult.outlierRejected).toBeGreaterThanOrEqual(2) // pump trades rejected
    expect(twapResult.twap).toBeGreaterThan(90)
    expect(twapResult.twap).toBeLessThan(115) // not skewed by pump to 150

    // VWAP with outlier rejection should also be resilient
    const vwapResult = await computeVWAP('XLM/USDC', 30, { outlierMethod: 'iqr' })
    expect(vwapResult.sampleCount).toBe(24)
    expect(vwapResult.outlierRejected).toBeGreaterThanOrEqual(1)
    expect(vwapResult.vwap).toBeGreaterThan(90)
    expect(vwapResult.vwap).toBeLessThan(120)
  })
})