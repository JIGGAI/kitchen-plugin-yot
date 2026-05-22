-- Adds a second "returned" tally to new_client_cohort_retention so the
-- Top Retainers section can show new-client cohorts who came back to the
-- SAME stylist (existing returned_count tracks "returned anywhere"). For
-- scope='location' rows this is the sum of same-stylist returns at that
-- location; not currently surfaced in the UI but kept for consistency.
--
-- Nullable on purpose: rows written before the next recompute won't have
-- it yet. The recompute fully overwrites the in-scope months, so the
-- nightly cron backfills it on its first run after deploy.
ALTER TABLE new_client_cohort_retention
  ADD COLUMN returned_to_stylist_count INTEGER;
