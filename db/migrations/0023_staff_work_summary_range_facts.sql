-- Range-level facts from YOT's StaffWorkSummary report.
--
-- 0022 stored per-day rows and assumed a multi-day "Sales per hour" could be
-- rebuilt by weighting those daily ratios. It cannot. YOT computes the figure
-- once over the pooled window, and a weighted mean of daily rates is a
-- different statistic: measured against YOT's own range report for
-- 2026-08-01..2026-08-09, our roll-up matched for 10 of 204 stylists and ran
-- ~40% high at the median, overstating 90% of them.
--
-- The numerator is not reproducible from anything we hold either — it sits
-- consistently above staff_performance_facts.total_sales_count and below
-- service_sold, by a margin that varies per stylist. So the only correct
-- source for a range is YOT's report for that exact range, stored here.
--
-- Keyed by the exact (start_date, end_date) a caller asked for. Ranges are not
-- interchangeable: the row for Aug 1-9 says nothing about Aug 1-8.
CREATE TABLE IF NOT EXISTS staff_work_summary_range_facts (
  team_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  location_name TEXT NOT NULL,
  staff_name TEXT NOT NULL,
  sales_per_hour REAL,
  avg_length_minutes REAL,
  scheduled_minutes REAL,
  work_less_breaks_minutes REAL,
  days_worked REAL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (team_id, start_date, end_date, location_name, staff_name)
);

CREATE INDEX IF NOT EXISTS idx_staff_work_summary_range_facts_window
  ON staff_work_summary_range_facts (team_id, start_date, end_date);

-- One row per (team, window) tracking the report pull for that window.
--
-- The report takes minutes to generate, so a window the caller asks for
-- cold cannot be served in the request. This lets GET /staff-performance say
-- "computing" honestly, lets a second caller join an in-flight pull instead of
-- starting a duplicate, and keeps a failure visible rather than retrying
-- forever behind a spinner.
CREATE TABLE IF NOT EXISTS staff_work_summary_range_jobs (
  team_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL,          -- running | ready | failed
  started_at TEXT NOT NULL,
  finished_at TEXT,
  row_count INTEGER,
  error TEXT,
  PRIMARY KEY (team_id, start_date, end_date)
);
