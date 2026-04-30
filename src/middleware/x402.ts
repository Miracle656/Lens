import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { x402_payments_received_total } from '../metrics'
import fp from 'fastify-plugin'
// @ts-ignore — @x402 packages ship ESM-only types incompatible with commonjs moduleResolution
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server'
// @ts-ignore
import { ExactStellarScheme } from '@x402/stellar/exact/server'

// Routes gated by x402 and their prices
const GATED_ROUTES: Record<string, { price: string; description: string }> = {
  '/price': { price: '$0.10', description: 'Unified SDEX+AMM price with VWAP and best route' },
  '/pools': { price: '$0.05', description: 'AMM liquidity pool reserves and spot prices' },
  '/candles': { price: '$0.05', description: 'OHLCV candle data for trading charts' },
}

/**
 * Fastify plugin that gates matching routes behind x402 USDC micropayments.
 * Only active when ORACLE_PAYMENT_ADDRESS is set in env.
 */
async function x402Plugin(app: FastifyInstance) {
  // Read at plugin init time (not module load) so tests can inject env vars before app.register()
  const PAYMENT_ADDRESS = process.env.ORACLE_PAYMENT_ADDRESS
  const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? 'https://facilitator.stellar.org'
  const NETWORK = (process.env.STELLAR_NETWORK === 'mainnet' ? 'stellar:pubnet' : 'stellar:testnet') as string

  if (!PAYMENT_ADDRESS) {
    app.log.warn('[oracle] ORACLE_PAYMENT_ADDRESS not set — x402 gating disabled')
    return
  }

  const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL })
  const resourceServer: any = new x402ResourceServer(facilitatorClient)
    .register(NETWORK as `${string}:${string}`, new ExactStellarScheme())

  await resourceServer.initialize()
  app.log.info('[oracle] x402 payment gating enabled')

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    // Only gate GET requests on matching path prefixes
    const matchedRoute = Object.keys(GATED_ROUTES).find(prefix =>
      req.url.startsWith(prefix) && req.method === 'GET'
    )
    if (!matchedRoute) return

    const { price, description } = GATED_ROUTES[matchedRoute]
    const paymentHeader = req.headers['x-payment'] as string | undefined

    const requirements = {
      scheme: 'exact' as const,
      price,
      network: NETWORK,
      payTo: PAYMENT_ADDRESS,
    }

    // No payment header — return 402 with requirements
    if (!paymentHeader) {
      reply.status(402).send({
        x402Version: 1,
        accepts: [requirements],
        error: 'Payment required',
        description,
      })
      return
    }

    // Verify the payment with the facilitator
    try {
      let payload: unknown
      try {
        payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString())
      } catch {
        payload = JSON.parse(paymentHeader)
      }

      const result = await resourceServer.verify(payload, requirements)
      if (!result.isValid) {
        reply.status(402).send({ error: 'Payment invalid', reason: result.invalidReason })
        return
      }

      // Valid — increment metric
      x402_payments_received_total.inc()

      // Valid — settle asynchronously and let the request through
      resourceServer.settle(payload, requirements).catch((err: unknown) => {
        app.log.error({ err }, '[oracle] x402 settle error')
      })
    } catch (err) {
      reply.status(402).send({ error: 'Payment verification failed', reason: (err as Error).message })
    }
  })
}

export const registerX402 = fp(x402Plugin, { name: 'x402' })
