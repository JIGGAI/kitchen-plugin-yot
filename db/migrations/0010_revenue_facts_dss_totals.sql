-- Persist per-(location, date) totals from YOT's DailySalesSummaryTotals
-- report alongside revenue_facts. These columns are surfaced on the dashboard
-- /daily-ops By Location section. All nullable: rows pre-dating the totals
-- sync (and dates the totals report doesn't return) leave them empty.
ALTER TABLE revenue_facts ADD COLUMN cash_sales REAL;
ALTER TABLE revenue_facts ADD COLUMN total_sales REAL;
ALTER TABLE revenue_facts ADD COLUMN services_per_sale REAL;
ALTER TABLE revenue_facts ADD COLUMN avg_sale_value REAL;
ALTER TABLE revenue_facts ADD COLUMN commission_total REAL;
ALTER TABLE revenue_facts ADD COLUMN commission_net REAL;
ALTER TABLE revenue_facts ADD COLUMN gross_income REAL;
ALTER TABLE revenue_facts ADD COLUMN pct_cost_of_sale REAL;
