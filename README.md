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

## Documentation
Detailed system design and data flow diagrams can be found in the [Architecture Overview](docs/architecture.md).

## Quick Start

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
