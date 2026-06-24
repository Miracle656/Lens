import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getMedianPrice, type PriceSource } from './median'

describe('getMedianPrice', () => {
  const now = Date.now()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })

  // Test 1: All fresh sources → median is correct
  it('computes median correctly from all fresh sources', () => {
    const sources: PriceSource[] = [
      { id: 'src1', price: 10, timestamp: now - 5000, priority: 0 },
      { id: 'src2', price: 20, timestamp: now - 5000, priority: 1 },
      { id: 'src3', price: 30, timestamp: now - 5000, priority: 2 },
    ]

    const result = getMedianPrice(sources)

    expect(result.median).toBe(20)
    expect(result.includedSources).toEqual(['src1', 'src2', 'src3'])
    expect(result.excludedSources).toHaveLength(0)
    expect(result.fallbackEngaged).toBe(false)
  })

  // Test 2: Even number of fresh sources → median averages two middle values
  it('averages two middle values for even number of sources', () => {
    const sources: PriceSource[] = [
      { id: 'src1', price: 10, timestamp: now - 5000, priority: 0 },
      { id: 'src2', price: 20, timestamp: now - 5000, priority: 1 },
    ]

    const result = getMedianPrice(sources)

    expect(result.median).toBe(15)
    expect(result.includedSources).toEqual(['src1', 'src2'])
    expect(result.fallbackEngaged).toBe(false)
  })

  // Test 3: Stale source excluded → median computed only from fresh sources
  it('excludes stale sources from median calculation', () => {
    const sources: PriceSource[] = [
      { id: 'fresh1', price: 10, timestamp: now - 5000, priority: 0 },
      { id: 'fresh2', price: 20, timestamp: now - 5000, priority: 1 },
      { id: 'stale', price: 100, timestamp: now - 120_000, priority: 2 },
    ]

    const result = getMedianPrice(sources, { freshnessThresholdMs: 60_000 })

    expect(result.median).toBe(15)
    expect(result.includedSources).toEqual(['fresh1', 'fresh2'])
    expect(result.excludedSources).toEqual([{ id: 'stale', reason: 'stale' }])
    expect(result.fallbackEngaged).toBe(false)
  })

  // Test 4: Mix of fresh and stale → correct sources in includedSources and excludedSources
  it('correctly categorizes mixed fresh and stale sources', () => {
    const sources: PriceSource[] = [
      { id: 'fresh1', price: 50, timestamp: now - 10_000, priority: 0 },
      { id: 'fresh2', price: 60, timestamp: now - 20_000, priority: 1 },
      { id: 'stale1', price: 200, timestamp: now - 100_000, priority: 2 },
      { id: 'stale2', price: 300, timestamp: now - 150_000, priority: 3 },
    ]

    const result = getMedianPrice(sources, { freshnessThresholdMs: 60_000 })

    expect(result.median).toBe(55)
    expect(result.includedSources).toEqual(['fresh1', 'fresh2'])
    expect(result.excludedSources).toHaveLength(2)
    expect(result.excludedSources.map(s => s.id)).toEqual(['stale1', 'stale2'])
  })

  // Test 5: Too few fresh sources → fallbackChain engages, fallbackEngaged is true
  it('engages fallback chain when fresh sources below threshold', () => {
    const sources: PriceSource[] = [
      { id: 'fresh', price: 100, timestamp: now - 5000, priority: 0 },
      { id: 'fallback1', price: 200, timestamp: now - 120_000, priority: 1 },
      { id: 'fallback2', price: 250, timestamp: now - 150_000, priority: 2 },
    ]

    const result = getMedianPrice(sources, {
      freshnessThresholdMs: 60_000,
      minFreshSources: 2,
      fallbackChain: [['fallback1', 'fallback2']],
    })

    expect(result.median).toBe(225)
    expect(result.includedSources).toEqual(['fallback1', 'fallback2'])
    expect(result.fallbackEngaged).toBe(true)
  })

  // Test 6: All sources stale → fallback chain used, fallbackEngaged true
  it('uses fallback chain when all sources are stale', () => {
    const sources: PriceSource[] = [
      { id: 'stale1', price: 300, timestamp: now - 100_000, priority: 0 },
      { id: 'stale2', price: 400, timestamp: now - 150_000, priority: 1 },
    ]

    const result = getMedianPrice(sources, {
      freshnessThresholdMs: 60_000,
      minFreshSources: 1,
      fallbackChain: [['stale1', 'stale2']],
    })

    expect(result.median).toBe(350)
    expect(result.includedSources).toEqual(['stale1', 'stale2'])
    expect(result.fallbackEngaged).toBe(true)
  })

  // Test 7: Empty sources array → median is null, no crash
  it('handles empty sources array gracefully', () => {
    const result = getMedianPrice([])

    expect(result.median).toBeNull()
    expect(result.includedSources).toHaveLength(0)
    expect(result.excludedSources).toHaveLength(0)
    expect(result.fallbackEngaged).toBe(true)
  })

  // Test 8: Single fresh source with minFreshSources: 1 → works correctly
  it('works correctly with single fresh source when minFreshSources is 1', () => {
    const sources: PriceSource[] = [
      { id: 'only', price: 42, timestamp: now - 5000, priority: 0 },
    ]

    const result = getMedianPrice(sources, { minFreshSources: 1 })

    expect(result.median).toBe(42)
    expect(result.includedSources).toEqual(['only'])
    expect(result.fallbackEngaged).toBe(false)
  })

  // Test 9: Sources with different priorities → fallback respects priority ordering
  it('respects priority ordering in fallback sources', () => {
    const sources: PriceSource[] = [
      { id: 'stale1', price: 100, timestamp: now - 120_000, priority: 2 },
      { id: 'stale2', price: 200, timestamp: now - 120_000, priority: 0 },
      { id: 'stale3', price: 300, timestamp: now - 120_000, priority: 1 },
    ]

    const result = getMedianPrice(sources, {
      freshnessThresholdMs: 60_000,
      minFreshSources: 2,
      fallbackChain: [['stale2', 'stale1', 'stale3']],
    })

    // All three sources should be included when fallback group is used
    expect(result.includedSources).toHaveLength(3)
    expect(result.includedSources).toContain('stale1')
    expect(result.includedSources).toContain('stale2')
    expect(result.includedSources).toContain('stale3')
    expect(result.median).toBe(200) // median of [100, 200, 300]
  })

  // Test 10: freshnessThresholdMs override → custom threshold respected
  it('respects custom freshnessThresholdMs', () => {
    const sources: PriceSource[] = [
      { id: 'fresh', price: 50, timestamp: now - 5000, priority: 0 },
      { id: 'maybe_stale', price: 100, timestamp: now - 80_000, priority: 1 },
    ]

    // With default threshold (60s), maybe_stale is stale
    const resultDefaultThreshold = getMedianPrice(sources)
    expect(resultDefaultThreshold.excludedSources.map(s => s.id)).toContain('maybe_stale')

    // With higher threshold (100s), maybe_stale is fresh
    const resultHighThreshold = getMedianPrice(sources, { freshnessThresholdMs: 100_000 })
    expect(resultHighThreshold.includedSources).toContain('maybe_stale')
    expect(resultHighThreshold.median).toBe(75)
  })

  // Additional test: No fresh sources but fallback chain is empty
  it('uses partial fresh sources when fallback chain is empty', () => {
    const sources: PriceSource[] = [
      { id: 'fresh', price: 123, timestamp: now - 5000, priority: 0 },
    ]

    const result = getMedianPrice(sources, {
      freshnessThresholdMs: 60_000,
      minFreshSources: 2,
      fallbackChain: [],
    })

    // Should use the single fresh source even though minFreshSources is 2
    expect(result.median).toBe(123)
    expect(result.includedSources).toEqual(['fresh'])
    expect(result.fallbackEngaged).toBe(true)
  })

  // Additional test: Multiple fallback groups, first insufficient
  it('tries next fallback group if first is insufficient', () => {
    const sources: PriceSource[] = [
      { id: 'stale1', price: 100, timestamp: now - 120_000, priority: 0 },
      { id: 'fallback1', price: 200, timestamp: now - 120_000, priority: 1 },
      { id: 'fallback2', price: 300, timestamp: now - 120_000, priority: 2 },
    ]

    const result = getMedianPrice(sources, {
      freshnessThresholdMs: 60_000,
      minFreshSources: 2,
      fallbackChain: [['stale1'], ['fallback1', 'fallback2']],
    })

    // First group has only 1 source, insufficient
    // Second group has 2 sources, should be used
    expect(result.includedSources).toEqual(['fallback1', 'fallback2'])
    expect(result.median).toBe(250)
    expect(result.fallbackEngaged).toBe(true)
  })

  it('includes computedAt timestamp', () => {
    const sources: PriceSource[] = [
      { id: 'src1', price: 100, timestamp: now - 5000, priority: 0 },
    ]

    const result = getMedianPrice(sources, { minFreshSources: 1 })

    expect(result.computedAt).toBe(now)
  })

  it('correctly identifies missing sources in fallback', () => {
    const sources: PriceSource[] = [
      { id: 'fallback1', price: 100, timestamp: now - 120_000, priority: 0 },
      { id: 'fallback2', price: 200, timestamp: now - 120_000, priority: 1 },
      { id: 'not_in_fallback', price: 300, timestamp: now - 5000, priority: 2 },
    ]

    const result = getMedianPrice(sources, {
      freshnessThresholdMs: 60_000,
      minFreshSources: 2,
      fallbackChain: [['fallback1', 'fallback2']],
    })

    expect(result.includedSources).toEqual(['fallback1', 'fallback2'])
    const notInFallbackExcluded = result.excludedSources.find(s => s.id === 'not_in_fallback')
    expect(notInFallbackExcluded?.reason).toBe('missing')
  })
})
