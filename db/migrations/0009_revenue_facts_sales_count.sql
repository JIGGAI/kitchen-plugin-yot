-- Add a true sales-side checkout-transaction count to revenue_facts.
--
-- Until this migration `revenue_facts.appointment_count` was sourced from
-- the local `appointments` table (line items / service rows). YOT's
-- DailySalesSummary report exposes a "Number of Sales" column counting
-- distinct checkout transactions, which is what business users see in their
-- daily sales reports — typically ~1.5x lower than the appointment count
-- since each sale bundles ~1.6 services on average.
--
-- Coverage averaging consults `sales_count` first when present, falling
-- back to `appointment_count` for dates that haven't been DSS-synced yet.

ALTER TABLE revenue_facts ADD COLUMN sales_count INTEGER;
