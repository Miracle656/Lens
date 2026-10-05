import Redis from 'ioredis'
import { config, type NetworkName } from './config'

export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  // Fail commands immediately while disconnected instead of queueing them.
  //
  // ioredis defaults this to true, so with an unreachable host every command
  // sits in the offline queue waiting for a connection that never comes. The
  // await simply never resolves — a hang, not an error, so the try/catch in
  // getCachedPrice cannot help and the request dies of timeout instead of
  // falling through to Postgres.
  //
  // It stayed hidden while REQUIRE_API_KEY was on, because the auth hook
  // rejected requests before any handler could reach Redis. Opening the API up
  // turned a 401 into a hang, which looked like the key change had failed.
  //
  // Rejecting fast is what the callers already expect: reads fall back to the
  // database, writes are best-effort, and x402 metering fails closed.
  enableOfflineQueue: false,
  // ioredis retries about once a second forever by default. Against a host
  // that no longer resolves that is a DNS lookup and two log lines every
  // second — roughly 170k lines a day, which buries every real message in the
  // log and is how a dead cache stayed invisible for weeks. Back off to a
  // lookup a minute instead. Still reconnects on its own when the host comes
  // back; just quietly.
  retryStrategy: (times) => Math.min(times * 2_000, 60_000),
})

// Same reasoning for the error events themselves: report the first one, then
// at most one a minute with a count of what was suppressed, so a persistent
// outage stays visible without drowning everything else.
let lastRedisErrorLog = 0
let suppressedRedisErrors = 0

redis.on('error', (err) => {
  const now = Date.now()
  if (now - lastRedisErrorLog < 60_000) {
    suppressedRedisErrors++
    return
  }
  const suffix = suppressedRedisErrors > 0 ? ` (${suppressedRedisErrors} more since last report)` : ''
  console.error('[redis] Connection error:', err.message + suffix)
  lastRedisErrorLog = now
  suppressedRedisErrors = 0
})

/**
 * Build the Redis key for a cached price.
 *
 * This is the one place that owns the key shape. The worker and the
 * /price route both call the helpers below with the same (network, pairKey)
 * pair, so the keys they produce are identical. Previously the route passed
 * `${network}:${pair}` as the "pairKey" and this function added the process
 * network again, so the worker wrote `lens:testnet:price:XLM/USDC` while
 * the route read `lens:testnet:price:testnet:XLM/USDC` — the warm-cache path
 * was dead.
 */
export function priceCacheKey(network: NetworkName, pairKey: string): string {
  return `lens:${network}:price:${pairKey}`
}

export async function getCachedPrice(network: NetworkName, pairKey: string): Promise<string | null> {
  try {
    return await redis.get(priceCacheKey(network, pairKey))
  } catch {
    return null
  }
}

export async function setCachedPrice(network: NetworkName, pairKey: string, data: object, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(priceCacheKey(network, pairKey), JSON.stringify(data), 'EX', ttlSeconds)
  } catch {
    // Redis cache miss is non-fatal
  }
}
