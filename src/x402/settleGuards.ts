import type { FastifyRequest } from 'fastify'
import { rpc, TransactionBuilder } from '@stellar/stellar-sdk'
import { getNetworkConfig, type NetworkName } from '../config'
import { redis } from '../redis'

/**
 * Hardening controls for POST /settle (#147): per-settlement fee ceiling,
 * rolling daily spend ceiling (per network), and an optional caller allow-list.
 *
 * Fail closed on spend-store outages — a silent Redis failure must not unlock
 * unlimited sponsored settling.
 */

export const FACILITATOR_DECLINED = 'facilitator_declined' as const

export type GuardRefusalReason =
  | 'fee_cap'
  | 'daily_cap'
  | 'caller_not_allowed'
  | 'store_unavailable'
  | 'fee_unreadable'

export interface GuardRefusal {
  ok: false
  reason: GuardRefusalReason
  errorMessage: string
  feeStroops?: number
}

export interface FeeOk {
  ok: true
  feeStroops: number
}

/** Minimal Redis surface so unit tests can substitute an in-memory store. */
export interface SpendStore {
  incrby(key: string, n: number): Promise<number>
  decrby(key: string, n: number): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

/**
 * Optional allow-list of resource-server origins / caller ids.
 * Empty (default) preserves open settle behaviour for the demo path.
 */
export function getAllowedCallers(): string[] {
  const raw = process.env.FACILITATOR_ALLOWED_ORIGINS ?? ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Resolves the caller identity from Origin or x-facilitator-caller.
 * Allow-list match is exact string equality against the configured entries.
 */
export function resolveCallerIdentity(req: FastifyRequest): string {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : ''
  if (origin) return origin
  const caller = req.headers['x-facilitator-caller']
  if (typeof caller === 'string' && caller.trim()) return caller.trim()
  return ''
}

export function assertCallerAllowed(req: FastifyRequest): GuardRefusal | null {
  const allowed = getAllowedCallers()
  if (allowed.length === 0) return null

  const identity = resolveCallerIdentity(req)
  if (identity && allowed.includes(identity)) return null

  return {
    ok: false,
    reason: 'caller_not_allowed',
    errorMessage: identity
      ? `Caller "${identity}" is not on FACILITATOR_ALLOWED_ORIGINS.`
      : 'Caller identity required when FACILITATOR_ALLOWED_ORIGINS is set (Origin or x-facilitator-caller).',
  }
}

/**
 * Reads the fee (stroops) the envelope declares. This is **not** the amount the
 * facilitator sponsors: `ExactStellarScheme.settle()` discards the envelope and
 * rebuilds the transaction on the facilitator's own account, paying
 * `minResourceFee + BASE_FEE` from its own simulation. The declared fee is
 * caller-supplied and never reaches a ledger, so it must not be used to account
 * for spend (see {@link reserveDailySpend}). It is still worth reading here
 * because a payload declaring a fee above the per-settlement cap is malformed
 * and can be refused cheaply, before the scheme simulates it.
 */
export function extractFeeStroops(transactionXdr: string, network: NetworkName): number | null {
  try {
    const passphrase = getNetworkConfig(network).network.passphrase
    const tx = TransactionBuilder.fromXDR(transactionXdr, passphrase)
    const fee = parseInt(tx.fee, 10)
    return Number.isFinite(fee) && fee >= 0 ? fee : null
  } catch {
    return null
  }
}

/**
 * Per-settlement fee ceiling — rejects before any ledger submission or daily
 * reservation. Independent of the rate limiter (which bounds frequency, not
 * balance).
 *
 * This compares the *caller-declared* envelope fee, which the scheme discards;
 * the authoritative per-settlement bound is `maxTransactionFeeStroops`, which
 * `ExactStellarScheme.verify()` enforces against its own simulation. The check
 * here is therefore only a cheap malformed-payload guard, not the spend control
 * — the daily ledger books the worst case instead (see {@link reserveDailySpend}).
 */
export function assertFeeWithinCap(transactionXdr: string, network: NetworkName): FeeOk | GuardRefusal {
  const feeStroops = extractFeeStroops(transactionXdr, network)
  if (feeStroops === null) {
    return {
      ok: false,
      reason: 'fee_unreadable',
      errorMessage: 'Could not read transaction fee from payment payload.',
    }
  }

  const perSettlementCap = getNetworkConfig(network).facilitator.feeStroops
  if (feeStroops > perSettlementCap) {
    return {
      ok: false,
      reason: 'fee_cap',
      feeStroops,
      errorMessage: `Settlement fee ${feeStroops} stroops exceeds per-settlement cap ${perSettlementCap} for ${network}.`,
    }
  }

  return { ok: true, feeStroops }
}

function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

export function dailySpendKey(network: NetworkName, day = utcDayKey()): string {
  return `lens:facilitator:daily-spend:${network}:${day}`
}

/**
 * Atomically reserves `amountStroops` against the network's rolling daily
 * ceiling. Increments first, then rolls back if the new total exceeds the
 * ceiling — so concurrent settles cannot race past the cap.
 *
 * `amountStroops` must be the *worst case* the facilitator can sponsor for one
 * settlement (`getNetworkConfig(network).facilitator.feeStroops`), never the
 * caller-declared envelope fee: the scheme rebuilds the transaction and pays
 * `minResourceFee + BASE_FEE`, so a caller can declare `fee: 100` while the
 * facilitator sponsors 50000. Booking the declared number under-counts by up to
 * the ratio of the two caps and lets the control be evaded by the party it
 * bounds. The reservation is reconciled down to the fee actually charged after
 * a successful settle (see {@link reconcileDailySpend}).
 *
 * Per-network keys: exhausting testnet does not block mainnet.
 * Fail closed: any store error refuses the settle.
 */
export async function reserveDailySpend(
  network: NetworkName,
  amountStroops: number,
  ceilingStroops: number,
  store: SpendStore = redis,
): Promise<GuardRefusal | { ok: true }> {
  const key = dailySpendKey(network)
  try {
    const newTotal = await store.incrby(key, amountStroops)
    // Survive process restart; TTL covers a UTC day boundary with margin.
    try {
      await store.expire(key, 60 * 60 * 48)
    } catch (expireErr) {
      // The increment landed but the TTL did not, so this reservation would
      // never expire and the ceiling would drift down permanently. Undo it
      // before failing closed.
      await store.decrby(key, amountStroops).catch(() => undefined)
      throw expireErr
    }

    if (newTotal > ceilingStroops) {
      await store.decrby(key, amountStroops)
      return {
        ok: false,
        reason: 'daily_cap',
        feeStroops: amountStroops,
        errorMessage: `Daily facilitator spend ceiling reached for ${network} (${ceilingStroops} stroops).`,
      }
    }
    return { ok: true }
  } catch (err) {
    // Fail closed, but never echo the driver error to the caller: /settle is a
    // public route and an ioredis failure reads
    // "connect ECONNREFUSED <host>:<port>", which is internal topology. The
    // detail stays in the server log.
    console.error('[settleGuards] spend ledger unavailable; refusing settle', err)
    return {
      ok: false,
      reason: 'store_unavailable',
      feeStroops: amountStroops,
      errorMessage: 'Spend ledger unavailable; refusing settle (fail-closed).',
    }
  }
}

/** Releases a reservation when settlement aborts before submission. */
export async function releaseDailySpend(
  network: NetworkName,
  feeStroops: number,
  store: SpendStore = redis,
): Promise<void> {
  try {
    await store.decrby(dailySpendKey(network), feeStroops)
  } catch {
    // Best-effort rollback; the key expires in 48h regardless.
  }
}

/**
 * Best-effort downward reconciliation of a worst-case daily reservation.
 *
 * {@link reserveDailySpend} books the full per-settlement ceiling, so after a
 * successful settle we read the fee the ledger actually charged (`feeCharged`
 * from the transaction result) and release the unused headroom. The ledger's
 * number is authoritative; the reservation is only a conservative pre-charge.
 *
 * If the transaction cannot be read, or is not yet SUCCESS, the full
 * reservation stands — the ceiling over-counts rather than under-counts, which
 * is the safe direction. Best-effort by design: reconciliation must never turn
 * a successful settle into a failure.
 */
export async function reconcileDailySpend(
  network: NetworkName,
  reservedStroops: number,
  txHash: string,
  store: SpendStore = redis,
): Promise<void> {
  try {
    const server = new rpc.Server(getNetworkConfig(network).rpc.url)
    const tx = await server.getTransaction(txHash)
    if (tx.status !== 'SUCCESS') return

    // `resultXdr` is the TransactionResult; its `feeCharged` is an Int64 of the
    // stroops the ledger actually deducted.
    const feeCharged = Number(tx.resultXdr.feeCharged.toString())
    if (!Number.isSafeInteger(feeCharged) || feeCharged < 0) return

    const unused = reservedStroops - feeCharged
    if (unused > 0) await releaseDailySpend(network, unused, store)
  } catch {
    // Keep the conservative reservation when the ledger is unreadable.
  }
}
