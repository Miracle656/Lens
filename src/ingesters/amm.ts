import { Horizon } from '@stellar/stellar-sdk'
import { config } from '../config'
import { upsertPricePoints, getIndexerCursor, setIndexerCursor, prisma } from '../db'
import type { WatchedPair } from '../types'

const horizonServer = new Horizon.Server(config.horizon.url)

async function fetchPools(pair: WatchedPair): Promise<any[]> {
  try {
    // Use Horizon's reserves filter to find pools for this specific pair
    const assetAStr = pair.assetA.issuer
      ? `${pair.assetA.code}:${pair.assetA.issuer}`
      : 'native'
    const assetBStr = pair.assetB.issuer
      ? `${pair.assetB.code}:${pair.assetB.issuer}`
      : 'native'

    const params = new URLSearchParams()
    params.append('reserves[]', assetAStr)
    params.append('reserves[]', assetBStr)
    params.set('limit', '10')

    const response = await fetch(
      `${config.horizon.url}/liquidity_pools?${params.toString()}`
    )
    const data = await response.json() as any
    if (!data._embedded?.records) return []
    return data._embedded.records
  } catch (err) {
    console.error(`[amm] Failed to fetch pools for ${pair.pairKey}:`, (err as Error).message)
    return []
  }
}

async function snapshotPool(pool: any, pair: WatchedPair): Promise<void> {
  try {
    const r0 = pool.reserves[0]
    const r1 = pool.reserves[1]

    const code0 = r0.asset === 'native' ? 'XLM' : r0.asset.split(':')[0]
    const isForward = code0 === pair.assetA.code

    const reserveA = parseFloat(isForward ? r0.amount : r1.amount)
    const reserveB = parseFloat(isForward ? r1.amount : r0.amount)
    const spotPrice = reserveA > 0 ? reserveB / reserveA : 0
    const feeBp = pool.fee_bp ?? 30

    await prisma.poolSnapshot.create({
      data: {
        poolId: pool.id,
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        reserveA,
        reserveB,
        spotPrice,
        totalShares: parseFloat(pool.total_shares ?? '0'),
        feeBp,
        ledger: pool.last_modified_ledger ?? 0,
        timestamp: new Date(),
      },
    })

    // Also record spot price as a price point (no volume — it's a snapshot, not a trade)
    if (spotPrice > 0) {
      await upsertPricePoints([{
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        source: 'AMM',
        poolId: pool.id,
        price: spotPrice,
        baseVolume: 0,
        counterVolume: 0,
        ledger: pool.last_modified_ledger ?? 0,
        timestamp: new Date(),
        eventId: `amm-snapshot-${pool.id}-${Date.now()}`,
      }])
    }
  } catch (err) {
    console.error(`[amm] Snapshot error for pool ${pool.id}:`, (err as Error).message)
  }
}

async function ingestPoolTrades(pool: any, pair: WatchedPair): Promise<void> {
  const stateId = `amm:${pool.id}`
  const cursor = await getIndexerCursor(stateId) ?? '0'

  try {
    const response = await fetch(
      `${config.horizon.url}/liquidity_pools/${pool.id}/trades?cursor=${cursor}&limit=${config.indexer.ammPageSize}&order=asc`
    )
    const data = await response.json() as any
    const records = data._embedded?.records ?? []

    if (!records.length) return

    const points = records.map((t: any) => {
      const baseCode = t.base_asset_type === 'native' ? 'XLM' : t.base_asset_code
      const isForward = baseCode === pair.assetA.code
      const price = isForward
        ? parseFloat(t.counter_amount) / parseFloat(t.base_amount)
        : parseFloat(t.base_amount) / parseFloat(t.counter_amount)

      return {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        source: 'AMM' as const,
        poolId: pool.id,
        price,
        baseVolume: parseFloat(t.base_amount),
        counterVolume: parseFloat(t.counter_amount),
        ledger: 0,
        timestamp: new Date(t.ledger_close_time),
        eventId: t.id,
      }
    })

    await upsertPricePoints(points)
    const lastCursor = records[records.length - 1].paging_token
    await setIndexerCursor(stateId, lastCursor)
    console.log(`[amm] Pool ${pool.id.slice(0, 8)}: ingested ${points.length} trades`)
  } catch (err) {
    console.error(`[amm] Trade ingest error for pool ${pool.id}:`, (err as Error).message)
  }
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

export async function startAMMIngester(): Promise<void> {
  console.log(`[amm] Starting AMM ingester for ${config.pairs.length} pairs`)

  while (true) {
    for (const pair of config.pairs) {
      const pools = await fetchPools(pair)
      console.log(`[amm] ${pair.pairKey}: found ${pools.length} AMM pools`)

      await Promise.all(pools.map(async pool => {
        await snapshotPool(pool, pair)
        await ingestPoolTrades(pool, pair)
      }))
    }
    await sleep(config.indexer.pollIntervalMs)
  }
}
