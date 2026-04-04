import { Queue, Worker } from 'bullmq'
import { config } from '../config'
import { pgPool, prisma } from '../db'
import { setCachedPrice } from '../redis'
import { calculateVWAP, calculateOHLCV, getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'

const QUEUE_NAME = 'aggregate-refresh'

function redisConnection() {
  const url = process.env.REDIS_URL
  if (url) return { url }
  return { host: 'localhost', port: 6379 }
}

export function createAggregateQueue() {
  return new Queue(QUEUE_NAME, { connection: redisConnection() })
}

export function startAggregateWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { pairKey, pair } = job.data
      try {
        const agg = await getAggregatedPrice(pairKey)
        const route = await getBestRoute(pair.assetA, pair.assetB, pairKey, 1000)

        const result = {
          assetA: pair.assetA.code,
          assetB: pair.assetB.code,
          pairKey,
          ...agg,
          bestRoute: route.route,
          lastUpdated: new Date(),
        }

        // Cache in Redis
        await setCachedPrice(pairKey, result, config.cache.priceTtl)

        // Upsert aggregate buckets for each window
        const windows: Array<{ key: string; minutes: number }> = [
          { key: '1m', minutes: 1 },
          { key: '5m', minutes: 5 },
          { key: '1h', minutes: 60 },
          { key: '24h', minutes: 1440 },
        ]

        const bucket = new Date()
        bucket.setSeconds(0, 0)

        for (const w of windows) {
          const [vwap, sdexVwap, ammVwap, ohlcv] = await Promise.all([
            calculateVWAP(pairKey, w.minutes),
            calculateVWAP(pairKey, w.minutes, 'SDEX'),
            calculateVWAP(pairKey, w.minutes, 'AMM'),
            calculateOHLCV(pairKey, w.minutes),
          ])

          if (vwap === 0) continue

          await prisma.priceAggregate.upsert({
            where: { pairKey_window_bucket: { pairKey, window: w.key, bucket } },
            create: {
              pairKey, window: w.key, bucket,
              vwap, sdexVwap: sdexVwap || null, ammVwap: ammVwap || null,
              volume: ohlcv.volume, tradeCount: ohlcv.tradeCount,
              openPrice: ohlcv.open || null, closePrice: ohlcv.close || null,
              highPrice: ohlcv.high || null, lowPrice: ohlcv.low || null,
            },
            update: {
              vwap, sdexVwap: sdexVwap || null, ammVwap: ammVwap || null,
              volume: ohlcv.volume, tradeCount: ohlcv.tradeCount,
              closePrice: ohlcv.close || null, highPrice: ohlcv.high || null, lowPrice: ohlcv.low || null,
            },
          })
        }

        console.log(`[aggregator] Refreshed ${pairKey}: price=${agg.price.toFixed(6)}, route=${route.route}`)
      } catch (err) {
        console.error(`[aggregator] Failed for ${pairKey}:`, (err as Error).message)
      }
    },
    { connection: redisConnection(), concurrency: 5 }
  )

  worker.on('failed', (job, err) => {
    console.error(`[aggregator] Job failed:`, err.message)
  })

  return worker
}

export async function scheduleAggregateRefresh(queue: Queue) {
  // Repeat every 60 seconds for each watched pair
  for (const pair of config.pairs) {
    await queue.add(
      'refresh',
      { pairKey: pair.pairKey, pair },
      { repeat: { every: 60_000 }, jobId: `refresh:${pair.pairKey}` }
    )
    // Also run immediately on startup
    await queue.add('refresh', { pairKey: pair.pairKey, pair })
  }
}
