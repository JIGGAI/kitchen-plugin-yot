import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { handleRequest, listDisbursementGroups, weekendExportsForGroup } from '../handler';
import { GROUP_CONFIGS } from '../../disbursements/group-config';

// Fixture export dir, so these never read the live payroll files in
// ~/hmx-reports (and can't be broken by a night's real output).
let dir: string;

const CSV_HEADER = 'STAFF ID,FIRST NAME,LAST NAME,TYPE,AMOUNT,TRANSACTION ID,LOCATION';

function writeDeposits(prefix: string, date: string, rows: string[]) {
  writeFileSync(path.join(dir, `${prefix}branch-deposits-${date}.csv`), [CSV_HEADER, ...rows].join('\n') + '\n');
}

function payouts(query: Record<string, string>) {
  return handleRequest(
    { method: 'GET', path: '/payouts', query, headers: {}, body: null } as any,
    { teamId: 'test-team' } as any,
  ) as Promise<any>;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'hmx-payouts-'));
  process.env.HMX_PAYOUT_EXPORT_DIR = dir;

  // 2026-08-03: both groups paid out.
  writeDeposits('', '2026-08-03', [
    '8007,Tamara,Hidalgo,Deposit,50,Hidalgo8007,Auburn Hills',
    '7038,Dana,Humble,Deposit,76,Humble7038,Brighton',
  ]);
  writeDeposits('hmxgroup-', '2026-08-03', [
    '8945,Ambor,Darlington,Deposit,128,Darlington8945,Middleburg Fl',
  ]);
  // 2026-08-04: corp only — hmx-group's export is absent, which is a normal
  // state (its pipeline went live later and can skip a day).
  writeDeposits('', '2026-08-04', [
    '8007,Tamara,Hidalgo,Deposit,90,Hidalgo8007b,Auburn Hills',
  ]);

  // Corp garnishment diagnostics for 08-03. hmx-group has garnishments
  // disabled, so it must not pick these up.
  writeFileSync(
    path.join(dir, 'branch-deposits-2026-08-03.diagnostics.json'),
    JSON.stringify({
      date: '2026-08-03',
      generatedAt: '2026-08-04T01:00:00.000Z',
      garnishmentPayoutRows: [
        { staffId: '8007', firstName: 'Tamara', lastName: 'Hidalgo', type: 'GARNISHMENT', amount: 10, transactionId: 'g1', location: 'Auburn Hills', date: '2026-08-03' },
      ],
    }),
  );
  writeFileSync(
    path.join(dir, 'hmxgroup-branch-deposits-2026-08-03.diagnostics.json'),
    JSON.stringify({ date: '2026-08-03', generatedAt: '2026-08-04T01:10:00.000Z' }),
  );

  // Download artifacts. Corp has both weekend days; hmx-group has none for
  // this range — uneven coverage is expected, not an error.
  writeFileSync(path.join(dir, 'disbursements-2026-08-03.csv'), 'ID\n');
  writeFileSync(path.join(dir, 'disbursements-weekend-2026-08-01-to-2026-08-02.csv'), 'ID\n');
});

afterAll(() => {
  delete process.env.HMX_PAYOUT_EXPORT_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /payouts across disbursement groups', () => {
  it('returns rows from every group, tagged with their provenance', async () => {
    const res = await payouts({ startDate: '2026-08-03', endDate: '2026-08-03' });
    expect(res.status).toBe(200);
    const byGroup = new Map<string, string[]>();
    for (const row of res.data.rows) {
      byGroup.set(row.groupId, [...(byGroup.get(row.groupId) || []), row.locationName]);
    }
    expect([...byGroup.keys()].sort()).toEqual(['corp', 'hmx-group']);
    expect(byGroup.get('corp')!.sort()).toEqual(['Auburn Hills', 'Brighton']);
    expect(byGroup.get('hmx-group')).toEqual(['Middleburg Fl']);
    expect(res.data.rows.every((r: any) => r.groupLabel)).toBe(true);
  });

  it('keeps a group whose export is missing for a date out of the way of the others', async () => {
    const res = await payouts({ startDate: '2026-08-04', endDate: '2026-08-04' });
    expect(res.status).toBe(200);
    expect([...new Set(res.data.rows.map((r: any) => r.groupId))]).toEqual(['corp']);
    expect(res.data.lastSyncedAtByGroup['hmx-group']).toBeNull();
  });

  it('reports freshness per group so a stalled export is not masked by a fresh one', async () => {
    const res = await payouts({ startDate: '2026-08-03', endDate: '2026-08-04' });
    // corp exported again on 08-04, hmx-group's newest is still 08-03.
    expect(res.data.lastSyncedAtByGroup.corp).toBe('2026-08-04T01:00:00.000Z');
    expect(res.data.lastSyncedAtByGroup['hmx-group']).toBe('2026-08-04T01:10:00.000Z');
    expect(res.data.lastSyncedAt).toBe('2026-08-04T01:10:00.000Z');
  });

  it('applies garnishments only within the group whose diagnostics declared them', async () => {
    const res = await payouts({ startDate: '2026-08-03', endDate: '2026-08-03' });
    const corp = res.data.rows.find((r: any) => r.staffId === '8007');
    const group = res.data.rows.find((r: any) => r.groupId === 'hmx-group');
    expect(corp.garnishmentAmount).toBe(10);
    expect(corp.originalPayoutAmount).toBe(60);
    expect(group.garnishmentAmount).toBe(0);
    expect(group.loanPaymentAmount).toBe(0);
  });

  it('keeps per-branch totals separate per group', async () => {
    const res = await payouts({ startDate: '2026-08-03', endDate: '2026-08-03' });
    const keys = res.data.locationTotals.map((t: any) => `${t.groupId}::${t.locationName}`).sort();
    expect(keys).toEqual(['corp::Auburn Hills', 'corp::Brighton', 'hmx-group::Middleburg Fl']);
  });

  it('filters to one group on request', async () => {
    const res = await payouts({ startDate: '2026-08-03', endDate: '2026-08-03', group: 'hmx-group' });
    expect(res.status).toBe(200);
    expect([...new Set(res.data.rows.map((r: any) => r.groupId))]).toEqual(['hmx-group']);
    expect(res.data.groups).toEqual([{ id: 'hmx-group', label: 'HMX Group' }]);
  });

  it('rejects an unknown group instead of silently returning everything', async () => {
    const res = await payouts({ startDate: '2026-08-03', endDate: '2026-08-03', group: 'nope' });
    expect(res.status).toBe(400);
    expect(res.data.error).toBe('UNKNOWN_GROUP');
  });
});

