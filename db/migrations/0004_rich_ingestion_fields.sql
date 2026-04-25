-- Rich-ingestion expansion for ticket 0119
-- Adds first-class columns for richer stylist/service/appointment slices while
-- preserving the full raw payloads in the existing `raw` columns.

ALTER TABLE stylists ADD COLUMN initial TEXT;
ALTER TABLE stylists ADD COLUMN job_title TEXT;
ALTER TABLE stylists ADD COLUMN job_description TEXT;
ALTER TABLE stylists ADD COLUMN service_category_names TEXT;
ALTER TABLE stylists ADD COLUMN service_ids TEXT;
ALTER TABLE stylists ADD COLUMN service_names TEXT;
ALTER TABLE stylists ADD COLUMN profile_raw TEXT;

ALTER TABLE services ADD COLUMN private_id TEXT;
ALTER TABLE services ADD COLUMN category_id TEXT;
ALTER TABLE services ADD COLUMN category_name TEXT;
ALTER TABLE services ADD COLUMN price_display TEXT;
ALTER TABLE services ADD COLUMN length_display TEXT;
ALTER TABLE services ADD COLUMN description TEXT;
ALTER TABLE services ADD COLUMN staff_price_count INTEGER;
ALTER TABLE services ADD COLUMN staff_price_overrides TEXT;

ALTER TABLE appointments ADD COLUMN appointment_id TEXT;
ALTER TABLE appointments ADD COLUMN internal_id TEXT;
ALTER TABLE appointments ADD COLUMN service_name_raw TEXT;
ALTER TABLE appointments ADD COLUMN service_name_norm TEXT;
ALTER TABLE appointments ADD COLUMN status_code TEXT;
ALTER TABLE appointments ADD COLUMN status_description TEXT;
ALTER TABLE appointments ADD COLUMN category_id TEXT;
ALTER TABLE appointments ADD COLUMN category_name TEXT;
ALTER TABLE appointments ADD COLUMN duration_minutes INTEGER;
ALTER TABLE appointments ADD COLUMN client_name TEXT;
ALTER TABLE appointments ADD COLUMN client_phone TEXT;
ALTER TABLE appointments ADD COLUMN client_notes TEXT;
ALTER TABLE appointments ADD COLUMN description_html TEXT;
ALTER TABLE appointments ADD COLUMN description_text TEXT;
ALTER TABLE appointments ADD COLUMN referrer TEXT;
ALTER TABLE appointments ADD COLUMN promotion_code TEXT;
ALTER TABLE appointments ADD COLUMN arrival_note TEXT;
ALTER TABLE appointments ADD COLUMN reminder_sent INTEGER;
ALTER TABLE appointments ADD COLUMN cancelled_flag INTEGER;
ALTER TABLE appointments ADD COLUMN online_booking INTEGER;
ALTER TABLE appointments ADD COLUMN new_client INTEGER;
ALTER TABLE appointments ADD COLUMN is_class INTEGER;
ALTER TABLE appointments ADD COLUMN processing_length INTEGER;
ALTER TABLE appointments ADD COLUMN created_by TEXT;
ALTER TABLE appointments ADD COLUMN updated_by TEXT;

CREATE INDEX IF NOT EXISTS idx_stylists_team_initial ON stylists (team_id, initial);
CREATE INDEX IF NOT EXISTS idx_services_team_category ON services (team_id, category_id);
CREATE INDEX IF NOT EXISTS idx_services_team_name_norm ON services (team_id, name);
CREATE INDEX IF NOT EXISTS idx_appts_team_apptid ON appointments (team_id, appointment_id);
CREATE INDEX IF NOT EXISTS idx_appts_team_status_code ON appointments (team_id, status_code);
CREATE INDEX IF NOT EXISTS idx_appts_team_category_id ON appointments (team_id, category_id);
