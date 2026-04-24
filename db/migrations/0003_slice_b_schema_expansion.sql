-- Slice B foundation for ticket 0114
-- Expands local schema for the full YOT data platform:
--   stylists, services, promotions, promotion_usage, revenue_facts
--   plus additive columns on the existing appointments table to carry the
--   richer revenue + stylist linkage shape described in 0114.
--
-- IMPORTANT: this migration is additive. It uses CREATE TABLE IF NOT EXISTS
-- and ALTER TABLE ADD COLUMN so it can be re-run safely and so it coexists
-- with the legacy appointments shape already live in hmx-marketing-team.db.
--
-- The actual ingestion of stylists/appointments/services/promotions is out of
-- scope for this ticket (slices D/F / ticket 0119) -- this migration only
-- lands the storage shell.

-- ---------------------------------------------------------------------------
-- stylists
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stylists (
  id TEXT PRIMARY KEY,                -- YOT stylist id (string to match other ids)
  team_id TEXT NOT NULL,
  location_id TEXT,                   -- primary location (soft FK -> locations.id)
  private_id TEXT,
  given_name TEXT,
  surname TEXT,
  full_name TEXT,
  email_address TEXT,
  mobile_phone TEXT,
  active INTEGER,
  source_location_id TEXT,            -- location id used when fetching/seeding
  raw TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stylists_team ON stylists (team_id);
CREATE INDEX IF NOT EXISTS idx_stylists_team_location ON stylists (team_id, location_id);
CREATE INDEX IF NOT EXISTS idx_stylists_team_active ON stylists (team_id, active);
CREATE INDEX IF NOT EXISTS idx_stylists_team_full_name ON stylists (team_id, full_name);

-- ---------------------------------------------------------------------------
-- appointments (additive)
-- The legacy 0001 shape: id, team_id, client_id, staff_id, service_id,
--   location_id, starts_at, ends_at, status, total, raw, synced_at
-- Slice B adds stylist_id + revenue breakdown + remote timestamps so we can
-- carry the richer shape described in 0114 without breaking the legacy
-- columns. Queries should prefer start_at/end_at/stylist_id going forward;
-- the legacy columns remain for back-compat until slice D/F lands the real
-- ingestion.
-- ---------------------------------------------------------------------------
ALTER TABLE appointments ADD COLUMN stylist_id TEXT;
ALTER TABLE appointments ADD COLUMN start_at TEXT;
ALTER TABLE appointments ADD COLUMN end_at TEXT;
ALTER TABLE appointments ADD COLUMN gross_amount REAL;
ALTER TABLE appointments ADD COLUMN discount_amount REAL;
ALTER TABLE appointments ADD COLUMN net_amount REAL;
ALTER TABLE appointments ADD COLUMN created_at_remote TEXT;
ALTER TABLE appointments ADD COLUMN updated_at_remote TEXT;

CREATE INDEX IF NOT EXISTS idx_appts_team ON appointments (team_id);
CREATE INDEX IF NOT EXISTS idx_appts_team_location_start ON appointments (team_id, location_id, start_at);
CREATE INDEX IF NOT EXISTS idx_appts_team_stylist_start ON appointments (team_id, stylist_id, start_at);
CREATE INDEX IF NOT EXISTS idx_appts_team_client ON appointments (team_id, client_id);
CREATE INDEX IF NOT EXISTS idx_appts_team_start ON appointments (team_id, start_at);

-- ---------------------------------------------------------------------------
-- services
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  location_id TEXT,                   -- nullable: YOT catalog may be global per team
  name TEXT,
  duration_minutes INTEGER,
  price REAL,
  active INTEGER,
  raw TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_services_team ON services (team_id);
CREATE INDEX IF NOT EXISTS idx_services_team_location ON services (team_id, location_id);

-- ---------------------------------------------------------------------------
-- promotions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  code TEXT,
  name TEXT,
  start_at TEXT,
  end_at TEXT,
  discount_type TEXT,                 -- 'percent' | 'amount' | ...
  discount_value REAL,
  location_id TEXT,                   -- nullable: global promo if null
  active INTEGER,
  raw TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promotions_team ON promotions (team_id);
CREATE INDEX IF NOT EXISTS idx_promotions_team_active ON promotions (team_id, active);
CREATE INDEX IF NOT EXISTS idx_promotions_team_code ON promotions (team_id, code);

-- ---------------------------------------------------------------------------
-- promotion_usage
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promotion_usage (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  promotion_id TEXT NOT NULL,         -- soft FK -> promotions.id
  location_id TEXT,
  appointment_id TEXT,                -- nullable
  client_id TEXT,                     -- nullable
  used_at TEXT,
  discount_amount REAL,
  raw TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promo_usage_team ON promotion_usage (team_id);
CREATE INDEX IF NOT EXISTS idx_promo_usage_team_promo_used ON promotion_usage (team_id, promotion_id, used_at);
CREATE INDEX IF NOT EXISTS idx_promo_usage_team_location_used ON promotion_usage (team_id, location_id, used_at);

-- ---------------------------------------------------------------------------
-- revenue_facts (daily rollup)
-- Appointment-level data lives in `appointments`; this table is a compact
-- dashboard-friendly daily rollup keyed on (team_id, location_id, date).
-- Can be rebuilt from appointments + promotion_usage at any time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS revenue_facts (
  team_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  date TEXT NOT NULL,                 -- 'YYYY-MM-DD' local to location
  gross_amount REAL,
  discount_amount REAL,
  net_amount REAL,
  appointment_count INTEGER,
  unique_client_count INTEGER,
  last_updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, location_id, date)
);
CREATE INDEX IF NOT EXISTS idx_revenue_facts_team_date ON revenue_facts (team_id, date);
CREATE INDEX IF NOT EXISTS idx_revenue_facts_team_location ON revenue_facts (team_id, location_id);
