/**
 * Unit tests for the ENABLED_NETWORKS parsing used to decide which networks
 * the ingesters in index.ts should run against.
 */

const ENV_KEYS = ['ENABLED_NETWORKS', 'STELLAR_NETWORK']

async function loadEnabledNetworks() {
  vi.resetModules()
  return await import('../network/enabledNetworks')
}

describe('getEnabledNetworks', () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key]
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
  })

  it('falls back to just the active network when ENABLED_NETWORKS is unset', async () => {
    delete process.env.ENABLED_NETWORKS
    process.env.STELLAR_NETWORK = 'testnet'

    const { getEnabledNetworks } = await loadEnabledNetworks()

    expect(getEnabledNetworks()).toEqual(['testnet'])
  })

  it('falls back to the active mainnet when STELLAR_NETWORK=mainnet and ENABLED_NETWORKS is unset', async () => {
    delete process.env.ENABLED_NETWORKS
    process.env.STELLAR_NETWORK = 'mainnet'

    const { getEnabledNetworks } = await loadEnabledNetworks()

    expect(getEnabledNetworks()).toEqual(['mainnet'])
  })

  it('parses a comma-separated list of both networks', async () => {
    process.env.ENABLED_NETWORKS = 'testnet,mainnet'

    const { getEnabledNetworks } = await loadEnabledNetworks()

    expect(getEnabledNetworks()).toEqual(['testnet', 'mainnet'])
  })

  it('trims whitespace and lowercases network names', async () => {
    process.env.ENABLED_NETWORKS = ' Testnet , MAINNET '

    const { getEnabledNetworks } = await loadEnabledNetworks()

    expect(getEnabledNetworks()).toEqual(['testnet', 'mainnet'])
  })

  it('dedupes repeated network names while preserving order', async () => {
    process.env.ENABLED_NETWORKS = 'mainnet,testnet,mainnet'

    const { getEnabledNetworks } = await loadEnabledNetworks()

    expect(getEnabledNetworks()).toEqual(['mainnet', 'testnet'])
  })

  it('ignores unrecognized network names and falls back to the active network if nothing valid remains', async () => {
    process.env.ENABLED_NETWORKS = 'devnet,futurenet'
    process.env.STELLAR_NETWORK = 'testnet'

    const { getEnabledNetworks } = await loadEnabledNetworks()

    expect(getEnabledNetworks()).toEqual(['testnet'])
  })
})
