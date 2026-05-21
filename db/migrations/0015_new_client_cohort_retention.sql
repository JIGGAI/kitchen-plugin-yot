-- Per-(team, scope, location, stylist?, cohort_month) precomputed counts of
-- new-to-business clients and how many of them ever returned to the business
-- afterwards. Recomputed nightly off the appointments table — see
-- scripts/run-new-client-cohort-retention.ts.
--
-- "cohort_month" is the YYYY-MM string of the new client's first cut. The
-- dashboard maps absolute cohort months to relative M-1/M-2/M-3 buckets at
-- read time based on the current window the user selected.
--
-- "returned_count" is a running total — clients keep accruing as they
-- return in later months — so the table is always overwritten in full for
-- the recompute window (last 6 months by default). Anyone whose first
-- visit was before our appointments-ingestion cutoff is NOT counted here,
-- because we can't verify they were truly "new to business" then.
--
-- scope='stylist': stylist_id is the stylist who cut them new. The count
--   belongs to that stylist regardless of who they returned to.
-- scope='location': stylist_id is NULL. The count belongs to the location
--   where they were cut new, regardless of where they returned.
--
-- Unique key avoids dup rows on re-run; nightly job UPSERTs.
CREATE TABLE IF NOT EXISTS new_client_cohort_retention (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('stylist', 'location')),
  location_id TEXT NOT NULL,
  stylist_id TEXT,
  cohort_month TEXT NOT NULL,
  new_count INTEGER NOT NULL DEFAULT 0,
  returned_count INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL,
  UNIQUE (team_id, scope, location_id, stylist_id, cohort_month)
);
CREATE INDEX IF NOT EXISTS idx_nccr_team_month
  ON new_client_cohort_retention (team_id, cohort_month);
CREATE INDEX IF NOT EXISTS idx_nccr_team_scope_month
  ON new_client_cohort_retention (team_id, scope, cohort_month);
