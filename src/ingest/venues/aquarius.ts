/**
 * Aquarius AMM Venue Adapter
 *
 * Indexes Aquarius liquidity pool (Stellar classic) reserves via the
 * Aquarius AMM API, calculates spot prices from constant-product invariants,
 * and stores them in price_points with source = 'aquarius_amm'.
 *
 * Issue: #103
 */

import { config } from '../../config'
import { getActivePairs } from '../../pairsRegistry'
import { upsertPricePoints } from '../../db'
import { dispatchPriceUpdate } from '../../webhookDispatcher'
import type { WatchedPair } from '../../types'

const AQUARIUS_AMM_API = 'https://amm.aquarius.network/api/v1/pools/'

const lastPrice = new Map<string, number>()

interface AquariusPool {
  pool_hash: string
  reserves: string[]
  total_shares: string
}

interface AquariusListResponse {
  results?: AquariusPool[]
}

export async function fetchAquariusPools(pair: WatchedPair): Promise<AquariusPool[]> {
  try {
    const assetAStr = pair.assetA.issuer
      ? `${pair.assetA.code}:${pair.assetA.issuer}`
      : 'native'
    const assetBStr = pair.assetB.issuer
      ? `${pair.assetB.code}:${pair.assetB.issuer}`
      : 'native'

    const params = new URLSearchParams()
    params.append('assets[]', assetAStr)
    params.append('assets[]', assetBStr)

    const res = await fetch(`${AQUARIUS_AMM_API}?${params.toString()}`)
    if (!res.ok) return []
    const data = await res.json() as AquariusListResponse
    return data.results ?? []
  } catch (err) {
    console.error(`[aquarius] Failed to fetch pools for ${pair.pairKey}:`, (err as Error).message)
    return []
  }
}

export async function ingestAquariusPair(pair: WatchedPair): Promise<void> {
  const pools = await fetchAquariusPools(pair)
  if (pools.length === 0) return

  const points = pools.flatMap(pool => {
    const [r0Str, r1Str] = pool.reserves
    if (!r0Str || !r1Str) return []

    const r0 = parseFloat(r0Str)
    const r1 = parseFloat(r1Str)
    if (r0 <= 0 || r1 <= 0) return []

    return [{
      assetA: pair.assetA.code,
      assetB: pair.assetB.code,
      pairKey: pair.pairKey,
      source: 'aquarius_amm' as const,
      poolId: pool.pool_hash,
      price: r1 / r0,
      baseVolume: 0,
      counterVolume: 0,
      ledger: 0,
      timestamp: new Date(),
    }]
  })

  if (points.length === 0) return

  await upsertPricePoints(points as any)

  const latest = points[points.length - 1]
  const previousPrice = lastPrice.get(pair.pairKey) ?? latest.price
  lastPrice.set(pair.pairKey, latest.price)

  dispatchPriceUpdate({
    assetA: pair.assetA.code,
    assetB: pair.assetB.code,
    previousPrice,
    currentPrice: latest.price,
  }).catch(err => console.error('[aquarius] webhook dispatch error:', (err as Error).message))
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

export async function startAquariusIngester(): Promise<void> {
  console.log(`[aquarius] Starting Aquarius AMM ingester for ${getActivePairs().length} pairs`)
  while (true) {
    for (const pair of getActivePairs()) {
      await ingestAquariusPair(pair)
    }
    await sleep(config.indexer.pollIntervalMs)
  }
}
