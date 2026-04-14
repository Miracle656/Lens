# Contributing to Lens

Lens is a unified Stellar price oracle aggregating SDEX and AMM prices, gated behind x402 micropayments. Contributions welcome — docs, tests, new endpoints, ingestion improvements.

## Ways to contribute

- **Good first issues** — [`good first issue`](https://github.com/Miracle656/Lens/labels/good%20first%20issue)
- **Bug reports** — use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md)
- **Feature requests** — use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)
- **Tests** — see [`area:tests`](https://github.com/Miracle656/Lens/labels/area%3Atests)

## Repository layout

```
lens/
├── src/
│   ├── index.ts            # Fastify entry point
│   ├── db.ts               # Postgres / Supabase (Prisma)
│   ├── routes/             # REST + GraphQL handlers
│   ├── ingest/             # SDEX + AMM ingesters
│   ├── pricing/            # Best-route calculation
│   └── x402/               # Payment middleware
├── prisma/
│   └── schema.prisma
└── sql/                    # Raw SQL helpers (OHLCV, etc.)
```

## Development setup

### Prerequisites
- **Node.js 20+**
- **PostgreSQL** (local or Supabase)
- **Redis** (optional — for BullMQ workers)
- A Stellar testnet account for x402 payments (if testing paid endpoints)

### Clone and install

```bash
git clone https://github.com/Miracle656/Lens.git
cd Lens
npm install
cp .env.example .env   # fill in DATABASE_URL, REDIS_URL, WATCHED_PAIRS
npx prisma db push
npm run dev
```

API runs on `http://localhost:3000`.

### Environment variables
- `DATABASE_URL` — Postgres connection string (Supabase or local)
- `REDIS_URL` — optional, enables aggregate refresh worker
- `WATCHED_PAIRS` — comma-separated `CODE:ISSUER/CODE:ISSUER` (e.g. `XLM:native/USDC:GBBD...`)
- `NETWORK` — `testnet` or `mainnet`

## Commit conventions

- `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`
- Keep PRs focused

## Before opening a PR

```bash
npx prisma generate
npx tsc --noEmit
npm run build
npm test --if-present
```

## Testing

Tests are being set up — see [`area:tests`](https://github.com/Miracle656/Lens/labels/area%3Atests). Candidates: route handlers, price math, x402 flow, ingester bisection, DB queries.

## Questions

Open an [issue](https://github.com/Miracle656/Lens/issues) or start a [discussion](https://github.com/Miracle656/Lens/discussions).
