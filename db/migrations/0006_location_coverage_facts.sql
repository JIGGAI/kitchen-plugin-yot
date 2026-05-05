-- 0006_location_coverage_facts.sql
-- Per-location, per-day staff-coverage cache. Holds raw report payloads
-- (rostered + timecard) so the slot math can be recomputed without re-fetching.

CREATE TABLE IF NOT EXISTS location_coverage_facts (
  team_id                 TEXT NOT NULL,
  location_id             TEXT NOT NULL,
  date                    TEXT NOT NULL,                 -- ISO YYYY-MM-DD
  slot_payload            TEXT NOT NULL,                 -- JSON: { slots: [...] }
  rostered_payload        TEXT NOT NULL,                 -- JSON: raw report rows
  timecard_payload        TEXT NOT NULL,                 -- JSON: raw report rows
  computed_at             TEXT NOT NULL,                 -- ISO timestamp
  customers_per_stylist   INTEGER NOT NULL,
  PRIMARY KEY (team_id, location_id, date)
);

CREATE INDEX IF NOT EXISTS idx_location_coverage_facts_team_date
  ON location_coverage_facts (team_id, date);
