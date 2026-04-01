import 'dotenv/config'
import type { WatchedPair, AssetId } from './types'

function parseAsset(str: string): AssetId {
  const [code, issuer] = str.split(':')
  return {
    code: code.toUpperCase(),
    issuer: (!issuer || issuer.toLowerCase() === 'native') ? null : issuer,
  }
}

function makePairKey(a: AssetId, b: AssetId): string {
  const aStr = a.issuer ? `${a.code}:${a.issuer}` : a.code
  const bStr = b.issuer ? `${b.code}:${b.issuer}` : b.code
  // Alphabetical sort so XLM/USDC and USDC/XLM resolve to the same key
  return [aStr, bStr].sort().join('/')
}

function parseWatchedPairs(): WatchedPair[] {
  const raw = process.env.WATCHED_PAIRS ?? ''
  if (!raw.trim()) return []
  return raw.split(',').map(pair => {
    const [a, b] = pair.trim().split('/')
    if (!a || !b) throw new Error(`Invalid pair format: ${pair}. Expected "CODE:ISSUER/CODE:ISSUER"`)
    const assetA = parseAsset(a)
    const assetB = parseAsset(b)
    return { assetA, assetB, pairKey: makePairKey(assetA, assetB) }
  })
}

export const config = {
  horizon: {
    url: process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
  },
  rpc: {
    url: process.env.RPC_URL ?? 'https://soroban-testnet.stellar.org',
  },
  network: {
    passphrase: process.env.NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
  },
  db: {
    url: process.env.DATABASE_URL ?? 'postgresql://lens:lens@localhost:5432/lens',
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  api: {
    port: parseInt(process.env.PORT ?? '3002', 10),
    host: process.env.HOST ?? '0.0.0.0',
  },
  indexer: {
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10),
    sdexPageSize: parseInt(process.env.SDEX_PAGE_SIZE ?? '200', 10),
    ammPageSize: parseInt(process.env.AMM_PAGE_SIZE ?? '200', 10),
  },
  cache: {
    priceTtl: parseInt(process.env.PRICE_CACHE_TTL ?? '10', 10),
  },
  pairs: parseWatchedPairs(),
} as const
