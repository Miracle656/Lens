/**
 * Unit tests for per-network venue configuration (Soroswap / Aquarius / Reflector).
 *
 * Each test resets modules and re-imports `../config` after mutating
 * `process.env` so the lazy per-network cache in config.ts is rebuilt from
 * the env vars set for that test.
 */

const ENV_KEYS = [
  'STELLAR_NETWORK',
  'SOROSWAP_ENABLED_TESTNET',
  'SOROSWAP_ENABLED_MAINNET',
  'SOROSWAP_TOKEN_LIST_URL',
  'SOROSWAP_TOKEN_LIST_URL_TESTNET',
  'AQUARIUS_ENABLED_TESTNET',
  'AQUARIUS_ENABLED_MAINNET',
  'AQUARIUS_API_URL',
  'REFLECTOR_CONTRACT_ID_TESTNET',
  'REFLECTOR_CONTRACT_ID_MAINNET',
  'REFLECTOR_ENABLED_TESTNET',
]

async function loadConfig() {
  vi.resetModules()
  return await import('../config')
}

describe('per-network venue config', () => {
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

  it('defaults Aquarius to disabled on testnet and enabled on mainnet', async () => {
    delete process.env.AQUARIUS_ENABLED_TESTNET
    delete process.env.AQUARIUS_ENABLED_MAINNET

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').aquarius.enabled).toBe(false)
    expect(getNetworkConfig('mainnet').aquarius.enabled).toBe(true)
  })

  it('respects an explicit AQUARIUS_ENABLED_TESTNET=true override', async () => {
    process.env.AQUARIUS_ENABLED_TESTNET = 'true'

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').aquarius.enabled).toBe(true)
  })

  it('defaults Soroswap to enabled on both networks', async () => {
    delete process.env.SOROSWAP_ENABLED_TESTNET
    delete process.env.SOROSWAP_ENABLED_MAINNET

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').soroswap.enabled).toBe(true)
    expect(getNetworkConfig('mainnet').soroswap.enabled).toBe(true)
  })

  it('disables Soroswap on a network when explicitly set to false', async () => {
    process.env.SOROSWAP_ENABLED_TESTNET = 'false'

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').soroswap.enabled).toBe(false)
  })

  it('resolves a per-network token-list URL override before falling back to the shared default', async () => {
    delete process.env.SOROSWAP_TOKEN_LIST_URL
    process.env.SOROSWAP_TOKEN_LIST_URL_TESTNET = 'https://example.com/testnet-tokens.json'

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').soroswap.tokenListUrl).toBe(
      'https://example.com/testnet-tokens.json'
    )
    expect(getNetworkConfig('mainnet').soroswap.tokenListUrl).toBe(
      'https://raw.githubusercontent.com/soroswap/token-list/main/tokenList.json'
    )
  })

  it('disables the Reflector oracle when no contract id is configured for the network', async () => {
    delete process.env.REFLECTOR_CONTRACT_ID_TESTNET

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').oracle.reflectorContractId).toBe('')
    expect(getNetworkConfig('testnet').oracle.enabled).toBe(false)
  })

  it('enables the Reflector oracle on mainnet where a default contract id exists', async () => {
    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('mainnet').oracle.reflectorContractId).not.toBe('')
    expect(getNetworkConfig('mainnet').oracle.enabled).toBe(true)
  })

  it('resolves a custom Aquarius API URL override', async () => {
    process.env.AQUARIUS_API_URL = 'https://example.com/aquarius/'

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').aquarius.apiUrl).toBe('https://example.com/aquarius/')
    expect(getNetworkConfig('mainnet').aquarius.apiUrl).toBe('https://example.com/aquarius/')
  })
})
