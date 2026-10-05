import { Queue, Worker } from 'bullmq'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getEnabledNetworks } from '../network/enabledNetworks'

const QUEUE_NAME = `${activeNetwork}:snapshot-retention`

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
 * Deletes one network's price_snapshots rows older than the retention window.
 * Returns the number of rows pruned. `network` defaults to the active network.
 * Exported separately from the worker so it can be unit tested and invoked
 * manually.
 */
export async function pruneOldSnapshots(
  retentionDays: number = SNAPSHOT_RETENTION_DAYS,
  network: NetworkName = activeNetwork
): Promise<number> {
  const result = await pgPool.query(
    `DELETE FROM price_snapshots
     WHERE network = $1 AND ts < NOW() - ($2 || ' days')::interval`,
    [network, retentionDays]
  )
  return result.rowCount ?? 0
}

/**
 * Prunes every network in `getEnabledNetworks()` and returns the pruned row
 * count per network. A failure on one network does not stop the others from
 * being pruned; the failures are rethrown together once all have been tried.
 */
export async function pruneAllNetworks(
  retentionDays: number = SNAPSHOT_RETENTION_DAYS
): Promise<Partial<Record<NetworkName, number>>> {
  const counts: Partial<Record<NetworkName, number>> = {}
  const errors: Error[] = []
  for (const network of getEnabledNetworks()) {
    try {
      counts[network] = await pruneOldSnapshots(retentionDays, network)
    } catch (err) {
      errors.push(new Error(`${network}: ${(err as Error).message}`))
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map(e => e.message).join('; '))
  }
  return counts
}

export function startSnapshotRetentionWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      try {
        const counts = await pruneAllNetworks()
        for (const [network, pruned] of Object.entries(counts)) {
          if (pruned > 0) console.log(`[snapshot-retention] pruned ${pruned} ${network} snapshot(s) older than ${SNAPSHOT_RETENTION_DAYS}d`)
        }
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
