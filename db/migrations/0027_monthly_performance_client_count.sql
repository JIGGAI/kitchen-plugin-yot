-- The Monthly Performance Summary report prints two client columns:
--   "Total Clients"  the size of the shop's client list at the end of the
--                    month (total_clients) — it only ever grows;
--   "# of Clients"   the clients the shop actually saw in the month.
-- Only the first was stored. client_count is the second. It is NULL on rows
-- written before this column existed, until the month is synced again.
ALTER TABLE monthly_performance_facts ADD COLUMN client_count INTEGER;
