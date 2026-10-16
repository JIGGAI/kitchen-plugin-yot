import { describe, it, expect } from 'vitest';
import { findRosterDuplicates, formatLocationDriftSection, formatRosterDuplicateSection, isLocationDrift, isSameShop, type LocationDriftRow, type RosterRowRef } from '../location-drift';

describe('isLocationDrift', () => {
  it('is false when the roster and YOT name the same shop with different suffixes', () => {
    expect(isLocationDrift('World of Golf Fl.', 'World of Golf FL.')).toBe(false);
    expect(isLocationDrift('Yulee Rt. 200 FL', 'Yulee Rt. 200 FL.')).toBe(false);
    expect(isLocationDrift('Treaty Oaks St. Aug. FL.', 'Treaty Oaks St. Aug. FL.')).toBe(false);
    expect(isLocationDrift('Brighton', 'Brighton MI')).toBe(false);
  });

  it("is false when the roster uses corp's short shop name and YOT the long one", () => {
    expect(isLocationDrift('Sterling', 'Sterling Warren MI')).toBe(false);
    expect(isLocationDrift('Clinton', 'Macomb - Clinton MI')).toBe(false);
    expect(isSameShop('Macomb - Clinton MI', 'Clinton')).toBe(true);
  });

  it('compares whole words, so a shop name inside another word is not the same shop', () => {
    expect(isSameShop('Troy', 'Troyville MI')).toBe(false);
  });

  it('is true for a real corp drift', () => {
    // 2026-10-14: Destiny Johnson rostered at Westland, YOT paid her at Brighton.
    expect(isLocationDrift('Westland', 'Brighton MI')).toBe(true);
  });

  it('is true when the roster files the stylist under a different shop than YOT', () => {
    // 2026-10-14: Kristin Baxter rostered at World of Golf, YOT paid her at Treaty Oaks.
    expect(isLocationDrift('World of Golf Fl.', 'Treaty Oaks St. Aug. FL.')).toBe(true);
    expect(isLocationDrift('Middleburg Fl', 'Yulee Rt. 200 FL.')).toBe(true);
  });

  it('is false when either side is blank — nothing to compare', () => {
    expect(isLocationDrift('', 'Yulee Rt. 200 FL.')).toBe(false);
    expect(isLocationDrift('Yulee Rt. 200 FL', null)).toBe(false);
    expect(isLocationDrift(undefined, undefined)).toBe(false);
  });
});

describe('formatLocationDriftSection', () => {
  const row: LocationDriftRow = {
    csvMasterRowNumber: 38,
    csvMasterName: 'Kristin Baxter',
    staffId: '7666',
    csvMasterLocation: 'World of Golf Fl.',
    reportLocation: 'Treaty Oaks St. Aug. FL.',
    bankToBankAmount: 162,
  };

  it('returns null with nothing to report so callers can skip the section', () => {
    expect(formatLocationDriftSection('HAIR MX GROUP STAFF CSV MASTER', [])).toBeNull();
  });

  it('names the roster tab, row, both shops, the amount and the fix', () => {
    const out = formatLocationDriftSection('HAIR MX GROUP STAFF CSV MASTER', [row])!;
    expect(out).toContain('(row 38)');
    expect(out).toContain('Kristin Baxter (staff id 7666)');
    expect(out).toContain('"World of Golf Fl."');
    expect(out).toContain('"Treaty Oaks St. Aug. FL."');
    expect(out).toContain('$162.00');
    expect(out).toContain('add a row for them under "Treaty Oaks St. Aug. FL." too');
  });

  it('says plainly that the stylist was paid, so the section does not read as a payout error', () => {
    // 2026-10-15: the first corp email with this section was read as "people on the
    // wrong stores" because the heading said "paid under the wrong shop".
    const out = formatLocationDriftSection('CORP CSV MASTER', [row])!;
    expect(out).toContain('paid correctly');
    expect(out).toContain('They were paid in full');
    expect(out).not.toContain('wrong shop');
    expect(out).not.toContain('move their row to');
  });

  it('shows a positive amount for an owes-the-shop (negative) row', () => {
    const out = formatLocationDriftSection('CORP CSV MASTER', [{ ...row, bankToBankAmount: -12 }])!;
    expect(out).toContain('$12.00');
    expect(out).not.toContain('$-12');
  });
});

