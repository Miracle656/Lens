# Lens — Unified Stellar Price API

[![CI](https://github.com/Miracle656/Lens/actions/workflows/ci.yml/badge.svg)](https://github.com/Miracle656/Lens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Stellar](https://img.shields.io/badge/Stellar-SDEX%20%2B%20AMM-black)](https://stellar.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Aggregates price data from Stellar's Classic Order Book (SDEX) and AMM Liquidity Pools into a single, unified API.

**What Horizon doesn't do:** Horizon's `/trade_aggregations` only covers SDEX. AMM pool prices (derived from reserve ratios) are not aggregated anywhere. Lens fills this gap.

## Endpoints

### REST
| Method | Path | Description |
|---|---|---|
| GET | `/price/:assetA/:assetB` | Current VWAP, 24h volume, best route |
| GET | `/price/:assetA/:assetB/route?amount=1000` | Best execution route for a given amount |
| GET | `/price/:assetA/:assetB/history?window=1h` | OHLCV history (`1m`, `5m`, `1h`, `24h`) |
| GET | `/pools` | Active AMM pools being watched |
| GET | `/pairs` | Watched trading pairs |
| GET | `/status` | Indexer health |

### GraphQL
Available at `/graphql` with GraphiQL IDE at `/graphiql`.

```graphql
query {
  getPrice(assetA: "XLM", assetB: "USDC") {
    price
    bestRoute
    vwap1h
    volume24h
    priceChange24h
  }
  getBestRoute(assetA: "XLM", assetB: "USDC", amount: 500) {
    route
    sdexPrice
    ammPrice
    estimatedOutput
    slippagePct
    recommendation
  }
}
```

## Usage Examples

### Health Check (Unauthenticated)
Get API status without authentication:

```bash
curl http://localhost:3002/status
```

Response:
```json
{
  "status": "healthy",
  "uptime": 3600,
  "indexedPairs": 15
}
```

### REST API with x402 Payment

#### Request without Payment (402 Response)
If the API requires payment and you don't provide credentials:

```bash
curl -i http://localhost:3002/price/XLM/USDC
```

Response headers:
```
HTTP/1.1 402 Payment Required
x402-price: 1000
x402-currency: stroops
x402-address: GACS2DRJNKIXOSGZ5GQGWGD5DKVYHQSQUHZ4RGSQ3VCBJQRN26NLQCX
x402-memo: payment-invoice-12345
```

Response body:
```json
{
  "error": "Payment Required",
  "price": 1000,
  "currency": "stroops"
}
```

#### Request with x402 Payment Header
After receiving the 402 response and making a Stellar payment, include the payment proof:

```bash
curl -H "X-PAYMENT: <payment-signature>" \
  http://localhost:3002/price/XLM/USDC
```

Response (200 OK):
```json
{
  "price": 0.15234,
  "vwap1h": 0.15198,
  "volume24h": 5000000,
  "bestRoute": "SDEX",
  "priceChange24h": 2.15
}
```

#### Fetch Example
Using the Fetch API in JavaScript:

```javascript
// First request: Get payment details
const initialResponse = await fetch('http://localhost:3002/price/XLM/USDC');

if (initialResponse.status === 402) {
  const paymentRequired = await initialResponse.json();
  console.log('Payment required:', paymentRequired);
  // Handle payment with Stellar SDK...
}

// After making Stellar payment, retry with payment signature
const paymentSignature = 'your-signed-payment-tx-hash';
const paidResponse = await fetch('http://localhost:3002/price/XLM/USDC', {
  headers: {
    'X-PAYMENT': paymentSignature
  }
});

const priceData = await paidResponse.json();
console.log('Price data:', priceData);
```

### Node.js with @x402/client

Install the client:
```bash
npm install @x402/client
```

Example with automatic payment handling:

```javascript
import { X402Client } from '@x402/client';
import { Keypair } from '@stellar/stellar-sdk';

const keypair = Keypair.fromSecret('SBVP... your stellar secret key');

const client = new X402Client({
  facilitatorUrl: process.env.X402_FACILITATOR_URL,
  publicKey: keypair.publicKey(),
  secretKey: keypair.secret()
});

try {
  const response = await client.get(
    'http://localhost:3002/price/XLM/USDC'
  );

  console.log('Current price:', response.data.price);
  console.log('Volume 24h:', response.data.volume24h);
  console.log('Best route:', response.data.bestRoute);
} catch (error) {
  console.error('Request failed:', error.message);
}
```

The client automatically handles:
- Detecting 402 responses
- Creating and signing Stellar payments
- Retrying with the payment header

### GraphQL with x402 Payment

Query prices and routes using GraphQL (requires payment):

```bash
curl -X POST http://localhost:3002/graphql \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: <payment-signature>" \
  -d '{
    "query": "query { getPrice(assetA: \"XLM\", assetB: \"USDC\") { price vwap1h volume24h bestRoute priceChange24h } getBestRoute(assetA: \"XLM\", assetB: \"USDC\", amount: 100) { route sdexPrice ammPrice estimatedOutput slippagePct recommendation } }"
  }'
```

Response:
```json
{
  "data": {
    "getPrice": {
      "price": 0.15234,
      "vwap1h": 0.15198,
      "volume24h": 5000000,
      "bestRoute": "SDEX",
      "priceChange24h": 2.15
    },
    "getBestRoute": {
      "route": "SDEX",
      "sdexPrice": 0.15234,
      "ammPrice": 0.15198,
      "estimatedOutput": 15.234,
      "slippagePct": 0.024,
      "recommendation": "SDEX offers 0.24% better pricing"
    }
  }
}
```

## Documentation
Detailed system design and data flow diagrams can be found in the [Architecture Overview](docs/architecture.md).

## Docker Quickstart
The fastest way to get Lens running locally is with Docker:

```bash
# Start Lens, Postgres, and Redis
docker compose up -d

# Check health
docker compose ps
```
The API will be available at `http://localhost:3002`. Database migrations run automatically on startup.

## Quick Start (Manual)

```bash
# 1. Start PostgreSQL + Redis
docker-compose up -d

# 2. Install dependencies
npm install

# 3. Copy env
cp .env.example .env

# 4. Push database schema
npm run db:push

# 5. Start dev server
npm run dev
```

## Environment Variables

| Variable | Description | Default | Required |
|---|---|---|---|
| `NODE_ENV` | Environment mode (`development`, `test`, `production`) | `development` | No |
| `PORT` | API server port | `3002` | No |
| `HOST` | API server host | `0.0.0.0` | No |
| `DATABASE_URL` | PostgreSQL connection string | - | **Yes** |
| `REDIS_URL` | Redis connection string | - | **Yes** |
| `PRICE_CACHE_TTL` | Cache duration for price data (seconds) | `10` | No |
| `HORIZON_URL` | Stellar Horizon server URL | - | No |
| `RPC_URL` | Soroban RPC server URL | - | No |
| `NETWORK_PASSPHRASE` | Stellar network passphrase | - | No |
| `STELLAR_NETWORK` | `mainnet` or `testnet` (for x402 logic) | `testnet` | No |
| `POLL_INTERVAL_MS` | Indexer polling frequency (ms) | `5000` | No |
| `SDEX_PAGE_SIZE` | Trades per page for SDEX ingestion | `200` | No |
| `AMM_PAGE_SIZE` | Trades per page for AMM ingestion | `200` | No |
| `ADMIN_API_KEY` | Key for admin route authentication | - | No |
| `WATCHED_PAIRS` | Comma-separated list of asset pairs to index | - | **Yes** |
| `ORACLE_PAYMENT_ADDRESS` | Stellar address for x402 API payments | - | No* |
| `X402_FACILITATOR_URL` | x402 facilitator service URL | - | No |

*\*Required if enabling x402 payment gating.*

## Stack
- **Runtime:** Node.js 20 + TypeScript
- **API:** Fastify + Mercurius (GraphQL)
- **Database:** PostgreSQL + TimescaleDB
- **Cache:** Redis
- **Queue:** BullMQ
- **Stellar:** @stellar/stellar-sdk
