# Changelog

## 0.3.0

### Minor Changes

- 81d8e59: Add seller-side Bazaar discovery helpers (`src/bazaar/declare.ts`): `param.*`
  constructors that make per-parameter descriptions a required positional
  argument, `declareHttpResource` / `declareMcpTool` builders that assemble the
  `extensions.bazaar` declaration and its JSON Schema, and
  `validateDeclaration` / `assertDeclaration` which run the catalog's own
  `validateListing` plus seller-side metadata-quality rules so malformed listings
  fail at development time rather than in production. Lens's own gated routes
  (`/price`, `/candles`, `/pools`, `/price/twap`, and the MCP price tool) are
  declared with them in `src/bazaar/lensListings.ts`.
- 059ca5a: Add a `priceUpdated(pair: String!, network: String)` GraphQL subscription that streams live prices over the existing `/graphql` endpoint (graphql-transport-ws protocol). Every ingester (SDEX, Horizon AMM, Soroswap) publishes `{ pair, price, ts, network }` on each new price; subscribers receive only the pair they request. `network` is optional and narrows the stream to one chain — omitting it delivers every enabled network, which is only safe if the subscriber reads the `network` field on each message, since a dual-network deployment otherwise interleaves two chains' prices for the same pair.

### Patch Changes

- dca5ff3: Add `docs/x402-conformance.md`: a conformance baseline for the public `x402.org`
  facilitator on `stellar:testnet`, established by settling a real payment through
  it with an unmodified `@stellar/stellar-sdk` client and feeding it deliberately
  bad input. Records `/supported` verbatim, a settled transaction hash, a
  reason-per-rejection table, and five divergences between the reference
  implementation's advertised and actual behaviour. This is the baseline the Lens
  facilitator (#124, #125, #126) is measured against.

## 0.2.0

### Minor Changes

- bbe48e4: Add `/prices/history` endpoint backed by 1-minute price snapshots. A new `price_snapshots` table is appended to every minute by a snapshot ingester, queryable over a `[from, to]` window with optional `5m`/`1h` aggregation. A retention job prunes snapshots older than 30 days.

### Patch Changes

- 5a68745: Adopt changesets for versioning and release notes. Adds `@changesets/cli`, a release GitHub Actions workflow that opens a "Version Packages" PR for pending changesets and tags releases on merge, and contributor docs for the workflow.

All notable changes to Lens are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- CI pipeline (`.github/workflows/ci.yml`) running Prisma generate, typecheck, and build on every PR
- Contributor documentation, issue templates, PR template
- This changelog

## [0.1.0] — 2025 initial deployment

### Added

- Fastify REST API with `GET /price/:assetA/:assetB`, `GET /status`, `GET /pools`
- GraphQL endpoint via Mercurius
- SDEX trade ingestion with checkpoint tracking
- AMM pool snapshot ingestion
- Best-route price calculation across SDEX and AMM
- x402 micropayment gating via `@x402/stellar`
- Prisma schema for price points, pools, and checkpoints
- BullMQ aggregate refresh worker (optional, requires Redis)
- Supabase Postgres support with scoped SSL handling
- Deployed on Render at https://lens-ldtu.onrender.com

### Fixed

- `bestRoute.ts` AMM lookup — was using broken `code:code` join format; now queries via `pool_id`
- Prisma binary target on Render (`debian-openssl-3.0.x`)
- Supabase SSL cert error (scoped to supabase.com hosts)
- BullMQ blocking startup — wrapped in try/catch, ingesters auto-restart

[Unreleased]: https://github.com/Miracle656/Lens/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Miracle656/Lens/releases/tag/v0.1.0
