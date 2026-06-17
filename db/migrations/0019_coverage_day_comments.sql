-- Free-text comments on a single coverage day (location + date), shown in the
-- staff-coverage drill-down modal below the stylist schedule. Shared: everyone
-- who opens that day sees the same thread. Author is the dashboard session user;
-- authors delete their own (enforced in the handler by matching author_email).
CREATE TABLE IF NOT EXISTS coverage_day_comments (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL,
  location_id   TEXT NOT NULL,
  date          TEXT NOT NULL,          -- YYYY-MM-DD
  author_email  TEXT NOT NULL,
  author_name   TEXT,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coverage_day_comments_loc_date
  ON coverage_day_comments (team_id, location_id, date, created_at);
