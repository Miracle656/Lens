import { Asset } from '@stellar/stellar-sdk'
import { activeNetwork, type NetworkName } from '../config'
import { getHorizonServer, resetNetworkClients } from '../network/clients'
import type { AssetId, RouteInfo } from '../types'
import { pgPool } from '../db'
import { calculateAMMSpotPrice } from '../pricing/depth'

function assetIdToStellar(asset: AssetId) {
  if (!asset.issuer) return Asset.native()
  return new Asset(asset.code, asset.issuer)
}

// AMM pricing reads price_points/pool_snapshots, which have no network column
// yet — that is the deeper aggregation-layer work tracked separately. SDEX
// pricing is a live Horizon call, so it is genuinely per-network today.
async function getAMMPrice(
  pairKey: string,
  amount: number
): Promise<{ price: number; spotPrice: number }> {
  // Get latest pool snapshot via pool_id (pairKey indexes price_points correctly)
  const result = await pgPool.query(
    `SELECT DISTINCT ON (ps.pool_id) ps.reserve_a, ps.reserve_b, ps.fee_bp
     FROM pool_snapshots ps
     WHERE ps.pool_id IN (
       SELECT DISTINCT pool_id FROM price_points
       WHERE pair_key = $1 AND source = 'AMM' AND pool_id IS NOT NULL
     )
     ORDER BY ps.pool_id, ps.timestamp DESC
     LIMIT 1`,
    [pairKey]
  )
  if (!result.rows[0]) return { price: 0, spotPrice: 0 }

  const { reserve_a, reserve_b, fee_bp } = result.rows[0]
  const rA = parseFloat(reserve_a)
  const rB = parseFloat(reserve_b)
  const fee = 1 - (parseInt(fee_bp) / 10000)

  // Constant product formula: output = (reserveB * amount * fee) / (reserveA + amount * fee)
  const effectiveInput = amount * fee
  const output = (rB * effectiveInput) / (rA + effectiveInput)
  // spotPrice is the reserve-ratio marginal price (no size, no fee); price is
  // the average execution price for `amount` on the constant-product curve.
  return { price: output / amount, spotPrice: calculateAMMSpotPrice(rA, rB) }
}

/**
 * Test-only: clears the memoised per-network Horizon clients between cases.
 * Kept as a re-export so existing tests keep their import path; the clients
 * themselves now live in network/clients.ts.
 */
export function _resetHorizonServers(): void {
  resetNetworkClients()
}

async function getSDEXPrice(
  assetA: AssetId,
  assetB: AssetId,
  amount: number,
  network: NetworkName
): Promise<number> {
  try {
    const stellarAssetA = assetIdToStellar(assetA)
    const stellarAssetB = assetIdToStellar(assetB)
    const paths = await getHorizonServer(network)
      .strictSendPaths(stellarAssetA, amount.toString(), [stellarAssetB])
      .call()
    if (paths.records.length === 0) return 0
    const best = paths.records[0]
    return parseFloat(best.destination_amount) / amount
  } catch (err) {
    return 0
  }
}

export async function getBestRoute(
  assetA: AssetId,
  assetB: AssetId,
  pairKey: string,
  amount: number = 1000,
  network: NetworkName = activeNetwork
): Promise<RouteInfo> {
  const [sdexPrice, amm] = await Promise.all([
    getSDEXPrice(assetA, assetB, amount, network),
    getAMMPrice(pairKey, amount),
  ])
  const ammPrice = amm.price

  let route: RouteInfo['route'] = 'UNKNOWN'
  let estimatedOutput = 0
  let recommendation = 'Insufficient liquidity data'

  if (sdexPrice === 0 && ammPrice === 0) {
    throw new Error("No pricing data available")
  } else if (sdexPrice === 0) {
    route = 'AMM'
    estimatedOutput = ammPrice * amount
    recommendation = 'Only AMM liquidity available'
  } else if (ammPrice === 0) {
    route = 'SDEX'
    estimatedOutput = sdexPrice * amount
    recommendation = 'Only SDEX liquidity available'
  } else {
    const diff = Math.abs(sdexPrice - ammPrice) / Math.max(sdexPrice, ammPrice)
    if (diff < 0.001) {
      // Within 0.1% — suggest split for large orders
      route = amount > 10000 ? 'SPLIT' : (sdexPrice >= ammPrice ? 'SDEX' : 'AMM')
      estimatedOutput = Math.max(sdexPrice, ammPrice) * amount
      recommendation = 'Prices within 0.1% — either route suitable'
    } else if (sdexPrice > ammPrice) {
      route = 'SDEX'
      estimatedOutput = sdexPrice * amount
      recommendation = `SDEX offers ${((sdexPrice - ammPrice) / ammPrice * 100).toFixed(2)}% better rate`
    } else {
      route = 'AMM'
      estimatedOutput = ammPrice * amount
      recommendation = `AMM offers ${((ammPrice - sdexPrice) / sdexPrice * 100).toFixed(2)}% better rate`
    }
  }

  // Slippage is the shortfall of the execution price against a true spot
  // reference: the AMM reserve-ratio price, which does not depend on the trade
  // size. (The old code compared the execution price with itself, so it was
  // always 0.) With no AMM pool there is no size-independent reference for
  // SDEX, so slippage is reported as 0 rather than guessed. An execution price
  // at or above spot is not slippage, hence the clamp.
  const spotPrice = amm.spotPrice
  const executionPrice = amount > 0 ? estimatedOutput / amount : 0
  const slippagePct =
    spotPrice > 0 ? Math.max(0, ((spotPrice - executionPrice) / spotPrice) * 100) : 0

  return { route, sdexPrice, ammPrice, estimatedOutput, slippagePct, recommendation }
}
