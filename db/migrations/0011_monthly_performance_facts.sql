-- Per-(location, year-month) facts from YOT's MonthlyPerformanceSummary
-- report. Powers the /monthly-leadership Location Performance Ranking on the
-- dashboard. Refreshed by the monthly-performance-sync cron.
CREATE TABLE IF NOT EXISTS monthly_performance_facts (
  team_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  year_month TEXT NOT NULL,         -- e.g. "2026-05"
  appointments INTEGER,
  cancelled INTEGER,
  no_shows INTEGER,
  online_bookings INTEGER,
  new_clients INTEGER,
  total_clients INTEGER,
  sales_count INTEGER,
  sales_per_day REAL,
  voucher_count INTEGER,
  product_sales REAL,
  service_sales REAL,
  total_sales REAL,
  yoy_amount REAL,
  yoy_pct REAL,                     -- e.g. -43.0 = -43%
  last_updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, location_id, year_month)
);
