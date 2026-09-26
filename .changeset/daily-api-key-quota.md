---
'lens': patch
---

Enforce the per-API-key `ratePerDay` quota. Previously `ratePerDay` was stored,
returned by `POST /admin/keys`, and loaded into `req.apiKey`, but the rate
limiter only read `ratePerMin` — so a key issued with `--per-day 100` could
still make ~86,400 requests a day. `src/api/dailyQuota.ts` adds a Redis-backed,
UTC-day-scoped counter registered after `@fastify/rate-limit`; exceeding it
returns `429` with a `retryAfter` pointing at the next day boundary, the
per-minute limit is unchanged, and the counter fails closed (`503`) when Redis
is unavailable rather than silently disabling the quota.
