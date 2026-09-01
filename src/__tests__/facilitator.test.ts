import { vi, describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { registerFacilitatorRoutes } from '../api/facilitator'

const mockVerify = vi.fn()
const mockSettle = vi.fn()
const mockGetSupported = vi.fn()
const mockRegister = vi.fn()

vi.mock('@x402/core/facilitator', () => ({
  x402Facilitator: class {
    register = mockRegister
    verify = mockVerify
    settle = mockSettle
    getSupported = mockGetSupported
  }
}))

vi.mock('@x402/stellar/exact/facilitator', () => ({
  ExactStellarScheme: vi.fn(),
}))

vi.mock('@x402/stellar', () => ({
  createEd25519Signer: vi.fn(),
}))

vi.mock('../config', () => ({
  getNetworkConfig: vi.fn(() => ({
    rpc: { url: 'http://localhost' },
    facilitator: { secretKey: 'S_MOCK_SECRET', feeStroops: 50000 },
  }))
}))

describe('Facilitator endpoints', () => {
  let app: any

  beforeEach(async () => {
    vi.clearAllMocks()
    app = Fastify()
    await app.register(registerFacilitatorRoutes)
    await app.ready()
  })

  it('GET /supported returns supported kinds', async () => {
    mockGetSupported.mockReturnValue({ kinds: [{ scheme: 'exact' }] })
    const res = await app.inject({ method: 'GET', url: '/supported' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ kinds: [{ scheme: 'exact' }] })
  })

  it('POST /verify returns verify response', async () => {
    mockVerify.mockResolvedValue({ isValid: true })
    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      payload: { paymentPayload: {}, paymentRequirements: {} }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ isValid: true })
  })

  it('POST /verify returns 400 if verify returns isValid: false', async () => {
    mockVerify.mockResolvedValue({ isValid: false, invalidReason: 'bad_sig' })
    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      payload: { paymentPayload: {}, paymentRequirements: {} }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ isValid: false, invalidReason: 'bad_sig' })
  })

  it('POST /verify returns 400 if payload is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      payload: {}
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toHaveProperty('isValid', false)
  })

  it('POST /verify passes caught structured error response', async () => {
    const error: any = new Error('Verification failed')
    error.statusCode = 422
    error.response = { isValid: false, invalidReason: 'expired' }
    mockVerify.mockRejectedValue(error)

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      payload: { paymentPayload: {}, paymentRequirements: {} }
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ isValid: false, invalidReason: 'expired' })
  })

  // POST /settle is no longer registered by this plugin — it moved to
  // src/routes/facilitator.ts with #149, which made it idempotent. The three
  // settle cases that used to live here (success passthrough, success:false
  // mapping, structured thrown error) are covered by facilitatorSettle.test.ts
  // alongside the replay, in-flight-resolution and malformed-payload cases the
  // old handler had no behaviour for.
})
