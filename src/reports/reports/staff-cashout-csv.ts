import type { StaffCashoutResult, StaffCashoutRow } from './staff-cashout';
import { readCsv } from '../csv';

// Telerik's CSV renderer flattens the report into one row per detail record,
// repeating every report- and group-level textbox on each row. Columns are
// named after the .trdp textbox ids rather than the visible headers, so the
// detail fields we need are addressed by textbox id:
const STAFF_NAME_COLUMN = 'givenNameDataTextBox';
const LOCATION_COLUMN = 'textBox48';
const BANK_TO_BANK_COLUMN = 'textBox30';
// Report-level (grand) total of the bank-to-bank column, repeated on every row.
const BANK_TO_BANK_TOTAL_COLUMN = 'textBox88';
// Money values are two-decimal; anything past a cent is a real mismatch.
const RECONCILE_TOLERANCE = 0.01;

function parseNumber(value: string | undefined): number | null {
  if (value == null) return null;
  const stripped = String(value).replace(/[$,%\s]/g, '');
  if (!stripped) return null;
  const n = Number(stripped);
  return Number.isFinite(n) ? n : null;
}

function clean(value: string | undefined): string | null {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}

/** Same shape the XLSX parser returns, plus the report's own stated total. */
export type StaffCashoutCsvResult = StaffCashoutResult & { bankToBankTotal: number };

export function parseStaffCashoutCsv(buffer: Buffer): StaffCashoutCsvResult {
  const table = readCsv(buffer);
  const header = table[0] || [];
  const indexOf = (name: string): number => header.indexOf(name);

  const nameIndex = indexOf(STAFF_NAME_COLUMN);
  const locationIndex = indexOf(LOCATION_COLUMN);
  const bankToBankIndex = indexOf(BANK_TO_BANK_COLUMN);

  const rows: StaffCashoutRow[] = [];
  for (const raw of table.slice(1)) {
    const staffName = clean(raw[nameIndex]);
    if (!staffName) continue;
    rows.push({
      date: null,
      locationName: clean(raw[locationIndex]),
      staffName,
      services: null,
      serviceRevenue: null,
      productRevenue: null,
      voucherRevenue: null,
      membershipRevenue: null,
      otherRevenue: null,
      totalRevenue: null,
      tips: null,
      totalCashReceived: null,
      bankToBankAmount: parseNumber(raw[bankToBankIndex]),
      raw: raw.map((value) => String(value ?? '')),
    });
  }

  const bankToBankTotal = parseNumber(table[1]?.[indexOf(BANK_TO_BANK_TOTAL_COLUMN)]);
  const extracted = rows.reduce((sum, row) => sum + (row.bankToBankAmount ?? 0), 0);

  if (bankToBankTotal == null) {
    throw new Error(
      `Staff cashout CSV did not reconcile: no report total found in column ${BANK_TO_BANK_TOTAL_COLUMN}. ` +
        'The Telerik column layout has probably changed — verify the mapping before using this data.',
    );
  }

  if (Math.abs(extracted - bankToBankTotal) > RECONCILE_TOLERANCE) {
    throw new Error(
      `Staff cashout CSV did not reconcile: ${rows.length} staff rows sum to ${extracted.toFixed(2)} ` +
        `but the report states ${bankToBankTotal.toFixed(2)}. ` +
        'The Telerik column layout has probably changed — verify the mapping before using this data.',
    );
  }

  return { sheetName: null, headerRow: header, parameters: [], rows, bankToBankTotal };
}
