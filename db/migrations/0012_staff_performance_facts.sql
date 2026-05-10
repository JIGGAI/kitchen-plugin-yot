-- Per-(location, staff, date) facts from YOT's StaffPerformance_2121 report.
-- Powers the /stylists Stylist Performance section on the dashboard. Refreshed
-- by the staff-performance-sync cron (one report call per day).
CREATE TABLE IF NOT EXISTS staff_performance_facts (
  team_id TEXT NOT NULL,
  location_name TEXT NOT NULL,
  staff_name TEXT NOT NULL,
  date TEXT NOT NULL,                 -- YYYY-MM-DD
  total_sales_count INTEGER,
  service_sold INTEGER,
  services_value REAL,
  services_per_sale REAL,
  average_tip REAL,
  products_sold INTEGER,
  products_value REAL,
  total_sales_value REAL,             -- $ (services_value + products_value)
  points_earned REAL,
  clients_per_point REAL,
  commission_tips_total REAL,
  avg_sale_value REAL,
  hours_worked_raw TEXT,              -- e.g. "8h, 0m" — preserved as-is
  total_per_hour REAL,
  last_updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, location_name, staff_name, date)
);
