## Summary
Implemented a Prometheus metrics endpoint at `/metrics` to expose operational data for the Lens service.

### Metrics Exposed:
- `trades_ingested_total`: Counter for trades from SDEX and AMM pools.
- `amm_snapshots_total`: Counter for AMM pool snapshots.
- `price_requests_total`: Counter for price API requests.
- `x402_payments_received_total`: Counter for x402 payments.
- `last_trade_timestamp`: Gauge for the timestamp of the last trade ingested.
- `db_query_duration_seconds`: Histogram for database query performance.

### Endpoint Response:
The `/metrics` endpoint returns standard Prometheus text format containing the above metrics.

## Related issue
Closes #33

## Type of change
- [ ] Bug fix
- [x] New feature
- [ ] Refactor
- [ ] Docs
- [ ] Tests
- [ ] CI / tooling

## Checklist
- [x] I have read [CONTRIBUTING.md](../CONTRIBUTING.md)
- [x] `npx tsc --noEmit` passes
- [x] `npm run build` passes
- [x] I added / updated tests where relevant
- [x] I updated docs where relevant
