import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

// bullmq pulls in ioredis at import time; stub it so the unit under test loads
// without a live Redis connection.
vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
}))

import { pruneOldSnapshots, pruneAllNetworks, SNAPSHOT_RETENTION_DAYS } from '../jobs/snapshotRetention'
import { activeNetwork } from '../config'

describe('pruneOldSnapshots', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('defaults to the 30-day retention window', async () => {
    mockQuery.mockResolvedValue({ rowCount: 5 })

    const pruned = await pruneOldSnapshots()

    expect(SNAPSHOT_RETENTION_DAYS).toBe(30)
    expect(pruned).toBe(5)
    expect(mockQuery.mock.calls[0][1]).toEqual([activeNetwork, 30])
    expect(mockQuery.mock.calls[0][0]).toMatch(/DELETE FROM price_snapshots/)
    expect(mockQuery.mock.calls[0][0]).toMatch(/ts < NOW\(\) - \(\$2 \|\| ' days'\)::interval/)
  })

  it('honors a custom retention window', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 })

    const pruned = await pruneOldSnapshots(7)

    expect(pruned).toBe(0)
    expect(mockQuery.mock.calls[0][1]).toEqual([activeNetwork, 7])
  })

  it('returns 0 when rowCount is null', async () => {
    mockQuery.mockResolvedValue({ rowCount: null })

    expect(await pruneOldSnapshots()).toBe(0)
  })
})

describe('pruneOldSnapshots network argument', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('binds the requested network instead of the active one', async () => {
    mockQuery.mockResolvedValue({ rowCount: 2 })

    await pruneOldSnapshots(30, 'mainnet')
    await pruneOldSnapshots(30, 'testnet')

    expect(mockQuery.mock.calls[0][1]).toEqual(['mainnet', 30])
    expect(mockQuery.mock.calls[1][1]).toEqual(['testnet', 30])
  })
})

describe('pruneAllNetworks', () => {
  const saved = process.env.ENABLED_NETWORKS

  beforeEach(() => {
    mockQuery.mockReset()
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.ENABLED_NETWORKS
    else process.env.ENABLED_NETWORKS = saved
  })

  // Fake table keyed by network, so the test fails if any network is skipped.
  function fakeTable(rows: Record<string, number>) {
    mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
      const network = params[0] as string
      const count = rows[network] ?? 0
      rows[network] = 0
      return { rowCount: count }
    })
    return rows
  }

  it('prunes both networks on a dual-network process and reports per-network counts', async () => {
    process.env.ENABLED_NETWORKS = 'testnet,mainnet'
    const rows = fakeTable({ testnet: 4, mainnet: 9 })

    const counts = await pruneAllNetworks()

    expect(counts).toEqual({ testnet: 4, mainnet: 9 })
    expect(rows).toEqual({ testnet: 0, mainnet: 0 })
    expect(mockQuery.mock.calls.map(c => c[1][0])).toEqual(['testnet', 'mainnet'])
  })

  it('prunes only the active network when ENABLED_NETWORKS is unset', async () => {
    delete process.env.ENABLED_NETWORKS
    fakeTable({ testnet: 1, mainnet: 1 })

    const counts = await pruneAllNetworks()

    expect(Object.keys(counts)).toEqual([activeNetwork])
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('still prunes the other network when one fails, then reports the failure', async () => {
    process.env.ENABLED_NETWORKS = 'testnet,mainnet'
    mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
      if (params[0] === 'testnet') throw new Error('boom')
      return { rowCount: 3 }
    })

    await expect(pruneAllNetworks()).rejects.toThrow(/testnet: boom/)
    expect(mockQuery.mock.calls.map(c => c[1][0])).toEqual(['testnet', 'mainnet'])
  })
})
