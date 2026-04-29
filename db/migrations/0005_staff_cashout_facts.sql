-- Staff Cashout daily facts cache, populated by the StaffCashoutReport sync.
-- Mirrors the shape used by revenue_facts so dashboards can read directly.

CREATE TABLE staff_cashout_facts (
  team_id TEXT NOT NULL,
  date TEXT NOT NULL,
  location_name TEXT NOT NULL,
  staff_name TEXT NOT NULL,
  location_id TEXT,
  staff_id TEXT,
  service_revenue REAL,
  product_revenue REAL,
  tips REAL,
  total_revenue REAL,
  last_updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, date, location_name, staff_name)
);

CREATE INDEX idx_staff_cashout_facts_team_date ON staff_cashout_facts(team_id, date);
CREATE INDEX idx_staff_cashout_facts_location ON staff_cashout_facts(team_id, date, location_name);
