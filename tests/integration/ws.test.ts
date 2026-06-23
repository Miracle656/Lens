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
    const address = app.server?.address() as any
    port = address.port
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('connects → subscribes → receives updates → disconnects', async () => {
    const before = priceEmitter.listenerCount(PRICE_UPDATE)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', (err) => reject(err))
    })

    // First message should be streaming status
    const firstRaw = await new Promise<string>(resolve => ws.once('message', (data) => resolve(data.toString())))
    const first = JSON.parse(firstRaw)
    expect(first.type).toBe('status')
    expect(first.message).toBe('Streaming active')

    // Listener registered on the server
    expect(priceEmitter.listenerCount(PRICE_UPDATE)).toBe(before + 1)

    // Emit a price update and verify it's received
    const event = {
      assetA: 'XLM',
      assetB: 'USDC',
      previousPrice: 1.0,
      currentPrice: 1.2345,
      timestamp: new Date()
    }

    const nextRaw = new Promise<string>(resolve => ws.once('message', (data) => resolve(data.toString())))
    priceEmitter.emit(PRICE_UPDATE, event)
    const next = JSON.parse(await nextRaw)

    expect(next.type).toBe('price_update')
    expect(next.assetA).toBe(event.assetA)
    expect(next.assetB).toBe(event.assetB)
    expect(next.currentPrice).toBe(event.currentPrice)
    expect(new Date(next.timestamp).toISOString()).toBe(event.timestamp.toISOString())

    // Close connection and ensure listener cleanup
    ws.close()
    await new Promise<void>(resolve => ws.on('close', () => resolve()))

    expect(priceEmitter.listenerCount(PRICE_UPDATE)).toBe(before)
  })
})
