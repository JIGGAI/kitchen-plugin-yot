import { describe, it, expect } from 'vitest';
import { canonicalLocationName } from '../handler';
import { canonicalizeRowLocations, mergeMonthlyStaffPerformance } from '../canonical-rows';

describe('canonicalLocationName: renames added with the sweep', () => {
  it('folds both earlier Clinton names, in report and double-spaced spellings', () => {
    expect(canonicalLocationName('Clinton Twp. MI')).toBe('Macomb - Clinton MI');
    expect(canonicalLocationName('Clinton Twp.  MI')).toBe('Macomb - Clinton MI');
    expect(canonicalLocationName('Macomb Eastpoint  Clinton MI')).toBe('Macomb - Clinton MI');
    expect(canonicalLocationName('Macomb - Clinton MI')).toBe('Macomb - Clinton MI');
  });

  it('returns the locations-table spelling of Yulee for the single-spaced report name', () => {
    expect(canonicalLocationName('Yulee Rt. 200 FL.')).toBe('Yulee Rt. 200  FL.');
    expect(canonicalLocationName('Yulee Rt. 200  FL.')).toBe('Yulee Rt. 200  FL.');
  });
});

describe('mergeMonthlyStaffPerformance', () => {
  const row = (locationName: string, staffName: string, yearMonth: string, value: number, count: number) => ({
    locationName, staffName, yearMonth, totalSalesValue: value, totalSalesCount: count,
  });

  it('sums a stylist-month that straddles a rename and reports the current name', () => {
    const out = mergeMonthlyStaffPerformance(
      [
        row('Clinton Twp.  MI', 'Pat Example', '2026-09', 100, 4),
        row('Macomb Eastpoint  Clinton MI', 'Pat Example', '2026-09', 50, 2),
        row('Macomb - Clinton MI', 'Pat Example', '2026-09', 25, 1),
        row('Macomb - Clinton MI', 'Pat Example', '2026-10', 10, 1),
        row('Brighton MI', 'Pat Example', '2026-09', 7, 1),
      ],
      canonicalLocationName,
    );
    expect(out).toEqual([
      row('Macomb - Clinton MI', 'Pat Example', '2026-09', 175, 7),
      row('Macomb - Clinton MI', 'Pat Example', '2026-10', 10, 1),
      row('Brighton MI', 'Pat Example', '2026-09', 7, 1),
    ]);
  });

  it('does not mutate its input', () => {
    const input = [row('Waterford', 'Pat Example', '2026-09', 100, 4), row('Waterford Mi', 'Pat Example', '2026-09', 1, 1)];
    mergeMonthlyStaffPerformance(input, canonicalLocationName);
    expect(input[0]).toEqual(row('Waterford', 'Pat Example', '2026-09', 100, 4));
  });
});

describe('canonicalizeRowLocations', () => {
  const rows = [
    { locationName: 'Westland', staffName: 'A' },
    { locationName: 'Westland Mi.', staffName: 'B' },
    { locationName: 'Brighton MI', staffName: 'C' },
    { locationName: null, staffName: 'D' },
  ];

  it('renames in place and keeps order', () => {
    expect(canonicalizeRowLocations(rows, canonicalLocationName).map((r) => r.locationName)).toEqual([
      'Westland Mi.', 'Westland Mi.', 'Brighton MI', null,
    ]);
  });

  it('filters by shop under either spelling', () => {
    for (const asked of ['Westland', 'westland mi.']) {
      expect(canonicalizeRowLocations(rows, canonicalLocationName, asked).map((r) => r.staffName)).toEqual(['A', 'B']);
    }
  });
});
