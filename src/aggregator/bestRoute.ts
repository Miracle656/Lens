import { Horizon } from '@stellar/stellar-sdk'
import { config } from '../config'
import type { AssetId, RouteInfo } from '../types'
import { pgPool } from '../db'

const horizonServer = new Horizon.Server(config.horizon.url)

function assetIdToStellar(asset: AssetId) {
  const { Asset } = require('@stellar/stellar-sdk')
  if (!asset.issuer) return Asset.native()
  return new Asset(asset.code, asset.issuer)
}

async function getAMMPrice(pairKey: string, amount: number): Promise<number> {
  // Get latest pool snapshot for this pair
  const result = await pgPool.query(
    `SELECT reserve_a, reserve_b, fee_bp
     FROM pool_snapshots
     WHERE asset_a || ':' || COALESCE(asset_b, 'native') = ANY(
       SELECT unnest(string_to_array($1, '/'))
     )
     ORDER BY timestamp DESC
     LIMIT 1`,
    [pairKey]
  )
  if (!result.rows[0]) return 0

  const { reserve_a, reserve_b, fee_bp } = result.rows[0]
  const rA = parseFloat(reserve_a)
  const rB = parseFloat(reserve_b)
  const fee = 1 - (parseInt(fee_bp) / 10000)

  // Constant product formula: output = (reserveB * amount * fee) / (reserveA + amount * fee)
  const effectiveInput = amount * fee
  const output = (rB * effectiveInput) / (rA + effectiveInput)
  return output / amount  // price per unit
}

async function getSDEXPrice(assetA: AssetId, assetB: AssetId, amount: number): Promise<number> {
  try {
    const stellarAssetA = assetIdToStellar(assetA)
    const stellarAssetB = assetIdToStellar(assetB)
    const paths = await horizonServer
      .strictSendPaths(stellarAssetA, amount.toString(), [stellarAssetB])
      .call()
    if (paths.records.length === 0) return 0
    const best = paths.records[0]
    return parseFloat(best.destination_amount) / amount
  } catch {
    return 0
  }
}

export async function getBestRoute(
  assetA: AssetId,
  assetB: AssetId,
  pairKey: string,
  amount: number = 1000
): Promise<RouteInfo> {
  const [sdexPrice, ammPrice] = await Promise.all([
    getSDEXPrice(assetA, assetB, amount),
    getAMMPrice(pairKey, amount),
  ])

  let route: RouteInfo['route'] = 'UNKNOWN'
  let estimatedOutput = 0
  let recommendation = 'Insufficient liquidity data'

  if (sdexPrice === 0 && ammPrice === 0) {
    route = 'UNKNOWN'
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
      recommendation = diff < 0.001 ? 'Prices within 0.1% — either route suitable' : 'SPLIT may reduce slippage for large orders'
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

  const spotPrice = Math.max(sdexPrice, ammPrice)
  const slippagePct = spotPrice > 0 ? Math.abs((estimatedOutput / amount - spotPrice) / spotPrice * 100) : 0

  return { route, sdexPrice, ammPrice, estimatedOutput, slippagePct, recommendation }
}
