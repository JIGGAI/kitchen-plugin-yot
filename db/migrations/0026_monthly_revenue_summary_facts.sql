-- Per-(location, month) facts from YOT's DailySalesSummaryTotals report, for
-- the dashboard's Monthly Revenue Summary. The report prints one row per
-- location per calendar month of the requested range; each sync asks for one
-- month and replaces that month's rows.
--
-- Keyed by the report's location NAME (canonicalised), like
-- staff_performance_facts: the report carries no location id, and a shop that
-- has since been renamed or closed still has a name. location_id is filled in
-- where the name resolves to a locations row.
--
-- through_date is the last day the row covers: the month's last day for a
-- finished month, the day of the sync for the month in progress. A row whose
-- through_date is before its month's end is a month to date.
--
-- pct_cost_of_sale is a fraction (0.5246 = 52.46%), as the report prints it.
CREATE TABLE IF NOT EXISTS monthly_revenue_summary_facts (
  team_id TEXT NOT NULL,
  location_name TEXT NOT NULL,
  year_month TEXT NOT NULL,
  location_id TEXT,
  cash_sales REAL,
  credit_card_sales REAL,
  voucher_sales REAL,
  other_sales REAL,
  total_sales REAL,
  credit_card_tips REAL,
  other_tips REAL,
  number_of_sales INTEGER,
  services_per_sale REAL,
  avg_sale_value REAL,
  commission_total REAL,
  commission_net REAL,
  gross_income REAL,
  pct_cost_of_sale REAL,
  through_date TEXT NOT NULL,
  last_updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, location_name, year_month)
);

CREATE INDEX IF NOT EXISTS idx_monthly_revenue_summary_facts_team_month
  ON monthly_revenue_summary_facts (team_id, year_month);
