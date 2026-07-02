-- Per-holiday location scoping for public holidays.
--
-- YOT's holiday LIST page (/Staff/PublicHolidays/List) is not per-location, but
-- the per-holiday EDIT page (/Staff/PublicHolidays/Edit/{id}) carries a
-- "Public holiday locations" multiselect: the selected locations are the ones
-- the holiday CLOSES. A row here means "holiday_id closes location_id".
--
-- Semantics used by holidaysByDate(): a holiday with ZERO rows in this table
-- closes ALL locations (back-compat / unscraped fallback — safer to over-close
-- than to wrongly show a store open). A holiday with rows closes only those
-- locations. This is what lets e.g. the July 5 "Independance Day weekend"
-- holiday leave the St. Augustine / Yulee / Middleburg / World of Golf FL shops
-- open while closing the rest.
CREATE TABLE IF NOT EXISTS public_holiday_locations (
  team_id     TEXT NOT NULL,
  holiday_id  TEXT NOT NULL,          -- YOT itemId (matches public_holidays.holiday_id)
  location_id TEXT NOT NULL,          -- YOT location id (matches locations.id)
  PRIMARY KEY (team_id, holiday_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_public_holiday_locations_team_loc
  ON public_holiday_locations (team_id, location_id);
