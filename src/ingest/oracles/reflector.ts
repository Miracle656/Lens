/**
 * Reflector Oracle Adapter
 *
 * Polls Reflector on-chain oracle contract prices via Soroban RPC simulation
 * and provides price data for the /compare/:asset comparison endpoint.
 *
 * Issue: #104
 */

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  scValToNative,
  nativeToScVal,
  Account,
} from '@stellar/stellar-sdk'
import { config } from '../../config'

// Reflector oracle mainnet contract address
const REFLECTOR_CONTRACT_ID =
  process.env.REFLECTOR_CONTRACT_ID ??
  'CCYXZMNHFXHKF3YEX4VJJ5TH3YHCVZIBPNBGM7C4PJIMCIMNNWDOQYA'

// Ephemeral fee payer — simulation only, no real funds needed
const FEE_PAYER = Keypair.random()

let _rpc: SorobanRpc.Server | null = null
function getRpc(): SorobanRpc.Server {
  _rpc ??= new SorobanRpc.Server(config.rpc.url, { allowHttp: true })
  return _rpc
}

export interface ReflectorPrice {
  asset: string
  price: number
  timestamp: number
}

/**
 * Fetch the latest price for a given asset code from the Reflector oracle.
 * Returns null when the contract is unreachable or the asset is unknown.
 */
export async function fetchReflectorPrice(assetCode: string): Promise<ReflectorPrice | null> {
  try {
    const rpc = getRpc()
    const contract = new Contract(REFLECTOR_CONTRACT_ID)
    const account = new Account(FEE_PAYER.publicKey(), '0')

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: config.network.passphrase,
    })
      .addOperation(
        contract.call('lastprice', nativeToScVal(assetCode, { type: 'symbol' }))
      )
      .setTimeout(30)
      .build()

    const result = await rpc.simulateTransaction(tx)
    if (!SorobanRpc.Api.isSimulationSuccess(result)) return null

    const raw = scValToNative((result as any).result?.retval) as {
      price?: bigint
      timestamp?: bigint
    } | null

    if (!raw || raw.price === undefined) return null

    // Reflector uses 14 decimal places of precision
    const price = Number(raw.price) / 1e14

    return {
      asset: assetCode.toUpperCase(),
      price,
      timestamp: Number(raw.timestamp ?? 0),
    }
  } catch {
    return null
  }
}

// In-memory cache (60 s TTL) to avoid hammering RPC on every comparison request
const _cache = new Map<string, { price: number; fetchedAt: number }>()
const CACHE_TTL_MS = 60_000

export async function getCachedReflectorPrice(asset: string): Promise<number | null> {
  const key = asset.toUpperCase()
  const entry = _cache.get(key)
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
    return entry.price
  }
  const fresh = await fetchReflectorPrice(key)
  if (fresh) {
    _cache.set(key, { price: fresh.price, fetchedAt: Date.now() })
    return fresh.price
  }
  return null
}
