import { createHmac } from 'crypto'
import { prisma } from './db'

export interface PriceUpdate {
  assetA: string
  assetB: string
  previousPrice: number
  currentPrice: number
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

async function deliver(
  url: string,
  body: object,
  secret: string,
  attempt = 1
): Promise<void> {
  const payload = JSON.stringify(body)
  const signature = sign(payload, secret)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lens-Signature': signature,
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    // Network error — retry if attempts remain
    if (attempt < 3) {
      const delay = Math.pow(2, attempt - 1) * 1000 // 1s, 2s, 4s
      await new Promise(r => setTimeout(r, delay))
      return deliver(url, body, secret, attempt + 1)
    }
    console.warn(`[webhook] delivery failed after ${attempt} attempts to ${url}:`, (err as Error).message)
    return
  }

  if (res.ok) return

  // 4xx = client error, do not retry
  if (res.status >= 400 && res.status < 500) {
    console.warn(`[webhook] client error ${res.status} from ${url} — not retrying`)
    return
  }

  // 5xx — retry if attempts remain
  if (attempt < 3) {
    const delay = Math.pow(2, attempt - 1) * 1000
    await new Promise(r => setTimeout(r, delay))
    return deliver(url, body, secret, attempt + 1)
  }

  console.warn(`[webhook] delivery failed after ${attempt} attempts to ${url}: HTTP ${res.status}`)
}

export async function dispatchPriceUpdate(update: PriceUpdate): Promise<void> {
  const { assetA, assetB, previousPrice, currentPrice } = update

  const webhooks = await prisma.webhook.findMany({
    where: {
      assetA: assetA.toUpperCase(),
      assetB: assetB.toUpperCase(),
    },
  })

  if (webhooks.length === 0) return

  const triggered = webhooks.filter(wh => {
    if (wh.direction === 'above') {
      return previousPrice < wh.threshold && currentPrice >= wh.threshold
    }
    // below
    return previousPrice > wh.threshold && currentPrice <= wh.threshold
  })

  if (triggered.length === 0) return

  const timestamp = new Date().toISOString()

  await Promise.allSettled(
    triggered.map(wh =>
      deliver(
        wh.url,
        {
          assetA,
          assetB,
          price: currentPrice,
          threshold: wh.threshold,
          direction: wh.direction,
          timestamp,
        },
        wh.secret
      )
    )
  )
}