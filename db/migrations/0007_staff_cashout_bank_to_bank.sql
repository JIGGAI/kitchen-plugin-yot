-- Extend staff_cashout_facts with payout-oriented fields for Kitchen reporting.

ALTER TABLE staff_cashout_facts ADD COLUMN total_cash_received REAL;
ALTER TABLE staff_cashout_facts ADD COLUMN bank_to_bank_amount REAL;

CREATE INDEX IF NOT EXISTS idx_staff_cashout_facts_payouts
  ON staff_cashout_facts(team_id, date, location_name, bank_to_bank_amount);
