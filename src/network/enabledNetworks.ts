import { activeNetwork, type NetworkName } from '../config'

/**
 * Networks the ingesters should run against, driven by the `ENABLED_NETWORKS`
 * env var (comma-separated, e.g. "testnet,mainnet"). Falls back to just the
 * currently active network (STELLAR_NETWORK, default "testnet") so a single-
 * network deployment starts exactly one instance of each ingester, not two.
 */
export function getEnabledNetworks(): NetworkName[] {
  const raw = process.env.ENABLED_NETWORKS?.trim()
  if (!raw) return [activeNetwork]

  const networks = raw
    .split(',')
    .map(n => n.trim().toLowerCase())
    .filter((n): n is NetworkName => n === 'testnet' || n === 'mainnet')

  // Dedupe while preserving order
  const unique = Array.from(new Set(networks))
  return unique.length > 0 ? unique : [activeNetwork]
}
