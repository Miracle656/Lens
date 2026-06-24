import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import WebSocket from 'ws'

import { registerWebSocket } from '../../src/api/websocket'
import { priceEmitter, PRICE_UPDATE } from '../../src/events'

describe('WebSocket subscription full cycle', () => {
  let app: ReturnType<typeof Fastify>
  let port: number

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await registerWebSocket(app)
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = (app.server.address() as any).port
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('connects → subscribes → receives updates → disconnects', async () => {
    const before = priceEmitter.listenerCount(PRICE_UPDATE)

    const messages: string[] = []
    const waiters: Array<(msg: string) => void> = []

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    // Attach message listener before awaiting open to avoid the race where the
    // server sends the status message synchronously on connect.
    ws.on('message', (data) => {
      const msg = data.toString()
      const waiter = waiters.shift()
      if (waiter) waiter(msg)
      else messages.push(msg)
    })

    const nextMessage = () =>
      new Promise<string>((resolve) => {
        const buffered = messages.shift()
        if (buffered !== undefined) resolve(buffered)
        else waiters.push(resolve)
      })

    // 1. Connect
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    // 2. Receive initial status (may already be buffered)
    const first = JSON.parse(await nextMessage())
    expect(first.type).toBe('status')
    expect(first.message).toBe('Streaming active')

    // 3. Listener should now be registered server-side
    expect(priceEmitter.listenerCount(PRICE_UPDATE)).toBe(before + 1)

    // 4. Emit a price update and verify it's received
    const event = {
      assetA: 'XLM',
      assetB: 'USDC',
      previousPrice: 1.0,
      currentPrice: 1.2345,
      timestamp: new Date(),
    }
    priceEmitter.emit(PRICE_UPDATE, event)

    const next = JSON.parse(await nextMessage())
    expect(next.type).toBe('price_update')
    expect(next.assetA).toBe(event.assetA)
    expect(next.assetB).toBe(event.assetB)
    expect(next.currentPrice).toBe(event.currentPrice)
    expect(new Date(next.timestamp).toISOString()).toBe(event.timestamp.toISOString())

    // 5. Disconnect and verify listener cleanup
    ws.close()
    await new Promise<void>((resolve) => ws.on('close', () => resolve()))

    expect(priceEmitter.listenerCount(PRICE_UPDATE)).toBe(before)
  })
})
