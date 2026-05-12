-- Per-(team, location, staff, window) client retention facts from YOT's
-- StaffRetentionDay report. One row per sync covers the full window's
-- aggregates for a single (location, staff) pair.
--
-- Composite uniqueness: (team_id, period_start, period_end, location_name,
-- staff_name) — re-syncing the same window replaces existing rows for that
-- window via upsert.
--
-- Counts are absolute integers; percentages are 0-100 integers (matching
-- YOT's whole-percent output). NULL means the metric was absent from the
-- workbook (vs. 0/0% which YOT writes explicitly).
CREATE TABLE IF NOT EXISTS staff_retention_facts (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  location_name TEXT NOT NULL,
  staff_name TEXT NOT NULL,

  total_sales INTEGER NOT NULL DEFAULT 0,

  returned_to_staff_count INTEGER,
  returned_to_staff_pct INTEGER,
  returned_to_business_count INTEGER,
  returned_to_business_pct INTEGER,
  new_clients_count INTEGER,
  new_clients_pct INTEGER,
  total_rebooked_count INTEGER,
  total_rebooked_pct INTEGER,
  new_clients_rebooked_count INTEGER,
  new_clients_rebooked_pct INTEGER,

  retention_m1_count INTEGER,
  retention_m1_pct INTEGER,
  retention_m1_label TEXT,
  retention_m2_count INTEGER,
  retention_m2_pct INTEGER,
  retention_m2_label TEXT,
  retention_m3_count INTEGER,
  retention_m3_pct INTEGER,
  retention_m3_label TEXT,

  synced_at TEXT NOT NULL,

  UNIQUE (team_id, period_start, period_end, location_name, staff_name)
);
CREATE INDEX IF NOT EXISTS idx_srf_team_window
  ON staff_retention_facts(team_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_srf_team_loc
  ON staff_retention_facts(team_id, location_name, period_start, period_end);
