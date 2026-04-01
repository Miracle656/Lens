import Redis from 'ioredis'
import { config } from './config'

export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
})

redis.on('error', (err) => {
  console.error('[redis] Connection error:', err.message)
})

export async function getCachedPrice(pairKey: string): Promise<string | null> {
  try {
    return await redis.get(`lens:price:${pairKey}`)
  } catch {
    return null
  }
}

export async function setCachedPrice(pairKey: string, data: object, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(`lens:price:${pairKey}`, JSON.stringify(data), 'EX', ttlSeconds)
  } catch {
    // Redis cache miss is non-fatal
  }
}
