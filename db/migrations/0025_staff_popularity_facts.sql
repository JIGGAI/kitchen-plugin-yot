-- Per-(location, staff, day) facts from YOT's StaffPopularity report: how many
-- of the day's bookings asked for each stylist by name, split into bookings
-- made online and bookings made by the shop.
--
-- Each shop also carries a "First Available" row (first_available = 1) for the
-- bookings that asked for nobody in particular, stored so a shop's rows sum to
-- its total bookings the way YOT's own subtotal does.
--
-- Day grain because the report is additive by day (verified row-for-row over
-- 2026-10-05..07), so any window is a SUM over this table. Keyed like
-- staff_performance_facts so the two join on (location, staff, date).
CREATE TABLE IF NOT EXISTS staff_popularity_facts (
  team_id TEXT NOT NULL,
  location_name TEXT NOT NULL,
  staff_name TEXT NOT NULL,
  date TEXT NOT NULL,
  first_available INTEGER NOT NULL DEFAULT 0,
  online_bookings INTEGER NOT NULL DEFAULT 0,
  regular_bookings INTEGER NOT NULL DEFAULT 0,
  total_bookings INTEGER NOT NULL DEFAULT 0,
  last_updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, location_name, staff_name, date)
);

CREATE INDEX IF NOT EXISTS idx_staff_popularity_facts_team_date
  ON staff_popularity_facts (team_id, date);
