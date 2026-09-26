---
"lens": minor
---

Enforce the per-key `ratePerDay` quota, which until now was stored, returned by the admin API and loaded onto the request context but never checked — a key issued with `--per-day 100` still got ~86,400 requests a day. A Redis-backed counter keyed by the UTC day now rejects over-quota requests with the existing 429 shape and a `retryAfter` pointing at the next day boundary; the counter survives a process restart and resets at the boundary, and the per-minute limit is unchanged. If Redis is unreachable the daily quota fails open — requests pass, the in-process per-minute limit still applies, and every affected request logs an error and increments `api_key_daily_quota_events_total{outcome="unavailable"}` instead of silently disabling the quota. See `docs/api-key-quotas.md`.
