// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock('../db', () => ({
  prisma: {
    webhook: {
      create: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))

vi.mock('../events', () => ({
  priceEmitter: {
    emit: vi.fn(),
  },
  PRICE_UPDATE: 'price:update',
}))

import { createHmac } from 'crypto'
import Fastify from 'fastify'
import { prisma } from '../db'
import { registerWebhookRoutes } from '../routes/webhooks'
import { dispatchPriceUpdate } from '../webhookDispatcher'

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildApp() {
  const app = Fastify()
  return registerWebhookRoutes(app).then(() => app)
}

function verifySignature(payload: string, secret: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  return expected === signature
}

// ── Route Tests ───────────────────────────────────────────────────────────────
describe('POST /webhooks', () => {
  it('registers a webhook and returns id + secret', async () => {
    const app = await buildApp()
    const fakeWebhook = { id: 'abc-123', secret: 'deadbeef'.repeat(8) }
    ;(prisma.webhook.create as any).mockResolvedValue(fakeWebhook as any)

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'https://example.com/hook',
        assetA: 'XLM',
        assetB: 'USD',
        threshold: 0.10,
        direction: 'above',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.id).toBe('abc-123')
    expect(body.secret).toBeDefined()
  })

  it('rejects non-HTTPS URLs', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'http://example.com/hook',
        assetA: 'XLM',
        assetB: 'USD',
        threshold: 0.10,
        direction: 'above',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/HTTPS/)
  })
})

describe('DELETE /webhooks/:id', () => {
  it('deletes a webhook and returns 204', async () => {
    const app = await buildApp()
    ;(prisma.webhook.delete as any).mockResolvedValue({} as any)

    const res = await app.inject({ method: 'DELETE', url: '/webhooks/abc-123' })
    expect(res.statusCode).toBe(204)
  })
})

// ── Dispatcher Tests ──────────────────────────────────────────────────────────
describe('dispatchPriceUpdate', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    global.fetch = vi.fn()
  })

  it('fires webhook when price crosses above threshold', async () => {
    const secret = 'mysecret'
    ;(prisma.webhook.findMany as any).mockResolvedValue([
      { id: 'wh-1', url: 'https://hook.example.com', assetA: 'XLM', assetB: 'USD',
        threshold: 0.10, direction: 'above', secret, createdAt: new Date() },
    ] as any)

    let capturedBody = ''
    let capturedSig = ''
    ;(global.fetch as any).mockImplementation(async (_url: any, opts: any) => {
      capturedBody = opts.body
      capturedSig = opts.headers['X-Lens-Signature']
      return { ok: true, status: 200 } as Response
    })

    await dispatchPriceUpdate({ assetA: 'XLM', assetB: 'USD', previousPrice: 0.09, currentPrice: 0.11 })

    expect(global.fetch).toHaveBeenCalledOnce()
    expect(verifySignature(capturedBody, secret, capturedSig)).toBe(true)
  })

  it('does not fire webhook when price does not cross threshold', async () => {
    ;(prisma.webhook.findMany as any).mockResolvedValue([
      { id: 'wh-2', url: 'https://hook.example.com', assetA: 'XLM', assetB: 'USD',
        threshold: 0.10, direction: 'above', secret: 'x', createdAt: new Date() },
    ] as any)

    await dispatchPriceUpdate({ assetA: 'XLM', assetB: 'USD', previousPrice: 0.11, currentPrice: 0.12 })

    expect(global.fetch).not.toHaveBeenCalled()
  })
})