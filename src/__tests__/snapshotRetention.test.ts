import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { pruneOldSnapshots, SNAPSHOT_RETENTION_DAYS } from '../jobs/snapshotRetention'

describe('pruneOldSnapshots', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('defaults to the 30-day retention window', async () => {
    mockQuery.mockResolvedValue({ rowCount: 5 })

    const pruned = await pruneOldSnapshots()

    expect(SNAPSHOT_RETENTION_DAYS).toBe(30)
    expect(pruned).toBe(5)
    expect(mockQuery.mock.calls[0][1]).toEqual([30])
    expect(mockQuery.mock.calls[0][0]).toMatch(/DELETE FROM price_snapshots/)
    expect(mockQuery.mock.calls[0][0]).toMatch(/ts < NOW\(\) - \(\$1 \|\| ' days'\)::interval/)
  })

  it('honors a custom retention window', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 })

    const pruned = await pruneOldSnapshots(7)

    expect(pruned).toBe(0)
    expect(mockQuery.mock.calls[0][1]).toEqual([7])
  })

  it('returns 0 when rowCount is null', async () => {
    mockQuery.mockResolvedValue({ rowCount: null })

    expect(await pruneOldSnapshots()).toBe(0)
  })
})
