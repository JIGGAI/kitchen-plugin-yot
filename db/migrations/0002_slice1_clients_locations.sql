-- Slice 1 foundation for ticket 0092
-- Add richer local-first YOT storage for locations + client search/sync.

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT,
  email_address TEXT,
  business_phone TEXT,
  mobile_phone TEXT,
  can_book_online INTEGER,
  active INTEGER,
  street TEXT,
  suburb TEXT,
  state TEXT,
  postcode TEXT,
  country TEXT,
  raw TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_locations_team ON locations (team_id);
CREATE INDEX IF NOT EXISTS idx_locations_team_active ON locations (team_id, active);
CREATE INDEX IF NOT EXISTS idx_locations_team_name ON locations (team_id, name);

ALTER TABLE clients ADD COLUMN private_id TEXT;
ALTER TABLE clients ADD COLUMN other_name TEXT;
ALTER TABLE clients ADD COLUMN full_name TEXT;
ALTER TABLE clients ADD COLUMN home_phone TEXT;
ALTER TABLE clients ADD COLUMN mobile_phone TEXT;
ALTER TABLE clients ADD COLUMN business_phone TEXT;
ALTER TABLE clients ADD COLUMN email_address TEXT;
ALTER TABLE clients ADD COLUMN birthday TEXT;
ALTER TABLE clients ADD COLUMN gender TEXT;
ALTER TABLE clients ADD COLUMN active INTEGER;
ALTER TABLE clients ADD COLUMN street TEXT;
ALTER TABLE clients ADD COLUMN suburb TEXT;
ALTER TABLE clients ADD COLUMN state TEXT;
ALTER TABLE clients ADD COLUMN postcode TEXT;
ALTER TABLE clients ADD COLUMN country TEXT;
ALTER TABLE clients ADD COLUMN source_location_id TEXT;
ALTER TABLE clients ADD COLUMN created_at_remote TEXT;

CREATE INDEX IF NOT EXISTS idx_clients_team_private_id ON clients (team_id, private_id);
CREATE INDEX IF NOT EXISTS idx_clients_team_active ON clients (team_id, active);
CREATE INDEX IF NOT EXISTS idx_clients_team_full_name ON clients (team_id, full_name);
CREATE INDEX IF NOT EXISTS idx_clients_team_mobile_phone ON clients (team_id, mobile_phone);
CREATE INDEX IF NOT EXISTS idx_clients_team_email_address ON clients (team_id, email_address);
CREATE INDEX IF NOT EXISTS idx_clients_team_source_location_id ON clients (team_id, source_location_id);
CREATE INDEX IF NOT EXISTS idx_clients_team_last_visit_at ON clients (team_id, last_visit_at);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  rows_seen INTEGER,
  rows_written INTEGER,
  page_count INTEGER,
  notes TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_team_resource_started ON sync_runs (team_id, resource, started_at);
