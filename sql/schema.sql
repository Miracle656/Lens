CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- Raw price points from SDEX trades and AMM swaps
CREATE TABLE IF NOT EXISTS price_points (
  id UUID DEFAULT gen_random_uuid(),
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
  event_id TEXT UNIQUE,
  PRIMARY KEY (id, timestamp)
);

SELECT create_hypertable('price_points', 'timestamp', if_not_exists => TRUE);

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

SELECT create_hypertable('pool_snapshots', 'timestamp', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_pool_snapshots_pool_time ON pool_snapshots (pool_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_pool_snapshots_assets_time ON pool_snapshots (asset_a, asset_b, timestamp DESC);

-- Pre-computed VWAP aggregates
CREATE TABLE IF NOT EXISTS price_aggregates (
  pair_key TEXT NOT NULL,
  window TEXT NOT NULL CHECK (window IN ('1m', '5m', '1h', '24h')),
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
  PRIMARY KEY (pair_key, window, bucket)
);

-- Indexer cursor state
CREATE TABLE IF NOT EXISTS indexer_state (
  id TEXT PRIMARY KEY,
  last_cursor TEXT,
  last_ledger INTEGER,
  last_processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
