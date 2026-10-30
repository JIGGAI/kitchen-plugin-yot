import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Sales/hr on GET /staff-performance is haircuts over hours worked — both
// from the StaffPerformance report — never YOT's Staff Work Summary "Sales
// per hour", whose divisor is not hours worked and could not be reproduced.
//
// The customer's own check (2026-10-30): one stylist, Oct 1–26, 83 cuts in
// 52h 15m on the Staff Performance page, while the leaderboard said 0.89 —
// YOT's range figure for that window. "Right next to that should say 1.6."
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
function perf(teamId: string, locationName: string, staffName: string, date: string, count: number, hoursRaw: string) {
  const { sqlite } = initializeDatabase(teamId);
  sqlite.prepare(
    `INSERT INTO staff_performance_facts (team_id, location_name, staff_name, date, total_sales_count, total_sales_value, hours_worked_raw, last_updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(teamId, locationName, staffName, date, count, count * 40, hoursRaw, '2026-10-27T00:00:00Z');
}
function workSummaryRange(teamId: string, locationName: string, staffName: string, start: string, end: string, salesPerHour: number) {
  const { sqlite } = initializeDatabase(teamId);
  sqlite.prepare(
    `INSERT INTO staff_work_summary_range_facts (team_id, start_date, end_date, location_name, staff_name, sales_per_hour, computed_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(teamId, start, end, locationName, staffName, salesPerHour, '2026-10-27T00:00:00Z');
}
function workSummaryDay(teamId: string, locationName: string, staffName: string, date: string, salesPerHour: number) {
  const { sqlite } = initializeDatabase(teamId);
  sqlite.prepare(
    `INSERT INTO staff_work_summary_facts (team_id, location_name, staff_name, date, sales_per_hour, scheduled_minutes, work_less_breaks_minutes, days_worked, last_updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(teamId, locationName, staffName, date, salesPerHour, 300, 300, 1, '2026-10-27T00:00:00Z');
}
const get = (teamId: string, startDate: string, endDate: string) =>
  handleRequest({ method: 'GET', path: '/staff-performance', query: { team: teamId, startDate, endDate }, headers: {}, body: null }, {} as any);
const rowFor = (res: any, staffName: string) => res.data.rows.find((r: any) => r.staffName === staffName);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'yot-staff-perf-sph-'));
  process.env.HOME = tmp;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('GET /staff-performance salesPerHour', () => {
  it('is haircuts over hours worked for a multi-day window, ignoring YOT\'s range figure', async () => {
    const teamId = freshTeam();
    // One stylist's October, as the Staff Performance page showed it: 83 cuts, 52h 15m.
    perf(teamId, 'Livonia MI', 'Stylist One', '2026-10-01', 3, '0h, 0m');
    perf(teamId, 'Livonia MI', 'Stylist One', '2026-10-06', 8, '4h, 45m');
    perf(teamId, 'Livonia MI', 'Stylist One', '2026-10-08', 7, '5h, 0m');
    perf(teamId, 'Livonia MI', 'Stylist One', '2026-10-09', 10, '5h, 0m');
    perf(teamId, 'Livonia MI', 'Stylist One', '2026-10-12', 8, '9h, 0m');
    perf(teamId, 'Livonia MI', 'Stylist One', '2026-10-19', 12, '6h, 30m');
    perf(teamId, 'Livonia MI', 'Stylist One', '2026-10-20', 10, '6h, 0m');
    perf(teamId, 'Livonia MI', 'Stylist One', '2026-10-22', 12, '7h, 0m');
    perf(teamId, 'Livonia MI', 'Stylist One', '2026-10-26', 13, '9h, 0m');
    // What YOT's own range report said for the same window — must not be used.
    workSummaryRange(teamId, 'Livonia MI', 'Stylist One', '2026-10-01', '2026-10-26', 0.8917);
    const res: any = await get(teamId, '2026-10-01', '2026-10-26');
    expect(res.status).toBe(200);
    const ashley = rowFor(res, 'Stylist One');
    expect(ashley.totalSalesCount).toBe(83);
    expect(ashley.hoursWorkedMinutes).toBe(52 * 60 + 15);
    expect(ashley.salesPerHour).toBeCloseTo(83 / 52.25, 4); // 1.5885
    // The weight behind it is the hours, so a per-person merge across shops
    // rederives cuts / hours from the sums.
    expect(ashley.salesPerHourWeight).toBe(52 * 60 + 15);
    expect(res.data.salesPerHourStatus).toBe('ready');
  });

  it('a single day is the same rule, not YOT\'s daily figure', async () => {
    const teamId = freshTeam();
    perf(teamId, 'Livonia MI', 'Stylist One', '2026-10-08', 7, '5h, 0m');
    workSummaryDay(teamId, 'Livonia MI', 'Stylist One', '2026-10-08', 3.4); // YOT said 3.4 that day
    const res: any = await get(teamId, '2026-10-08', '2026-10-08');
    expect(rowFor(res, 'Stylist One').salesPerHour).toBeCloseTo(1.4, 6);
  });

  it('no hours worked means no rate — null, never Infinity or 0', async () => {
    const teamId = freshTeam();
    perf(teamId, 'Livonia MI', 'Stylist One', '2026-10-01', 3, '0h, 0m');
    const res: any = await get(teamId, '2026-10-01', '2026-10-01');
    expect(rowFor(res, 'Stylist One').salesPerHour).toBeNull();
    expect(rowFor(res, 'Stylist One').salesPerHourWeight).toBe(0);
  });

  it('a window with no cached range figure is ready, not computing', async () => {
    const teamId = freshTeam();
    perf(teamId, 'Livonia MI', 'Stylist One', '2026-10-20', 10, '6h, 0m');
    perf(teamId, 'Livonia MI', 'Stylist One', '2026-10-22', 12, '7h, 0m');
    const res: any = await get(teamId, '2026-10-19', '2026-10-25');
    expect(res.data.salesPerHourStatus).toBe('ready');
    expect(rowFor(res, 'Stylist One').salesPerHour).toBeCloseTo(22 / 13, 6);
  });
});
