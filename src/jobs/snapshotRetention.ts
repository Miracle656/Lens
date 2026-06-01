import { Queue, Worker } from 'bullmq'
import { pgPool } from '../db'

const QUEUE_NAME = 'snapshot-retention'

/** Snapshots older than this many days are pruned by the retention job. */
export const SNAPSHOT_RETENTION_DAYS = 30

function redisConnection() {
  const url = process.env.REDIS_URL
  if (url) return { url }
  return { host: 'localhost', port: 6379 }
}

export function createSnapshotRetentionQueue() {
  return new Queue(QUEUE_NAME, { connection: redisConnection() })
}

/**
 * Deletes price_snapshots rows older than the retention window. Returns the
 * number of rows pruned. Exported separately from the worker so it can be unit
 * tested and invoked manually.
 */
export async function pruneOldSnapshots(retentionDays: number = SNAPSHOT_RETENTION_DAYS): Promise<number> {
  const result = await pgPool.query(
    `DELETE FROM price_snapshots
     WHERE ts < NOW() - ($1 || ' days')::interval`,
    [retentionDays]
  )
  return result.rowCount ?? 0
}

export function startSnapshotRetentionWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      try {
        const pruned = await pruneOldSnapshots()
        if (pruned > 0) console.log(`[snapshot-retention] pruned ${pruned} snapshot(s) older than ${SNAPSHOT_RETENTION_DAYS}d`)
      } catch (err) {
        console.error('[snapshot-retention] prune failed:', (err as Error).message)
      }
    },
    { connection: redisConnection(), concurrency: 1 }
  )

  worker.on('failed', (_job, err) => {
    console.error('[snapshot-retention] Job failed:', err.message)
  })

  return worker
}

/** Schedules the retention prune to run hourly (and once on startup). */
export async function scheduleSnapshotRetention(queue: Queue) {
  await queue.add(
    'prune',
    {},
    { repeat: { every: 60 * 60 * 1000 }, jobId: 'snapshot-retention:prune' }
  )
  await queue.add('prune', {})
}