describe('download availability', () => {
  it('flags which daily and weekend files actually exist, per group and date', async () => {
    const res = await payouts({ startDate: '2026-08-01', endDate: '2026-08-03' });
    const at = (groupId: string, date: string) =>
      res.data.exportFiles.find((e: any) => e.groupId === groupId && e.date === date);

    expect(at('corp', '2026-08-03').daily).toBe(true);
    expect(at('hmx-group', '2026-08-03').daily).toBe(false);

    // Saturday and Sunday both resolve to the one combined file.
    expect(at('corp', '2026-08-01').weekend.file).toBe('disbursements-weekend-2026-08-01-to-2026-08-02.csv');
    expect(at('corp', '2026-08-02').weekend.file).toBe('disbursements-weekend-2026-08-01-to-2026-08-02.csv');
    // A weekday in the same range has no weekend file.
    expect(at('corp', '2026-08-03').weekend).toBeNull();
    // hmx-group has no weekend file here at all.
    expect(at('hmx-group', '2026-08-01').weekend).toBeNull();
  });

  it("does not let corp's empty file prefix match another group's weekend files", () => {
    // Its own directory: the weekend index is cached per (dir, group), so a
    // fresh dir guarantees a real readdir rather than an assertion against
    // whatever an earlier test already cached.
    const isolated = mkdtempSync(path.join(tmpdir(), 'hmx-payouts-prefix-'));
    const previous = process.env.HMX_PAYOUT_EXPORT_DIR;
    process.env.HMX_PAYOUT_EXPORT_DIR = isolated;
    try {
      writeFileSync(path.join(isolated, 'hmxgroup-disbursements-weekend-2026-07-25-to-2026-07-26.csv'), 'ID\n');
      writeFileSync(path.join(isolated, 'disbursements-weekend-2026-07-18-to-2026-07-19.csv'), 'ID\n');

      const corp = weekendExportsForGroup(GROUP_CONFIGS.corp);
      const group = weekendExportsForGroup(GROUP_CONFIGS['hmx-group']);

      // Corp sees only its own file, despite '' being a prefix of every name.
      expect([...new Set([...corp.values()].map((w) => w.file))]).toEqual([
        'disbursements-weekend-2026-07-18-to-2026-07-19.csv',
      ]);
      expect(corp.has('2026-07-25')).toBe(false);
      expect([...new Set([...group.values()].map((w) => w.file))]).toEqual([
        'hmxgroup-disbursements-weekend-2026-07-25-to-2026-07-26.csv',
      ]);
    } finally {
      if (previous) process.env.HMX_PAYOUT_EXPORT_DIR = previous;
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe('GET /payouts/groups', () => {
  it('serves the registry so the dashboard need not copy file prefixes', async () => {
    const res = (await handleRequest(
      { method: 'GET', path: '/payouts/groups', query: {}, headers: {}, body: null } as any,
      { teamId: 'test-team' } as any,
    )) as any;
    expect(res.status).toBe(200);
    expect(res.data.groups).toEqual([
      { id: 'corp', label: 'HMX', filePrefix: '' },
      { id: 'hmx-group', label: 'HMX Group', filePrefix: 'hmxgroup-' },
    ]);
    expect(res.data.groups).toHaveLength(listDisbursementGroups().length);
  });
});