describe('findRosterDuplicates', () => {
  const row = (over: Partial<RosterRowRef>): RosterRowRef => ({ rowNumber: 1, staffId: '1', firstName: 'A', lastName: 'B', location: 'X', ...over });

  it('returns nothing when every id and name appears once', () => {
    expect(findRosterDuplicates([row({ rowNumber: 2, staffId: '3795', firstName: 'Ashley', lastName: 'Smith' }), row({ rowNumber: 3, staffId: '8955', firstName: 'Ayreona', lastName: 'Rose' })])).toEqual([]);
  });

  it('allows a floater listed under several different shops — that is how corp rosters them', () => {
    // 2026-10-14 corp: Carissa Benedict (3301) under Auburn Hills, Howell, Sterling and Waterford.
    const out = findRosterDuplicates([
      row({ rowNumber: 8, staffId: '3301', firstName: 'Carissa', lastName: 'Benedict', location: 'Auburn Hills' }),
      row({ rowNumber: 103, staffId: '3301', firstName: 'Carissa', lastName: 'Benedict', location: 'Howell' }),
      row({ rowNumber: 218, staffId: '3301', firstName: 'Carissa', lastName: 'Benedict', location: 'Sterling' }),
    ]);
    expect(out).toEqual([]);
  });

  it('flags the same person twice under one shop', () => {
    // 2026-10-14 corp: Chelsea Desselles on Monroe rows 141 and 146 (plus a legitimate Westland row).
    const out = findRosterDuplicates([
      row({ rowNumber: 141, staffId: '1254', firstName: 'Chelsea', lastName: 'Desselles', location: 'Monroe' }),
      row({ rowNumber: 146, staffId: '1254', firstName: 'Chelsea', lastName: 'Desselles', location: 'Monroe MI' }),
      row({ rowNumber: 261, staffId: '1254', firstName: 'Chelsea', lastName: 'Desselles', location: 'Westland' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('staff-id');
    expect(out[0].rows.map((r) => r.rowNumber)).toEqual([141, 146]);
  });

  it('flags the same name with different ids under one shop as a name duplicate', () => {
    const out = findRosterDuplicates([
      row({ rowNumber: 5, staffId: '100', firstName: 'Kristin', lastName: 'Baxter', location: 'Treaty Oaks St. Aug. FL.' }),
      row({ rowNumber: 9, staffId: '7666', firstName: 'Kristin', lastName: 'Baxter', location: 'Treaty Oaks St. Aug. FL.' }),
    ]);
    expect(out.map((d) => d.kind)).toEqual(['name']);
  });

  it('does not double-report a pair that shares both id and name', () => {
    const out = findRosterDuplicates([
      row({ rowNumber: 3, staffId: '3795', firstName: 'Ashley', lastName: 'Smith' }),
      row({ rowNumber: 47, staffId: '3795', firstName: 'Ashley', lastName: 'Smith' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('ignores rows with no staff id for the id check', () => {
    expect(findRosterDuplicates([row({ rowNumber: 1, staffId: '', firstName: 'A', lastName: 'B' }), row({ rowNumber: 2, staffId: '', firstName: 'C', lastName: 'D' })])).toEqual([]);
  });
});

describe('formatRosterDuplicateSection', () => {
  it('returns null with no duplicates', () => {
    expect(formatRosterDuplicateSection('HAIR MX GROUP STAFF CSV MASTER', [])).toBeNull();
  });

  it('names both rows and tells the operator to delete the stale one', () => {
    const out = formatRosterDuplicateSection('HAIR MX GROUP STAFF CSV MASTER', [{
      kind: 'staff-id', value: '3795',
      rows: [{ rowNumber: 3, staffId: '3795', name: 'Ashley Smith', location: 'Middleburg Fl' }, { rowNumber: 47, staffId: '3795', name: 'Ashley Smith', location: 'Yulee Rt. 200 FL' }],
    }])!;
    expect(out).toContain('Staff id 3795 is on row 3 (Ashley Smith, id 3795, "Middleburg Fl") and row 47');
    expect(out).toContain('Delete one of the rows');
  });
});
