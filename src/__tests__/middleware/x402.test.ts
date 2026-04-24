import { describe, it, expect, vi, beforeEach } from 'vitest'

// x402.ts reads env vars inside the plugin function, so set them before the app registers the plugin.
// We still need them here for the mock payment address used in test assertions.
const PAYMENT_ADDRESS = 'GPAYMENTADDRESS123456789012345678901234567890123456789012'

// ── All mock objects via vi.hoisted so they exist when vi.mock factories execute ──
const {
  mockVerify,
  mockSettle,
  mockInitialize,
  mockRegisterChain,
  MockResourceServer,
  MockFacilitatorClient,
  MockExactScheme,
} = vi.hoisted(() => {
  const mockVerify = vi.fn()
  const mockSettle = vi.fn().mockResolvedValue(undefined)
  const mockInitialize = vi.fn().mockResolvedValue(undefined)

  // .register() returns `this` for chaining
  const instance = {
    initialize: mockInitialize,
    verify: mockVerify,
    settle: mockSettle,
    register: vi.fn(),
  }
  instance.register.mockReturnValue(instance)
  const mockRegisterChain = instance

  // Constructor mocks — must be regular functions (not arrows) to support `new`
  function MockResourceServer() { return instance }
  function MockFacilitatorClient() { return {} }
  function MockExactScheme() { return {} }

  return { mockVerify, mockSettle, mockInitialize, mockRegisterChain, MockResourceServer, MockFacilitatorClient, MockExactScheme }
})

vi.mock('@x402/core/server', () => ({
  x402ResourceServer: MockResourceServer,
  HTTPFacilitatorClient: MockFacilitatorClient,
}))

vi.mock('@x402/stellar/exact/server', () => ({
  ExactStellarScheme: MockExactScheme,
}))

import Fastify from 'fastify'
import { registerX402 } from '../../middleware/x402'

// ── Helpers ───────────────────────────────────────────────────────────────────
async function buildApp() {
  process.env.ORACLE_PAYMENT_ADDRESS = PAYMENT_ADDRESS
  process.env.STELLAR_NETWORK = 'testnet'
  const app = Fastify({ logger: false })
  await app.register(registerX402)
  app.get('/price/test', async () => ({ ok: true }))
  app.get('/pools/test', async () => ({ ok: true }))
  app.get('/candles/test', async () => ({ ok: true }))
  app.get('/public', async () => ({ ok: true }))
  await app.ready()
  return app
}

function makePaymentHeader(overrides: Record<string, unknown> = {}): string {
  const payload = { scheme: 'exact', amount: '$0.10', recipient: PAYMENT_ADDRESS, ...overrides }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

beforeEach(() => {
  mockVerify.mockReset()
  mockSettle.mockReset().mockResolvedValue(undefined)
  mockInitialize.mockReset().mockResolvedValue(undefined)
  mockRegisterChain.register.mockReturnValue(mockRegisterChain)
})

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('x402 middleware', () => {
  it('returns 200 when payment header is valid', async () => {
    mockVerify.mockResolvedValue({ isValid: true })
    const app = await buildApp()

    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { 'x-payment': makePaymentHeader() },
    })

    expect(res.statusCode).toBe(200)
    expect(mockVerify).toHaveBeenCalledOnce()
  })

  it('returns 402 with x402Version and accepts body when payment header is missing', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/price/test' })

    expect(res.statusCode).toBe(402)
    const body = res.json()
    expect(body).toHaveProperty('x402Version', 1)
    expect(body).toHaveProperty('accepts')
    expect(body.accepts[0]).toHaveProperty('price', '$0.10')
    expect(body.accepts[0]).toHaveProperty('payTo', PAYMENT_ADDRESS)
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it('returns 402 when payment is for wrong amount', async () => {
    mockVerify.mockResolvedValue({ isValid: false, invalidReason: 'amount mismatch' })
    const app = await buildApp()

    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { 'x-payment': makePaymentHeader({ amount: '$0.01' }) },
    })

    expect(res.statusCode).toBe(402)
    expect(res.json()).toMatchObject({ error: 'Payment invalid', reason: 'amount mismatch' })
  })

  it('returns 402 when payment is for wrong recipient', async () => {
    mockVerify.mockResolvedValue({ isValid: false, invalidReason: 'recipient mismatch' })
    const app = await buildApp()

    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { 'x-payment': makePaymentHeader({ recipient: 'GWRONGADDRESS' }) },
    })

    expect(res.statusCode).toBe(402)
    expect(res.json()).toMatchObject({ error: 'Payment invalid', reason: 'recipient mismatch' })
  })

  it('does not gate non-matching routes', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/public' })

    expect(res.statusCode).toBe(200)
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it('gates /pools with $0.05 price requirement', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/pools/test' })

    expect(res.statusCode).toBe(402)
    expect(res.json().accepts[0]).toHaveProperty('price', '$0.05')
  })

  it('gates /candles with $0.05 price requirement', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/candles/test' })

    expect(res.statusCode).toBe(402)
    expect(res.json().accepts[0]).toHaveProperty('price', '$0.05')
  })

  it('settles payment asynchronously after successful verification', async () => {
    mockVerify.mockResolvedValue({ isValid: true })
    const app = await buildApp()

    await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { 'x-payment': makePaymentHeader() },
    })

    await new Promise(r => setTimeout(r, 20))
    expect(mockSettle).toHaveBeenCalledOnce()
  })
})
