import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// GET /staff-performance/monthly — per-(location, stylist, month) sales
// totals from staff_performance_facts, for the /stylists Avg ticket trend.
// Only the two additive columns ship; avg ticket is value / count and is
// rederived by whoever folds the rows (per person, per shop, per month).
vi.mock('../../drivers/yot-client', () => ({
  saveClient: vi.fn(), fetchClient: vi.fn(), fetchClients: vi.fn(),
  characterizeClientPaging: vi.fn(), extractAppointmentsRangeRows: vi.fn(),
  fetchAppointmentsRange: vi.fn(), fetchBusiness: vi.fn(),
  fetchLocationServices: vi.fn(), fetchLocationStaff: vi.fn(),
  fetchLocations: vi.fn(), fetchStaffProfile: vi.fn(), ping: vi.fn(),
}));

import { handleRequest } from '../handler';
import { initializeDatabase } from '../../db';

let tmp: string;
let teamSeq = 0;
function freshTeam(): string {
  const teamId = `T${teamSeq++}`;
  initializeDatabase(teamId);
  return teamId;
}
function fact(teamId: string, locationName: string, staffName: string, date: string, value: number, count: number) {
  const { sqlite } = initializeDatabase(teamId);
  sqlite.prepare(
    `INSERT INTO staff_performance_facts (team_id, location_name, staff_name, date, total_sales_value, total_sales_count, last_updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(teamId, locationName, staffName, date, value, count, '2026-10-01T00:00:00Z');
}
const get = (teamId: string, query: Record<string, string> = {}) =>
  handleRequest({ method: 'GET', path: '/staff-performance/monthly', query: { team: teamId, ...query }, headers: {}, body: null }, {} as any);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'yot-staff-perf-monthly-'));
  process.env.HOME = tmp;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('GET /staff-performance/monthly', () => {
  it('sums value and count per (location, stylist, month) over the requested months', async () => {
    const teamId = freshTeam();
    fact(teamId, 'Brighton MI', 'Jo Floater', '2026-08-03', 100, 4);
    fact(teamId, 'Brighton MI', 'Jo Floater', '2026-08-10', 140, 4);
    fact(teamId, 'Howell MI', 'Jo Floater', '2026-09-02', 90, 2);
    fact(teamId, 'Brighton MI', 'Sam Steady', '2026-09-15', 200, 5);
    // Outside the window: a month too early, and the month after endMonth.
    fact(teamId, 'Brighton MI', 'Sam Steady', '2026-03-15', 999, 9);
    fact(teamId, 'Brighton MI', 'Sam Steady', '2026-10-01', 999, 9);
    const res: any = await get(teamId, { endMonth: '2026-09', months: '6' });
    expect(res.status).toBe(200);
    expect(res.data.months).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
    const rows = [...res.data.rows].sort((a: any, b: any) => `${a.staffName}${a.yearMonth}${a.locationName}`.localeCompare(`${b.staffName}${b.yearMonth}${b.locationName}`));
    expect(rows).toEqual([
      { locationName: 'Brighton MI', staffName: 'Jo Floater', yearMonth: '2026-08', totalSalesValue: 240, totalSalesCount: 8 },
      { locationName: 'Howell MI', staffName: 'Jo Floater', yearMonth: '2026-09', totalSalesValue: 90, totalSalesCount: 2 },
      { locationName: 'Brighton MI', staffName: 'Sam Steady', yearMonth: '2026-09', totalSalesValue: 200, totalSalesCount: 5 },
    ]);
  });

  it('defaults to the six months ending with the last COMPLETE month', async () => {
    const teamId = freshTeam();
    const res: any = await get(teamId);
    expect(res.status).toBe(200);
    expect(res.data.months).toHaveLength(6);
    // Last month in the list is the month before the current one (never the
    // month in progress — a half month is not a full month's figure).
    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const expected = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
    // dateOnlyNow is America/New_York; around a month boundary UTC and ET can
    // disagree by a day, so accept either month's answer.
    const prevEt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
    const expectedEt = `${prevEt.getUTCFullYear()}-${String(prevEt.getUTCMonth() + 1).padStart(2, '0')}`;
    expect([expected, expectedEt]).toContain(res.data.months[5]);
    expect(res.data.rows).toEqual([]);
  });

  it('rejects a malformed endMonth and clamps months to 1..24', async () => {
    const teamId = freshTeam();
    const bad: any = await get(teamId, { endMonth: 'Sept-26' });
    expect(bad.status).toBe(400);
    const clamped: any = await get(teamId, { endMonth: '2026-09', months: '99' });
    expect(clamped.data.months).toHaveLength(24);
    expect(clamped.data.months[23]).toBe('2026-09');
  });
});
