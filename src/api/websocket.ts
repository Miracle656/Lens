import type { FastifyInstance, FastifyRequest } from 'fastify'
import websocket from '@fastify/websocket'
import { priceEmitter, PRICE_UPDATE, PriceUpdateEvent } from '../events'
// @ts-ignore
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server'
// @ts-ignore
import { ExactStellarScheme } from '@x402/stellar/exact/server'

const PAYMENT_ADDRESS = process.env.ORACLE_PAYMENT_ADDRESS
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? 'https://facilitator.stellar.org'
const NETWORK = (process.env.STELLAR_NETWORK === 'mainnet' ? 'stellar:pubnet' : 'stellar:testnet') as string

export async function registerWebSocket(app: FastifyInstance) {
  await app.register(websocket)

  let resourceServer: any = null
  if (PAYMENT_ADDRESS) {
    try {
      const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL })
      resourceServer = new x402ResourceServer(facilitatorClient)
        .register(NETWORK as `${string}:${string}`, new ExactStellarScheme())
      await resourceServer.initialize()
    } catch (err) {
      app.log.warn(`[ws] x402 init failed, streaming without payment gating: ${(err as Error).message}`)
      resourceServer = null
    }
  }

  // @fastify/websocket v11: handler receives (socket, req) directly — no connection wrapper
  app.get('/ws', { websocket: true, config: { public: true } }, (socket: any, req: FastifyRequest) => {
    app.log.info('[ws] New connection attempt')

    const paymentHeader = (req.headers['x-payment'] as string) || (req.query as any).payment

    const requirements = {
      scheme: 'exact' as const,
      price: '$0.50',
      network: NETWORK,
      payTo: PAYMENT_ADDRESS!,
    }

    if (!PAYMENT_ADDRESS || !resourceServer) {
      app.log.warn('[ws] x402 disabled (PAYMENT_ADDRESS missing or x402 init failed)')
    } else if (!paymentHeader) {
      socket.send(JSON.stringify({
        type: 'error',
        status: 402,
        message: 'Payment required for real-time streaming',
        requirements
      }))
      socket.close()
      return
    } else {
      verifyPayment(paymentHeader, requirements, resourceServer)
        .then(isValid => {
          if (!isValid) {
            socket.send(JSON.stringify({ type: 'error', message: 'Invalid payment' }))
            socket.close()
          } else {
            setupStream(socket, req)
          }
        })
        .catch(err => {
          socket.send(JSON.stringify({ type: 'error', message: err.message }))
          socket.close()
        })
      return
    }

    setupStream(socket, req)
  })

  function setupStream(socket: any, req: FastifyRequest) {
    app.log.info('[ws] Connection authorized')
    socket.send(JSON.stringify({ type: 'status', message: 'Streaming active' }))

    const onPriceUpdate = (event: PriceUpdateEvent) => {
      if (socket.readyState === 1) { // OPEN
        socket.send(JSON.stringify({ type: 'price_update', ...event }))
      }
    }

    priceEmitter.on(PRICE_UPDATE, onPriceUpdate)

    socket.on('close', () => {
      app.log.info('[ws] Connection closed')
      priceEmitter.off(PRICE_UPDATE, onPriceUpdate)
    })
  }
}

async function verifyPayment(paymentHeader: string, requirements: any, resourceServer: any): Promise<boolean> {
  try {
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString())
    } catch {
      payload = JSON.parse(paymentHeader)
    }

    const result = await resourceServer.verify(payload, requirements)
    if (result.isValid) {
      resourceServer.settle(payload, requirements).catch(() => {})
      return true
    }
    return false
  } catch {
    return false
  }
}
