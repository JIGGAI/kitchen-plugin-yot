import { describe, it, expect } from 'vitest';
import { buildDayNotices, formatCollisionSection, formatLoansPaidOffSection, formatMissingFromRosterSection, formatNoticesBlock, formatSpellingDriftSection } from '../operator-notices';

const heath = { staffName: 'Antonio Heath', locationName: 'Howell MI', bankToBankAmount: 208, inScope: true };
const outOfScope = { staffName: 'Heather Everett', locationName: 'Mandarin FL.', bankToBankAmount: 147, inScope: false };

describe('formatMissingFromRosterSection', () => {
  it('lists only in-scope stylists, with name, shop, amount and the manual-payout action', () => {
    const out = formatMissingFromRosterSection('CORP CSV MASTER', [heath, outOfScope])!;
    expect(out).toContain('Missing from CORP CSV MASTER (manual payout for today):');
    expect(out).toContain('Antonio Heath @ Howell MI earned $208 today');
    expect(out).toContain('pay them manually');
    expect(out).not.toContain('Heather Everett');
  });

  it('returns null when every unmatched stylist is at an out-of-scope shop', () => {
    expect(formatMissingFromRosterSection('CORP CSV MASTER', [outOfScope])).toBeNull();
  });

  it('names the day when several days share one email', () => {
    const out = formatMissingFromRosterSection('CORP CSV MASTER', [heath], 'Sunday 2026-10-18')!;
    expect(out).toContain('manual payout for Sunday 2026-10-18');
    expect(out).toContain('earned $208 Sunday 2026-10-18');
  });
});

describe('formatSpellingDriftSection', () => {
  it('reports typo matches only, not prefix matches', () => {
    const rows = [
      { csvMasterRowNumber: 5, csvMasterName: 'Jon Smith', reportName: 'John Smith', locationName: 'Troy MI', matchKind: 'typo' as const },
      { csvMasterRowNumber: 6, csvMasterName: 'Sam Lee', reportName: 'Samantha Lee', locationName: 'Troy MI', matchKind: 'prefix' as const },
    ];
    const out = formatSpellingDriftSection('CORP CSV MASTER', rows)!;
    expect(out).toContain('row 5 has "Jon Smith"; YOT has "John Smith"');
    expect(out).not.toContain('Sam Lee');
    expect(formatSpellingDriftSection('CORP CSV MASTER', [rows[1]])).toBeNull();
  });
});

describe('formatLoansPaidOffSection', () => {
  it('names the stylist, amount, date and LOANS row', () => {
    const out = formatLoansPaidOffSection([{ staffId: '0731', firstName: 'Miranda', lastName: 'Bender', totalAmount: 300, paidOffOn: '2026-10-18', loanRow: 9 }])!;
    expect(out).toContain('Miranda Bender (staff id 0731) finished a $300.00 loan on 2026-10-18 (LOANS row 9)');
    expect(formatLoansPaidOffSection([])).toBeNull();
  });
});

describe('buildDayNotices + formatNoticesBlock', () => {
  it('is empty when the day has nothing to report', () => {
    expect(buildDayNotices('CORP CSV MASTER', {})).toEqual([]);
    expect(formatNoticesBlock([])).toBe('');
  });

  it('assembles the sections under a Watchdog messages heading', () => {
    const sections = buildDayNotices('CORP CSV MASTER', { reportRowsWithPositiveAmountButNoBranchMatch: [heath] }, 'Sunday 2026-10-18');
    expect(sections).toHaveLength(1);
    const block = formatNoticesBlock(sections);
    expect(block.startsWith('\n\nWatchdog messages:\n')).toBe(true);
    expect(block).toContain('Antonio Heath');
  });
});

describe('formatCollisionSection', () => {
  const c = { detail: 'Staff id 7777 is on both rosters at the same location: Marcella Belles @ Troy and Marcy Belles @ Troy MI.' };

  it('tells the operator the stylist was excluded and must be paid by hand if owed', () => {
    const out = formatCollisionSection([c], 'Saturday 2026-10-17')!;
    expect(out).toContain('Excluded Saturday 2026-10-17');
    expect(out).toContain('Marcella Belles @ Troy');
    expect(out).toContain('pay that day\'s amount by hand if it is owed');
    expect(formatCollisionSection([])).toBeNull();
  });

  it('is included by buildDayNotices when the diagnostics carry collisions', () => {
    const sections = buildDayNotices('CORP CSV MASTER', { crossGroupCollisions: [c] }, 'Sunday 2026-10-18');
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain('Excluded Sunday 2026-10-18');
  });
});
