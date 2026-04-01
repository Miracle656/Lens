import { PrismaClient } from '@prisma/client'
import { Pool } from 'pg'
import { config } from './config'

// Prisma for schema management + simple queries
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

// Raw pg pool for time-series queries (VWAP, aggregates)
export const pgPool = new Pool({ connectionString: config.db.url })

export async function upsertPricePoints(points: {
  assetA: string; assetB: string; pairKey: string; source: string
  poolId?: string; price: number; baseVolume: number; counterVolume: number
  ledger: number; timestamp: Date; eventId?: string
}[]): Promise<number> {
  if (points.length === 0) return 0
  let inserted = 0
  for (const p of points) {
    try {
      await prisma.pricePoint.upsert({
        where: { eventId: p.eventId ?? `${p.pairKey}-${p.ledger}-${p.timestamp.getTime()}-${Math.random()}` },
        create: {
          assetA: p.assetA,
          assetB: p.assetB,
          pairKey: p.pairKey,
          source: p.source,
          poolId: p.poolId,
          price: p.price,
          baseVolume: p.baseVolume,
          counterVolume: p.counterVolume,
          ledger: p.ledger,
          timestamp: p.timestamp,
          eventId: p.eventId,
        },
        update: {},
      })
      inserted++
    } catch {
      // skip duplicates
    }
  }
  return inserted
}

export async function getIndexerCursor(id: string): Promise<string | null> {
  const state = await prisma.indexerState.findUnique({ where: { id } })
  return state?.lastCursor ?? null
}

export async function setIndexerCursor(id: string, cursor: string, ledger?: number): Promise<void> {
  await prisma.indexerState.upsert({
    where: { id },
    create: { id, lastCursor: cursor, lastLedger: ledger, lastProcessedAt: new Date() },
    update: { lastCursor: cursor, lastLedger: ledger, lastProcessedAt: new Date() },
  })
}
