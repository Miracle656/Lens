/**
 * Soroswap AMM Pool Price Ingester
 *
 * Polls Soroswap Soroban pool reserves via Soroban RPC simulation,
 * calculates constant-product spot prices, and stores them in price_points
 * with source = 'soroswap_amm'. Runs independently of the SDEX and Horizon
 * AMM ingesters — a crash here cannot affect them.
 *
 * Issue: #48
 */

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  scValToNative,
  Account,
} from '@stellar/stellar-sdk'
import { config } from '../config'
import { getActivePairs } from '../pairsRegistry'
import { upsertPricePoints } from '../db'
import { dispatchPriceUpdate } from '../webhookDispatcher'
import type { WatchedPair } from '../types'

// ── Constants ─────────────────────────────────────────────────────────────────

const SOROSWAP_TOKEN_LIST_URL =
  'https://raw.githubusercontent.com/soroswap/token-list/main/tokenList.json'

// Ephemeral fee-payer account (no real funds needed for simulation)
const FEE_PAYER_KEYPAIR = Keypair.random()

// In-memory last-price tracker for webhook delta dispatch
const lastPrice = new Map<string, number>()

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SoroswapToken {
  address: string
  symbol: string
  name: string
  decimals: number
}

export interface SoroswapTokenList {
  tokens: SoroswapToken[]
}

export interface PoolEntry {
  poolAddress: string
  tokenA: SoroswapToken
  tokenB: SoroswapToken
}

// ── RPC client (lazy-initialised so tests can skip it) ────────────────────────

let _rpc: SorobanRpc.Server | null = null
function getRpc(): SorobanRpc.Server {
  if (!_rpc) {
    _rpc = new SorobanRpc.Server(config.rpc.url, { allowHttp: true })
  }
  return _rpc
}

// ── Token-list helpers ────────────────────────────────────────────────────────

/**
 * Fetch Soroswap token list. Returns an empty array on failure so the ingester
 * degrades gracefully without affecting other ingesters.
 */
export async function fetchSoroswapTokenList(): Promise<SoroswapToken[]> {
  try {
    const res = await fetch(SOROSWAP_TOKEN_LIST_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as SoroswapTokenList
    return Array.isArray(data.tokens) ? data.tokens : []
  } catch (err) {
    console.error('[soroswap] Failed to fetch token list:', (err as Error).message)
    return []
  }
}

// ── Pool discovery ────────────────────────────────────────────────────────────

/**
 * Query the Soroswap factory contract's get_pools() to enumerate pool addresses
 * for a specific token pair. Returns an empty array on RPC failure.
 */
export async function fetchPoolsFromFactory(
  factoryAddress: string,
  tokenA: string,
  tokenB: string
): Promise<string[]> {
  try {
    const rpc = getRpc()
    const factory = new Contract(factoryAddress)
    const account = new Account(FEE_PAYER_KEYPAIR.publicKey(), '0')
    const networkPassphrase =
      config.network.passphrase ?? Networks.PUBLIC

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        factory.call(
          'get_pools',
          new Contract(tokenA).address().toScVal(),
          new Contract(tokenB).address().toScVal()
        )
      )
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)

    if (SorobanRpc.Api.isSimulationError(sim)) {
      console.debug(
        `[soroswap] get_pools simulation error for ${tokenA}/${tokenB}:`,
        sim.error
      )
      return []
    }

    if (!sim.result?.retval) return []

    const pools = scValToNative(sim.result.retval) as string[]
    return Array.isArray(pools) ? pools : []
  } catch (err) {
    console.debug(
      '[soroswap] fetchPoolsFromFactory error:',
      (err as Error).message
    )
    return []
  }
}

// ── Reserve reading ───────────────────────────────────────────────────────────

/**
 * Read a Soroswap pool's reserves via Soroban RPC simulation.
 * Returns [reserveA, reserveB] where A is `tokenAAddress`.
 * Returns null on any RPC error.
 */
export async function fetchPoolReserves(
  poolAddress: string
): Promise<[bigint, bigint] | null> {
  try {
    const rpc = getRpc()
    const pool = new Contract(poolAddress)
    const account = new Account(FEE_PAYER_KEYPAIR.publicKey(), '0')
    const networkPassphrase =
      config.network.passphrase ?? Networks.PUBLIC

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(pool.call('get_reserves'))
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)

    if (SorobanRpc.Api.isSimulationError(sim)) {
      console.debug(
        `[soroswap] get_reserves simulation error for pool ${poolAddress}:`,
        sim.error
      )
      return null
    }

    if (!sim.result?.retval) return null

    const reserves = scValToNative(sim.result.retval) as [bigint | number, bigint | number]
    if (!Array.isArray(reserves) || reserves.length < 2) return null

    return [BigInt(reserves[0]), BigInt(reserves[1])]
  } catch (err) {
    console.debug(
      `[soroswap] fetchPoolReserves error for ${poolAddress}:`,
      (err as Error).message
    )
    return null
  }
}

