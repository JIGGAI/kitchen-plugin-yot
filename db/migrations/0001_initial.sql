-- Initial schema for kitchen-plugin-yot
-- Created: 2026-04-19

-- Per-team config (YOT API key, base URL, etc.)
CREATE TABLE IF NOT EXISTS plugin_config (
  team_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, key)
);

-- Cached client records pulled from YOT
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,               -- YOT client id
  team_id TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,                       -- JSON blob (line1/city/state/zip/country)
  tags TEXT,                          -- JSON array
  last_visit_at TEXT,                 -- ISO
  total_visits INTEGER,
  total_spend REAL,
  raw TEXT,                           -- full raw YOT payload for forward-compat
  synced_at TEXT NOT NULL             -- ISO
);
CREATE INDEX IF NOT EXISTS idx_clients_team ON clients (team_id);
CREATE INDEX IF NOT EXISTS idx_clients_team_email ON clients (team_id, email);

-- Cached appointments (shape TBD once Swagger spec is read; stub for now)
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  client_id TEXT,
  staff_id TEXT,
  service_id TEXT,
  location_id TEXT,
  starts_at TEXT,                     -- ISO
  ends_at TEXT,                       -- ISO
  status TEXT,                        -- YOT status string
  total REAL,
  raw TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appts_team_starts ON appointments (team_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appts_client ON appointments (client_id);

-- Sync bookkeeping: one row per (team, resource)
CREATE TABLE IF NOT EXISTS sync_state (
  team_id TEXT NOT NULL,
  resource TEXT NOT NULL,             -- 'clients' | 'appointments' | ...
  last_synced_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  row_count INTEGER,
  PRIMARY KEY (team_id, resource)
);
