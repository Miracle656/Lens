import http from 'k6/http'
import { check } from 'k6'
import { Rate } from 'k6/metrics'

/**
 * Load test for the price endpoints fronted by trading bots.
 *
 * Acceptance criteria: p95 < 80ms at 5k RPS.
 *
 * The test drives `GET /price/:assetA/:assetB` — the hot path bots poll. It uses
 * a constant-arrival-rate executor so the load is expressed in requests/second
 * (open model), independent of how fast the server responds. k6 scales the VU
 * pool to sustain the target rate.
 *
 * Configuration (all via environment variables):
 *   BASE_URL   Target host.            Default: http://localhost:3002
 *   RATE       Target requests/sec.    Default: 5000
 *   DURATION   Steady-state duration.  Default: 1m
 *   API_KEY    Bearer token to send.   Default: none (server should run with
 *              REQUIRE_API_KEY=false, or the limiter/auth will reject the flood).
 *   PAIRS      Comma-separated list of assetA/assetB pairs to rotate through.
 *              Default: XLM/USDC  (the pair watched in docker-compose.yml).
 *
 * Example:
 *   k6 run -e RATE=5000 -e DURATION=1m tests/load/prices.k6.js
 */

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3002').replace(/\/$/, '')
const RATE = parseInt(__ENV.RATE || '5000', 10)
const DURATION = __ENV.DURATION || '1m'
const API_KEY = __ENV.API_KEY || ''
const PAIRS = (__ENV.PAIRS || 'XLM/USDC').split(',').map((p) => p.trim()).filter(Boolean)

// Track non-2xx responses separately so a flood of 429s (rate limited) or 401s
// (auth) shows up clearly rather than silently inflating latency percentiles.
const errorRate = new Rate('errors')

export const options = {
  scenarios: {
    prices: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      // Pre-allocate a generous VU pool to cover the target rate; allow growth
      // if the server slows down. At p95 < 80ms, ~5000 rps needs ≈400 VUs, but
      // we allocate headroom so a transient stall doesn't starve the arrival rate.
      preAllocatedVUs: Math.max(500, Math.ceil(RATE / 8)),
      maxVUs: Math.max(2000, Math.ceil(RATE / 2)),
    },
  },
  thresholds: {
    // Primary acceptance criterion.
    http_req_duration: ['p(95)<80'],
    // The run is only meaningful if requests actually succeeded.
    errors: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
  },
}

const params = {
  headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
  tags: { endpoint: 'price' },
}

export default function () {
  // Rotate across the configured pairs to exercise the cache realistically.
  const pair = PAIRS[Math.floor(Math.random() * PAIRS.length)]
  const res = http.get(`${BASE_URL}/price/${pair}`, params)

  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'has body': (r) => r.body && r.body.length > 0,
  })
  errorRate.add(!ok)
}