// ── Spot price ────────────────────────────────────────────────────────────────

/**
 * Pure function: calculate spot price from constant-product reserves.
 * Returns 0 if either reserve is zero (empty pool guard).
 *
 * price = reserveA / reserveB
 * (price of assetB denominated in assetA)
 */
export function calcSpotPrice(reserveA: bigint, reserveB: bigint): number {
  if (reserveA === 0n || reserveB === 0n) return 0
  // Use Number division; reserves are i128 scaled to 7 decimal places
  return Number(reserveA) / Number(reserveB)
}

// ── Per-pool ingestion ────────────────────────────────────────────────────────

/**
 * Fetch reserves for a single pool, compute spot price, and store a price point.
 * Skips silently on empty pool or RPC failure — does not throw.
 */
export async function ingestPool(
  poolEntry: PoolEntry,
  pair: WatchedPair
): Promise<void> {
  try {
    const reserves = await fetchPoolReserves(poolEntry.poolAddress)
    if (!reserves) return

    const [reserveA, reserveB] = reserves
    const spotPrice = calcSpotPrice(reserveA, reserveB)

    if (spotPrice === 0) {
      console.debug(
        `[soroswap] Skipping empty pool ${poolEntry.poolAddress} for ${pair.pairKey}`
      )
      return
    }

    await upsertPricePoints([
      {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        source: 'soroswap_amm' as const,
        poolId: poolEntry.poolAddress,
        price: spotPrice,
        baseVolume: 0,
        counterVolume: 0,
        ledger: 0,
        timestamp: new Date(),
        eventId: `soroswap-${poolEntry.poolAddress}-${Date.now()}`,
      },
    ])

    const previousPrice = lastPrice.get(pair.pairKey) ?? spotPrice
    lastPrice.set(pair.pairKey, spotPrice)

    dispatchPriceUpdate({
      assetA: pair.assetA.code,
      assetB: pair.assetB.code,
      previousPrice,
      currentPrice: spotPrice,
    }).catch((err) =>
      console.error('[soroswap] webhook dispatch error:', err.message)
    )

    console.log(
      `[soroswap] Pool ${poolEntry.poolAddress.slice(0, 8)}: price=${spotPrice.toFixed(8)} for ${pair.pairKey}`
    )
  } catch (err) {
    console.error(
      `[soroswap] ingestPool error for ${poolEntry.poolAddress}:`,
      (err as Error).message
    )
  }
}

// ── Main per-pair logic ───────────────────────────────────────────────────────

/**
 * Discover Soroswap pools for a watched pair, then snapshot each pool's price.
 * Matches pair assets to token list by symbol; filters to watched pairs only.
 */
export async function ingestPair(
  pair: WatchedPair,
  tokens: SoroswapToken[],
  factoryAddress: string
): Promise<void> {
  const tokenA = tokens.find(
    (t) => t.symbol.toUpperCase() === pair.assetA.code.toUpperCase()
  )
  const tokenB = tokens.find(
    (t) => t.symbol.toUpperCase() === pair.assetB.code.toUpperCase()
  )

  if (!tokenA || !tokenB) {
    console.debug(
      `[soroswap] No Soroswap token found for pair ${pair.pairKey} — skipping`
    )
    return
  }

  const poolAddresses = await fetchPoolsFromFactory(
    factoryAddress,
    tokenA.address,
    tokenB.address
  )

  if (!poolAddresses.length) {
    console.debug(
      `[soroswap] No pools found for ${pair.pairKey} — skipping`
    )
    return
  }

  await Promise.all(
    poolAddresses.map((addr) =>
      ingestPool(
        { poolAddress: addr, tokenA, tokenB },
        pair
      )
    )
  )
}

// ── Ingester loop ─────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Start the Soroswap AMM ingester. Runs as an infinite polling loop.
 * Fault-isolated: a crash is caught by the caller (restartIngester in index.ts).
 */
export async function startSoroswapIngester(): Promise<void> {
  const factoryAddress = config.soroswap.factoryAddress
  const pollInterval = config.soroswap.pollIntervalMs

  console.log(
    `[soroswap] Starting Soroswap ingester | factory=${factoryAddress} | interval=${pollInterval}ms`
  )

  while (true) {
    const pairs = getActivePairs()
    const tokens = await fetchSoroswapTokenList()

    if (tokens.length === 0) {
      console.warn('[soroswap] Token list empty — skipping poll cycle')
    } else {
      await Promise.all(
        pairs.map((pair) => ingestPair(pair, tokens, factoryAddress))
      )
    }

    await sleep(pollInterval)
  }
}
