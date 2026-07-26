import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseStaffCashoutCsv } from '../reports/staff-cashout-csv';

// Real CSV export of StaffCashoutReport for 2026-07-25, captured from YOT's
// Telerik server after the XLSX rendering extension disappeared. The same
// day's XLSX-derived numbers shipped in the 2026-07-25 disbursement run, so
// the expectations below are golden values from
// hmx-reports/branch-deposits-2026-07-25.diagnostics.json.
const fixturePath = join(__dirname, 'fixtures', 'staff-cashout-sample.csv');
const fixtureBuffer = readFileSync(fixturePath);

describe('parseStaffCashoutCsv', () => {
  it('extracts one row per staff member in the export', () => {
    const result = parseStaffCashoutCsv(fixtureBuffer);
    expect(result.rows).toHaveLength(114);
  });

  it('reads staff name, location and bank-to-bank amount matching the XLSX-derived values', () => {
    const result = parseStaffCashoutCsv(fixtureBuffer);
    const row = result.rows.find((r) => r.staffName === 'Jesse Chase');
    expect(row?.locationName).toBe('Grand Blanc MI');
    expect(row?.bankToBankAmount).toBe(329);
  });

  it('reports the bank-to-bank total stated by the report itself', () => {
    const result = parseStaffCashoutCsv(fixtureBuffer);
    expect(result.bankToBankTotal).toBe(23174);
  });

  // The strongest cross-format check available: these per-location totals were
  // produced by the XLSX parser during the real 2026-07-25 disbursement run
  // (diagnostics.branchMasterPerLocation[].yotAmount). The CSV parser must
  // agree with them exactly, or it must not be used to pay anyone.
  it('per-location totals match the XLSX-derived amounts from the 2026-07-25 run', () => {
    const xlsxDerived: Record<string, number> = {
      'Auburn Hills': 761, Brighton: 1406, Centerville: 495, Clinton: 614,
      Davison: 599, Howell: 1781, Livonia: 844, Monroe: 572,
      Morgantown: 1208, Shelby: 772, Southgate: 447, Sterling: 277,
      Troy: 541, Waterford: 1183, Westland: 1120,
    };

    const result = parseStaffCashoutCsv(fixtureBuffer);
    const totalsByLocation = new Map<string, number>();
    for (const row of result.rows) {
      const key = (row.locationName || '').trim();
      totalsByLocation.set(key, (totalsByLocation.get(key) ?? 0) + (row.bankToBankAmount ?? 0));
    }

    for (const [shortName, expected] of Object.entries(xlsxDerived)) {
      const matches = [...totalsByLocation.entries()].filter(([name]) => name.startsWith(shortName));
      expect(matches, `no CSV location starting with "${shortName}"`).toHaveLength(1);
      expect(matches[0]![1], `${shortName} total`).toBeCloseTo(expected, 2);
    }
  });

  it('throws when the extracted amounts do not sum to the stated report total', () => {
    // Column ids are the fragile part of this parser — if Telerik renumbers a
    // textbox we must fail loudly rather than emit a wrong payroll file.
    const header = ['givenNameDataTextBox', 'textBox48', 'textBox30', 'textBox88'].join(',');
    const doctored = [header, 'Ada Smith,Brighton MI,100.00,"999.00"', 'Bo Jones,Brighton MI,50.00,"999.00"'].join('\n');

    expect(() => parseStaffCashoutCsv(Buffer.from(doctored, 'utf8'))).toThrow(/reconcile/i);
  });
});
