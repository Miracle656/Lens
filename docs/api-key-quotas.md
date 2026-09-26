# API-key quotas

Lens issues API keys through `POST /admin/keys` (or
`npm run key:issue -- --per-min N --per-day M`). Each key carries two request
allowances:

| Column | Meaning | Enforced by | Where the count lives |
|---|---|---|---|
| `ratePerMin` | requests per minute | `@fastify/rate-limit` | in process (memory) |
| `ratePerDay` | requests per UTC day | `src/api/dailyQuota.ts` | Redis |

Both are returned by the admin API and settable at issue time.

## The per-minute limit

`@fastify/rate-limit` runs in the `onRequest` phase, keyed by `req.apiKey.id`
(the client IP for unauthenticated/public traffic). It is an in-process counter
with a one-minute window: it resets every minute and does not survive a restart.
That is fine for what it is — a burst limit — but it says nothing about a key's
daily volume, which is why it alone never enforced `ratePerDay`. A key issued
with `--per-day 100` still got 60 requests a minute, roughly 86,400 a day.

## The daily limit

`src/api/dailyQuota.ts` runs **after** the per-minute limiter, so the minute
window is still evaluated first and its behaviour is unchanged. For every
authenticated request it increments a Redis counter keyed by the key id and the
**UTC day**:

```
lens:apikey:quota:day:<YYYY-MM-DD>:<keyId>
```

Two properties follow directly from keying on the day:

- **It survives a process restart.** The count is in Redis, not in the process,
  so a redeploy does not hand every key a fresh allowance.
- **It resets at the day boundary.** Midnight UTC is a different key, so the
  counter starts at zero without any sweep or expiry job. A TTL
  (`secondsUntilUtcDayBoundary()`) is still set, but only to reclaim the old key.

The request is counted **before** the decision, so a key that is already over its
allowance cannot buy itself a reset by hammering the endpoint.

### Response

Over-quota requests get the same shape as the per-minute limiter's 429, with
`retryAfter` pointing at the next UTC midnight instead of the next minute:

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "Daily rate limit exceeded, retry in 4 hours 12 minutes",
  "retryAfter": "4 hours 12 minutes"
}
```

The `Retry-After` response header carries the same value in seconds.

## When Redis is unavailable: fail open, loudly

The bazaar catalog-write limiter (`src/bazaar/rateLimit.ts`) fails **closed**,
because it guards a trust boundary where the payment is unaffected either way.
The daily quota deliberately does the opposite.

Lens treats Redis as a cache and a job broker, not a source of truth
(`src/redis.ts`). Failing the daily quota **closed** would answer 429 to every
authenticated request for as long as Redis is down, including requests far
inside their allowance — turning a cache outage into a full API outage, which is
exactly the failure mode the recent outage work exists to prevent.

So when Redis cannot be reached:

- the request is **allowed through**;
- the **per-minute limiter still applies** — it is in-process, so it keeps
  working during the outage and remains the floor of protection; and
- the degradation is **not silent**: every affected request logs
  `[quota] Redis unavailable — daily quota not enforced for this request
  (fail-open)` and increments
  `api_key_daily_quota_events_total{outcome="unavailable"}`.

The residual risk is explicit: **a key can exceed its daily quota during a Redis
outage.** That is the deliberate trade for availability. Operators who need the
quota to be a hard billing boundary should alert on
`api_key_daily_quota_events_total{outcome="unavailable"} > 0`.

## Where it is wired up

- `src/api/dailyQuota.ts` — the counter, the decision and the `onRequest` hook.
- `src/index.ts` — `registerDailyQuota` is registered after the auth hook and
  after `@fastify/rate-limit`.
- `src/metrics.ts` — `api_key_daily_quota_events_total{outcome}`.
- `src/__tests__/dailyQuota.test.ts` — under limit, over limit, day reset,
  restart survival, per-minute unchanged, and fail-open.
