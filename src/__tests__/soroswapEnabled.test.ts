/**
 * Verifies the Soroswap ingester respects the per-network enable flag,
 * skipping the polling loop entirely when Soroswap has no usable deployment
 * on the given network.
 */

const mocks = vi.hoisted(() => ({
  networkConfigs: {
    testnet: {
      soroswap: {
        enabled: false,
        factoryAddress: 'CFACTORY_TESTNET',
        tokenListUrl: 'https://example.com/tokens.json',
        pollIntervalMs: 60000,
      },
      network: { passphrase: 'Test SDF Network ; September 2015' },
      rpc: { url: 'https://soroban-testnet.stellar.org' },
    },
    mainnet: {
      soroswap: {
        enabled: true,
        factoryAddress: 'CFACTORY_MAINNET',
        tokenListUrl: 'https://example.com/tokens.json',
        pollIntervalMs: 60000,
      },
      network: { passphrase: 'Public Global Stellar Network ; September 2015' },
      rpc: { url: 'https://mainnet.sorobanrpc.com' },
    },
  },
  pairsRegistry: {
    getActivePairs: vi.fn().mockReturnValue([]),
  },
}))

vi.mock('../config', () => ({
  activeNetwork: 'mainnet',
  getNetworkConfig: (network: 'testnet' | 'mainnet') => mocks.networkConfigs[network],
}))
vi.mock('../network/clients', () => ({
  getRpcServer: vi.fn(),
  getHorizonServer: vi.fn(),
}))
vi.mock('../pairsRegistry', () => mocks.pairsRegistry)
vi.mock('../db', () => ({ upsertPricePoints: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../webhookDispatcher', () => ({ dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined) }))

import { startSoroswapIngester } from '../ingesters/soroswap'

describe('startSoroswapIngester', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not start the polling loop when Soroswap is disabled on the given network', async () => {
    await startSoroswapIngester('testnet')

    expect(mocks.pairsRegistry.getActivePairs).not.toHaveBeenCalled()
  })
})
