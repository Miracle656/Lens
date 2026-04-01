import { Horizon } from '@stellar/stellar-sdk'
import { config } from '../config'
import { upsertPricePoints, getIndexerCursor, setIndexerCursor } from '../db'
import type { WatchedPair } from '../types'

const horizonServer = new Horizon.Server(config.horizon.url)

function assetFilter(asset: { code: string; issuer: string | null }) {
  if (!asset.issuer) {
    return { asset_type: 'native' }
  }
  return { asset_code: asset.code, asset_issuer: asset.issuer }
}

async function ingestPair(pair: WatchedPair): Promise<void> {
  const stateId = `sdex:${pair.pairKey}`
  const cursor = await getIndexerCursor(stateId) ?? 'now'

  try {
    const baseFilter = assetFilter(pair.assetA)
    const counterFilter = assetFilter(pair.assetB)

    // Build Horizon trades query
    let builder = horizonServer.trades()

    if (baseFilter.asset_type === 'native') {
      builder = builder.forAssetPair(
        { asset_type: 'native' } as any,
        counterFilter.asset_code
          ? { asset_type: 'credit_alphanum4', asset_code: counterFilter.asset_code, asset_issuer: counterFilter.asset_issuer } as any
          : { asset_type: 'native' } as any
      )
    }

    const trades = await horizonServer
      .trades()
      .cursor(cursor)
      .limit(config.indexer.sdexPageSize)
      .order('asc')
      .call()

    if (!trades.records.length) return

    const points = trades.records
      .filter((t: any) => {
        // Filter to our watched pair
        const baseCode = t.base_asset_type === 'native' ? 'XLM' : t.base_asset_code
        const counterCode = t.counter_asset_type === 'native' ? 'XLM' : t.counter_asset_code
        const matchesAB = baseCode === pair.assetA.code && counterCode === pair.assetB.code
        const matchesBA = baseCode === pair.assetB.code && counterCode === pair.assetA.code
        return matchesAB || matchesBA
      })
      .map((t: any) => {
        const baseCode = t.base_asset_type === 'native' ? 'XLM' : t.base_asset_code
        const isForward = baseCode === pair.assetA.code

        const price = isForward
          ? parseFloat(t.price.n) / parseFloat(t.price.d)
          : parseFloat(t.price.d) / parseFloat(t.price.n)

        return {
          assetA: pair.assetA.code,
          assetB: pair.assetB.code,
          pairKey: pair.pairKey,
          source: 'SDEX' as const,
          price,
          baseVolume: parseFloat(t.base_amount),
          counterVolume: parseFloat(t.counter_amount),
          ledger: t.ledger_close_time ? 0 : 0,
          timestamp: new Date(t.ledger_close_time),
          eventId: t.id,
        }
      })

    if (points.length > 0) {
      await upsertPricePoints(points)
      const lastCursor = trades.records[trades.records.length - 1].paging_token
      await setIndexerCursor(stateId, lastCursor)
      console.log(`[sdex] ${pair.pairKey}: ingested ${points.length} trades`)
    }
  } catch (err) {
    console.error(`[sdex] Error ingesting ${pair.pairKey}:`, (err as Error).message)
  }
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

export async function startSDEXIngester(): Promise<void> {
  console.log(`[sdex] Starting SDEX ingester for ${config.pairs.length} pairs`)

  while (true) {
    await Promise.all(config.pairs.map(pair => ingestPair(pair)))
    await sleep(config.indexer.pollIntervalMs)
  }
}
