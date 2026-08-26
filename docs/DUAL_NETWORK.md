# Dual-Network (mainnet + testnet) — Foundation

Goal: run Lens on **mainnet and testnet at the same time**, keeping testnet as
the safe demo/QA surface while mainnet serves real price data.

## Architecture options

1. **Two deployments (recommended, no refactor).** Same image, one env set +
   one database/Redis per network.
2. **In-process dual-network.** One process ingests both networks — requires the
   issues below (per-network config, network-aware storage, per-network clients
   and ingesters, a network selector on the API).

Storage must be network-segregated: the schema has **no `network` column**, so
the same `pairKey` (e.g. `XLM/USDC`) on two networks collides and corrupts each
other's VWAP/aggregates. Redis keys need a per-network prefix too.

> Heads-up: today's defaults are incoherent — `HORIZON_URL`/`RPC_URL` default to
> **testnet** while the Soroswap factory, Reflector oracle and Aquarius API
> default to **mainnet** addresses. #116 / #113 reconcile this.

## Env matrix

| Var | testnet | mainnet |
|-----|---------|---------|
| `HORIZON_URL` | `https://horizon-testnet.stellar.org` | `https://horizon.stellar.org` |
| `RPC_URL` | `https://soroban-testnet.stellar.org` | external provider (**secret — host env only**) |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |
| `SOROSWAP_FACTORY_ADDRESS` | (n/a on testnet) | `CA4HEQTL…` |
| `REFLECTOR_CONTRACT_ID` | — | `CCYXZMNH…` |
| `WATCHED_PAIRS` | testnet USDC issuer | mainnet USDC issuer |
| `DATABASE_URL` / `REDIS_URL` | testnet | **separate** mainnet instances |

## Ordered work (next Wave)

Dependencies: **#113 → #115 → #116 → #117**; #114 before the network selector.

| # | Issue | Dep |
|---|-------|-----|
| [#113](../../issues/113) | `config.ts` → per-network config map | — |
| [#114](../../issues/114) | `network` discriminator on all models + Redis prefix | — |
| [#115](../../issues/115) | Per-network Horizon/RPC clients across ingesters | #113 |
| [#116](../../issues/116) | Per-network Soroswap/Reflector/Aquarius/token-list | #113 |
| [#117](../../issues/117) | Launch ingesters per network | #113–#116 |
| [#118](../../issues/118) | Network selector on routes + per-request x402 | #114 |
| [#119](../../issues/119) | Nightly `pg_dump` backup + [restore runbook](backup-restore.md) | — |
| [#120](../../issues/120) | Mainnet deploy guide | the rest |

## Ops (Render + UptimeRobot + external Postgres)

- **Compute:** Render free web service kept awake by UptimeRobot pinging
  `/status` every 5 min. Note the **750 instance-hours/month** free cap — run
  mainnet always-on, testnet on-demand / a second account / a paid instance.
- **Database:** use Neon or another managed Postgres. **Do not** use Render's
  free Postgres — it is **deleted after 90 days**. One DB per network.
- **Durability fallback:** nightly `pg_dump` (#119) for fast restore; see
  [backup-restore.md](backup-restore.md). Lens is an aggregator, so the DB is
  also re-derivable by re-ingesting from chain.
