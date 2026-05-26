-- Public holidays pulled from YOT's MVC web app (/Staff/PublicHolidays/List).
-- Global per team (YOT's holiday list is not per-location). Used to badge
-- store-closed days on the staff-coverage diagrams and suppress gap warnings.
CREATE TABLE IF NOT EXISTS public_holidays (
  team_id     TEXT NOT NULL,
  holiday_id  TEXT NOT NULL,          -- YOT itemId
  name        TEXT NOT NULL,
  date        TEXT NOT NULL,          -- YYYY-MM-DD
  synced_at   TEXT NOT NULL,
  PRIMARY KEY (team_id, holiday_id)
);
CREATE INDEX IF NOT EXISTS idx_public_holidays_team_date
  ON public_holidays (team_id, date);
