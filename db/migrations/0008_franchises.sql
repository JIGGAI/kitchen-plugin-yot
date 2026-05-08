-- Track YOT franchise grouping (Hair MX = corporate, others = franchisees).
-- Sourced from the MVC page /Administration/Franchises/List, which YOT does
-- not expose via the REST API. Each location belongs to at most one
-- franchise; the join is by location name (names are unique among active
-- locations in practice).

CREATE TABLE IF NOT EXISTS franchises (
  team_id TEXT NOT NULL,
  franchise_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_corporate INTEGER NOT NULL DEFAULT 0,
  location_count INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (team_id, franchise_id)
);

CREATE INDEX IF NOT EXISTS idx_franchises_team ON franchises(team_id);

-- Denormalized franchise pointer on locations so /locations responses can
-- include franchise info without a join. Synced by sync-franchises.
ALTER TABLE locations ADD COLUMN franchise_id TEXT;
ALTER TABLE locations ADD COLUMN franchise_name TEXT;
