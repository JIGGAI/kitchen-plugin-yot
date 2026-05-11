-- Per-(team, stylist, shift date) timecard facts from YOT's StaffTimeCardSummary report.
-- Tracks shift arrival times to measure punctuality. One row per (team, staff_name, shift_date).
-- arrived_minutes is signed: + = late, - = early, 0 = on time, NULL = no clock-in recorded.
CREATE TABLE IF NOT EXISTS staff_timecard_facts (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  location_name TEXT,
  staff_name TEXT NOT NULL,
  shift_date TEXT NOT NULL,
  arrived_minutes INTEGER,
  raw_row TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stcf_team_date
  ON staff_timecard_facts(team_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_stcf_team_staff_date
  ON staff_timecard_facts(team_id, staff_name, shift_date);
