-- Preserve the raw YOT ownership separately from Govna's effective ownership.
-- Effective ownership may be changed by a local admin override after each sync.
ALTER TABLE locations ADD COLUMN yot_franchise_id TEXT;
ALTER TABLE locations ADD COLUMN yot_franchise_name TEXT;

-- Bootstrap the source snapshot from the last effective roster. The next
-- successful YOT sync replaces these values before applying overrides.
UPDATE locations
   SET yot_franchise_id = franchise_id,
       yot_franchise_name = franchise_name;

CREATE TABLE IF NOT EXISTS franchise_ownership_overrides (
  team_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  franchise_id TEXT NOT NULL,
  franchise_name TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_franchise_ownership_overrides_team
  ON franchise_ownership_overrides(team_id);
