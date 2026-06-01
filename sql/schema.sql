-- Raw price points from SDEX trades and AMM swaps
CREATE TABLE IF NOT EXISTS price_points (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  asset_a TEXT NOT NULL,
  asset_b TEXT NOT NULL,
  pair_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('SDEX', 'AMM')),
  pool_id TEXT,
  price NUMERIC(36, 18) NOT NULL,
  base_volume NUMERIC(36, 7) NOT NULL,
  counter_volume NUMERIC(36, 7) NOT NULL,
  ledger INTEGER NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  event_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_price_points_pair_time ON price_points (pair_key, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_price_points_pair_source_time ON price_points (pair_key, source, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_price_points_pool_time ON price_points (pool_id, timestamp DESC) WHERE pool_id IS NOT NULL;

-- AMM pool reserve snapshots
CREATE TABLE IF NOT EXISTS pool_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pool_id TEXT NOT NULL,
  asset_a TEXT NOT NULL,
  asset_b TEXT NOT NULL,
  reserve_a NUMERIC(36, 7) NOT NULL,
  reserve_b NUMERIC(36, 7) NOT NULL,
  spot_price NUMERIC(36, 18) NOT NULL,
  total_shares NUMERIC(36, 7),
  fee_bp INTEGER DEFAULT 30,
  ledger INTEGER NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pool_snapshots_pool_time ON pool_snapshots (pool_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_pool_snapshots_assets_time ON pool_snapshots (asset_a, asset_b, timestamp DESC);

-- Pre-computed VWAP aggregates
CREATE TABLE IF NOT EXISTS price_aggregates (
  pair_key TEXT NOT NULL,
  "window" TEXT NOT NULL CHECK ("window" IN ('1m', '5m', '1h', '24h')),
  bucket TIMESTAMPTZ NOT NULL,
  vwap NUMERIC(36, 18) NOT NULL,
  sdex_vwap NUMERIC(36, 18),
  amm_vwap NUMERIC(36, 18),
  volume NUMERIC(36, 7) NOT NULL DEFAULT 0,
  sdex_volume NUMERIC(36, 7) DEFAULT 0,
  amm_volume NUMERIC(36, 7) DEFAULT 0,
  trade_count INTEGER DEFAULT 0,
  open_price NUMERIC(36, 18),
  close_price NUMERIC(36, 18),
  high_price NUMERIC(36, 18),
  low_price NUMERIC(36, 18),
  PRIMARY KEY (pair_key, "window", bucket)
);

-- 1-minute price snapshot ring buffer.
-- The ingester appends one row per watched pair per minute; a retention job
-- prunes rows older than 30 days. Powers the /prices/history endpoint (charts,
-- backtests, audit trails) without paying the cost of scanning raw price_points.
CREATE TABLE IF NOT EXISTS price_snapshots (
  pair TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  price NUMERIC(36, 18) NOT NULL,
  volume NUMERIC(36, 7) NOT NULL DEFAULT 0,
  PRIMARY KEY (pair, ts)
);

CREATE INDEX IF NOT EXISTS idx_price_snapshots_pair_ts ON price_snapshots (pair, ts);

-- Indexer cursor state
CREATE TABLE IF NOT EXISTS indexer_state (
  id TEXT PRIMARY KEY,
  last_cursor TEXT,
  last_ledger INTEGER,
  last_processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- API keys for authenticated, rate-quota'd access.
-- Only the SHA-256 hash of each key is ever stored — never the plaintext.
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  rate_per_min INTEGER NOT NULL DEFAULT 60,
  rate_per_day INTEGER NOT NULL DEFAULT 10000,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (hash);
