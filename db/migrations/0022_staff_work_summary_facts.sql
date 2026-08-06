-- Per-(location, staff, day) facts from YOT's StaffWorkSummary report.
--
-- Exists because StaffPerformance carries neither "Sales per hour" nor "Avg
-- Length" (surfaced on the stylist leaderboard as "Chair time"). Keyed the same
-- way as staff_performance_facts so the two join on (location, staff, date).
--
-- sales_per_hour and avg_length_minutes are RATIOS/AVERAGES: they cannot be
-- summed across days. work_less_breaks_minutes and days_worked are stored
-- purely as aggregation weights for the range roll-up in GET /staff-performance.
CREATE TABLE IF NOT EXISTS staff_work_summary_facts (
  team_id TEXT NOT NULL,
  location_name TEXT NOT NULL,
  staff_name TEXT NOT NULL,
  date TEXT NOT NULL,
  sales_per_hour REAL,
  avg_length_minutes REAL,
  scheduled_minutes REAL,
  work_less_breaks_minutes REAL,
  days_worked REAL,
  last_updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, location_name, staff_name, date)
);

CREATE INDEX IF NOT EXISTS idx_staff_work_summary_facts_team_date
  ON staff_work_summary_facts (team_id, date);
