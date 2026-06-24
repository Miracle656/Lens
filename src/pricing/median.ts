export interface PriceSource {
  id: string
  price: number
  timestamp: number   // Unix milliseconds
  priority: number    // lower number = higher priority (0 = highest)
}

export interface ExcludedSource {
  id: string
  reason: 'stale' | 'missing'
}

export interface MedianPriceResult {
  median: number | null
  includedSources: string[]
  excludedSources: ExcludedSource[]
  fallbackEngaged: boolean
  computedAt: number
}

export interface MedianPriceOptions {
  freshnessThresholdMs?: number   // default: 60_000 (60 seconds)
  minFreshSources?: number        // default: 2
  fallbackChain?: string[][]      // ordered priority groups e.g. [['binance','coinbase'],['coingecko']]
}

function computeMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

export function getMedianPrice(
  sources: PriceSource[],
  options: MedianPriceOptions = {}
): MedianPriceResult {
  const freshnessThresholdMs = options.freshnessThresholdMs ?? 60_000
  const minFreshSources = options.minFreshSources ?? 2
  const fallbackChain = options.fallbackChain ?? []

  const now = Date.now()
  const excludedSources: ExcludedSource[] = []

  // Separate sources into fresh and stale
  const fresh = sources.filter(source => {
    const age = now - source.timestamp
    if (age <= freshnessThresholdMs) {
      return true
    }
    excludedSources.push({ id: source.id, reason: 'stale' })
    return false
  })

  // Case 1: Enough fresh sources
  if (fresh.length >= minFreshSources) {
    const prices = fresh.map(s => s.price)
    const median = computeMedian(prices)
    return {
      median,
      includedSources: fresh.map(s => s.id),
      excludedSources,
      fallbackEngaged: false,
      computedAt: now,
    }
  }

  // Case 2: Try fallback chain
  if (fallbackChain.length > 0) {
    for (const group of fallbackChain) {
      // Filter sources to those in this fallback group
      const groupSources = sources
        .filter(s => group.includes(s.id))
        .sort((a, b) => a.priority - b.priority)

      if (groupSources.length >= minFreshSources) {
        const prices = groupSources.map(s => s.price)
        const median = computeMedian(prices)

        // Recompute excluded: everything not used
        const usedIds = new Set(groupSources.map(s => s.id))
        const newExcluded = sources
          .filter(s => !usedIds.has(s.id))
          .map(s => ({
            id: s.id,
            reason: (now - s.timestamp) > freshnessThresholdMs ? 'stale' as const : 'missing' as const,
          }))

        return {
          median,
          includedSources: groupSources.map(s => s.id),
          excludedSources: newExcluded,
          fallbackEngaged: true,
          computedAt: now,
        }
      }
    }
  }

  // Case 3: Use fresh sources even if below minFreshSources
  if (fresh.length > 0) {
    const prices = fresh.map(s => s.price)
    const median = computeMedian(prices)
    return {
      median,
      includedSources: fresh.map(s => s.id),
      excludedSources,
      fallbackEngaged: true,
      computedAt: now,
    }
  }

  // Case 4: No sources at all
  return {
    median: null,
    includedSources: [],
    excludedSources: sources.map(s => ({ id: s.id, reason: 'stale' as const })),
    fallbackEngaged: true,
    computedAt: now,
  }
}
