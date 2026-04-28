// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock('../db', () => ({
  prisma: {
    poolSnapshot: {
      create: vi.fn(),
    },
  },
  upsertPricePoints: vi.fn(),
  getIndexerCursor: vi.fn(),
  setIndexerCursor: vi.fn(),
}))

vi.mock('../webhookDispatcher', () => ({
  dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
}))

// ── Imports ──────────────────────────────────────────────────────────────────
import { snapshotPool, ingestPoolTrades } from '../ingesters/amm'
import { prisma, upsertPricePoints, getIndexerCursor, setIndexerCursor } from '../db'
import { dispatchPriceUpdate } from '../webhookDispatcher'

describe('AMM Ingester', () => {
  const mockPair = {
    pairKey: 'XLM-USD',
    assetA: { code: 'XLM', issuer: null },
    assetB: { code: 'USD', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  it('calculates snapshot price correctly', async () => {
    const mockPool = {
      id: 'pool-1',
      reserves: [
        { asset: 'native', amount: '100.0' },
        { asset: 'USD:GABC...', amount: '20.0' },
      ],
      total_shares: '50',
      last_modified_ledger: 12345,
    }

    await snapshotPool(mockPool, mockPair as any)

    expect(prisma.poolSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spotPrice: 0.2,
        }),
      })
    )
  })

  it('ingests trades correctly', async () => {
    (getIndexerCursor as any).mockResolvedValue('0')
    
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        _embedded: {
          records: [
            {
              id: 't-1',
              paging_token: 'p-1',
              base_asset_type: 'native',
              base_amount: '10.0',
              counter_amount: '2.0',
              ledger_close_time: '2024-01-01T00:00:00Z',
            }
          ]
        }
      })
    })

    await ingestPoolTrades({ id: 'pool-1' }, mockPair as any)

    expect(upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          price: 0.2,
        })
      ])
    )
  })
})
