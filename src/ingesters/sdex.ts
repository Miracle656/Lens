import { Horizon, Asset } from '@stellar/stellar-sdk'
import { config } from '../config'
import { getActivePairs } from '../pairsRegistry'
import { upsertPricePoints, getIndexerCursor, setIndexerCursor } from '../db'
import { dispatchPriceUpdate } from '../webhookDispatcher'
import type { WatchedPair } from '../types'

const horizonServer = new Horizon.Server(config.horizon.url)

// Last seen price per pairKey — used for threshold crossing detection
const lastPrice = new Map<string, number>()

function toAsset(asset: { code: string; issuer: string | null }): Asset {
  if (!asset.issuer || asset.code === 'XLM') return Asset.native()
  return new Asset(asset.code, asset.issuer)
}

async function ingestPair(pair: WatchedPair): Promise<void> {
  const stateId = `sdex:${pair.pairKey}`
  const cursor = await getIndexerCursor(stateId) ?? '0'

  try {
    const assetA = toAsset(pair.assetA)
    const assetB = toAsset(pair.assetB)

    const trades = await horizonServer
      .trades()
      .forAssetPair(assetA, assetB)
      .cursor(cursor)
      .limit(config.indexer.sdexPageSize)
      .order('asc')
      .call()

    if (!trades.records.length) return

    const points = trades.records.map((t: any) => {
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
        ledger: 0,
        timestamp: new Date(t.ledger_close_time),
        eventId: t.id,
      }
    })

    if (points.length > 0) {
      const previousPrice = lastPrice.get(pair.pairKey) ?? points[0].price
      const currentPrice = points[points.length - 1].price

      await upsertPricePoints(points)
      lastPrice.set(pair.pairKey, currentPrice)

      const lastCursor = trades.records[trades.records.length - 1].paging_token
      await setIndexerCursor(stateId, lastCursor)
      console.log(`[sdex] ${pair.pairKey}: ingested ${points.length} trades`)

      dispatchPriceUpdate({
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        previousPrice,
        currentPrice,
      }).catch(err => console.error('[sdex] webhook dispatch error:', err.message))
    }
  } catch (err) {
    console.error(`[sdex] Error ingesting ${pair.pairKey}:`, (err as Error).message)
  }
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

export async function startSDEXIngester(): Promise<void> {
  console.log(`[sdex] Starting SDEX ingester for ${getActivePairs().length} pairs`)

  while (true) {
    await Promise.all(getActivePairs().map(pair => ingestPair(pair)))
    await sleep(config.indexer.pollIntervalMs)
  }
}
