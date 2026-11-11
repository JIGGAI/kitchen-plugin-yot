import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Staff Popularity: YOT's requested-bookings report per stylist, joined to
// Staff Performance for customers per hour and sales dollars per hour, and to
// the new-client cohort table for the last four months' returns. The pure
// builder is tested directly; the route through handleRequest on seeded tables.
import { buildStaffPopularity, trailingCohortMonths } from '../staff-popularity';

vi.mock('../../drivers/yot-client', () => ({
  saveClient: vi.fn(), fetchClient: vi.fn(), fetchClients: vi.fn(),
  characterizeClientPaging: vi.fn(), extractAppointmentsRangeRows: vi.fn(),
  fetchAppointmentsRange: vi.fn(), fetchBusiness: vi.fn(),
  fetchLocationServices: vi.fn(), fetchLocationStaff: vi.fn(),
  fetchLocations: vi.fn(), fetchStaffProfile: vi.fn(), ping: vi.fn(),
}));

import { handleRequest } from '../handler';
import { initializeDatabase } from '../../db';

const MONTHS = ['2026-10', '2026-09', '2026-08', '2026-07'];
const pop = (locationName: string, staffName: string, onlineBookings: number, regularBookings: number, firstAvailable = false) =>
  ({ locationName, staffName, onlineBookings, regularBookings, firstAvailable });
const perf = (locationName: string, staffName: string, totalSalesCount: number, totalSalesValue: number, hoursWorkedRaw: string) =>
  ({ locationName, staffName, totalSalesCount, totalSalesValue, hoursWorkedRaw });
const cohort = (locationName: string, stylistName: string | null, cohortMonth: string, newCount: number, returnedCount: number) =>
  ({ scope: (stylistName == null ? 'location' : 'stylist') as 'location' | 'stylist', locationName, stylistName, cohortMonth, newCount, returnedCount });
const build = (o: Partial<Parameters<typeof buildStaffPopularity>[0]>) =>
  buildStaffPopularity({ popularityRows: [], performanceRows: [], cohortRows: [], cohortMonths: MONTHS, ...o });
const stylist = (res: ReturnType<typeof build>, name: string, shop = 0) => res.locations[shop]!.stylists.find((s) => s.staffName === name)!;

describe('trailingCohortMonths', () => {
  it('is the four complete months before today, newest first', () => {
    expect(trailingCohortMonths('2026-11-11')).toEqual(MONTHS);
    expect(trailingCohortMonths('2027-02-01', 4)).toEqual(['2027-01', '2026-12', '2026-11', '2026-10']);
  });
});

describe('buildStaffPopularity', () => {
  it('keeps First Available out of the stylists and inside the shop total', () => {
    const res = build({ popularityRows: [
      pop('Shop One MI', 'Stylist One', 30, 10),
      pop('Shop One MI', 'Stylist Two', 5, 15),
      pop('Shop One MI', 'First Available', 20, 20, true),
    ] });
    const shop = res.locations[0]!;
    expect(shop.stylists.map((s) => s.staffName)).toEqual(['Stylist One', 'Stylist Two']);
    expect(shop.requested).toEqual({ onlineBookings: 35, regularBookings: 25, totalBookings: 60 });
    expect(shop.firstAvailable).toEqual({ onlineBookings: 20, regularBookings: 20, totalBookings: 40 });
    expect(shop.totalBookings).toBe(100);
    // Share is of the bookings that asked for someone, not of all bookings.
    expect(stylist(res, 'Stylist One').requestShare).toBeCloseTo(40 / 60, 6);
    expect(res.totals.totalBookings).toBe(100);
  });

  it('customers per hour is haircuts over hours and sales per hour is dollars over hours, from window sums', () => {
    const res = build({
      popularityRows: [pop('Shop One MI', 'Stylist One', 30, 10)],
      performanceRows: [
        perf('Shop One MI', 'Stylist One', 8, 320, '4h, 45m'),
        perf('Shop One MI', 'Stylist One', 12, 500.5, '5h, 15m'),
      ],
    });
    const s = stylist(res, 'Stylist One');
    expect(s.haircuts).toBe(20);
    expect(s.hoursWorkedMinutes).toBe(600);
    expect(s.customersPerHour).toBeCloseTo(2, 6);
    expect(s.salesPerHour).toBeCloseTo(82.05, 6);
    expect(res.locations[0]!.customersPerHour).toBeCloseTo(2, 6);
  });

  it('no hours worked means no rate: null, never Infinity or 0', () => {
    const res = build({
      popularityRows: [pop('Shop One MI', 'Stylist One', 3, 1)],
      performanceRows: [perf('Shop One MI', 'Stylist One', 3, 90, '0h, 0m')],
    });
    expect(stylist(res, 'Stylist One').customersPerHour).toBeNull();
    expect(stylist(res, 'Stylist One').salesPerHour).toBeNull();
  });

  it('joins the two reports across doubled spaces, case and shop-name spellings', () => {
    const res = build({
      popularityRows: [pop('Westland MI.', 'Stylist  One', 4, 6)],
      performanceRows: [perf('Westland', 'stylist one', 10, 400, '5h, 0m')],
      canonicalLocation: (name) => (/^westland/i.test(name) ? 'Westland MI' : name),
    });
    expect(res.locations).toHaveLength(1);
    expect(res.locations[0]!.locationName).toBe('Westland MI');
    expect(res.locations[0]!.stylists).toHaveLength(1);
    expect(stylist(res, 'Stylist One')).toMatchObject({ totalBookings: 10, haircuts: 10, hasPerformance: true });
  });

  it('someone who worked but was never asked for still gets a row', () => {
    const res = build({
      popularityRows: [pop('Shop One MI', 'Stylist One', 4, 6)],
      performanceRows: [perf('Shop One MI', 'Stylist Two', 10, 400, '5h, 0m')],
    });
    expect(stylist(res, 'Stylist Two')).toMatchObject({ totalBookings: 0, haircuts: 10, customersPerHour: 2 });
    expect(stylist(res, 'Stylist One').hasPerformance).toBe(false);
  });

  it('gives each stylist four months of new-client returns, newest first, zero-filled', () => {
    const res = build({
      popularityRows: [pop('Shop One MI', 'Stylist One', 4, 6)],
      cohortRows: [
        cohort('Shop One MI', 'Stylist One', '2026-10', 12, 3),
        cohort('Shop One MI', 'Stylist One', '2026-08', 9, 6),
        cohort('Shop One MI', 'Stylist One', '2026-03', 50, 50), // outside the four months
        cohort('Shop One MI', null, '2026-10', 40, 11),
      ],
    });
    expect(stylist(res, 'Stylist One').newClientReturns).toEqual([
      { month: '2026-10', newCount: 12, returnedCount: 3 },
      { month: '2026-09', newCount: 0, returnedCount: 0 },
      { month: '2026-08', newCount: 9, returnedCount: 6 },
      { month: '2026-07', newCount: 0, returnedCount: 0 },
    ]);
    // The shop's own cohort row, not the sum of whichever stylists matched.
    expect(res.locations[0]!.newClientReturns![0]).toEqual({ month: '2026-10', newCount: 40, returnedCount: 11 });
    expect(res.totals.newClientReturns![0]).toEqual({ month: '2026-10', newCount: 40, returnedCount: 11 });
  });

  it('bridges a preferred name to the report\'s legal name by surname, then by first name', () => {
    const res = build({
      popularityRows: [pop('Shop One MI', 'Alison Garner', 4, 6), pop('Shop One MI', 'Patricia Snyder', 2, 2), pop('Shop One MI', 'Dana Hill', 1, 1)],
      cohortRows: [
        cohort('Shop One MI', 'Ali Garner', '2026-10', 10, 4),
        cohort('Shop One MI', 'Trish Snyder (Artist)', '2026-10', 8, 2),
        cohort('Shop One MI', 'Dana', '2026-10', 5, 1),
      ],
    });
    expect(stylist(res, 'Alison Garner').newClientReturns![0]).toMatchObject({ newCount: 10, returnedCount: 4 });
    expect(stylist(res, 'Patricia Snyder').newClientReturns![0]).toMatchObject({ newCount: 8, returnedCount: 2 });
    expect(stylist(res, 'Dana Hill').newClientReturns![0]).toMatchObject({ newCount: 5, returnedCount: 1 });
  });

  it('leaves returns empty when the bridge would be a guess', () => {
    const res = build({
      popularityRows: [pop('Shop One MI', 'Allison Ivers', 4, 6), pop('Shop One MI', 'Allison Garner', 2, 2)],
      cohortRows: [cohort('Shop One MI', 'Allison', '2026-10', 10, 4)],
    });
    expect(stylist(res, 'Allison Ivers').newClientReturns).toBeNull();
    expect(stylist(res, 'Allison Garner').newClientReturns).toBeNull();
  });

  it('never carries one shop\'s cohort onto a same-named stylist elsewhere', () => {
    const res = build({
      popularityRows: [pop('Shop One MI', 'Stylist One', 4, 6), pop('Shop Two MI', 'Stylist One', 1, 1)],
      cohortRows: [cohort('Shop Two MI', 'Stylist One', '2026-10', 10, 4)],
    });
    expect(stylist(res, 'Stylist One', 0).newClientReturns).toBeNull();
    expect(stylist(res, 'Stylist One', 1).newClientReturns![0]).toMatchObject({ newCount: 10 });
  });

  it('sorts shops by name and stylists by requested bookings', () => {
    const res = build({ popularityRows: [
      pop('Shop Two MI', 'Stylist One', 1, 1),
      pop('Shop One MI', 'Stylist Two', 1, 1),
      pop('Shop One MI', 'Stylist Three', 9, 1),
    ] });
    expect(res.locations.map((l) => l.locationName)).toEqual(['Shop One MI', 'Shop Two MI']);
    expect(res.locations[0]!.stylists.map((s) => s.staffName)).toEqual(['Stylist Three', 'Stylist Two']);
  });
});

let tmp: string;
let teamSeq = 0;
function freshTeam(): string {
  const teamId = `P${teamSeq++}`;
  initializeDatabase(teamId);
  return teamId;
}
function seedPop(teamId: string, locationName: string, staffName: string, date: string, online: number, regular: number, firstAvailable = 0) {
  initializeDatabase(teamId).sqlite.prepare(
    `INSERT INTO staff_popularity_facts (team_id, location_name, staff_name, date, first_available, online_bookings, regular_bookings, total_bookings, last_updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(teamId, locationName, staffName, date, firstAvailable, online, regular, online + regular, `${date}T23:00:00Z`);
}
function seedPerf(teamId: string, locationName: string, staffName: string, date: string, count: number, value: number, hoursRaw: string) {
  initializeDatabase(teamId).sqlite.prepare(
    `INSERT INTO staff_performance_facts (team_id, location_name, staff_name, date, total_sales_count, total_sales_value, hours_worked_raw, last_updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(teamId, locationName, staffName, date, count, value, hoursRaw, '2026-10-27T00:00:00Z');
}
const get = (teamId: string, query: Record<string, string>) =>
  handleRequest({ method: 'GET', path: '/staff-popularity', query: { team: teamId, ...query }, headers: {}, body: null }, {} as any);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'yot-staff-popularity-'));
  process.env.HOME = tmp;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('GET /staff-popularity', () => {
  it('sums the days inside the window and nothing outside it', async () => {
    const teamId = freshTeam();
    seedPop(teamId, 'Shop One MI', 'Stylist One', '2026-10-05', 3, 2);
    seedPop(teamId, 'Shop One MI', 'Stylist One', '2026-10-06', 4, 1);
    seedPop(teamId, 'Shop One MI', 'Stylist One', '2026-10-09', 50, 50);
    seedPop(teamId, 'Shop One MI', 'First Available', '2026-10-05', 6, 4, 1);
    seedPerf(teamId, 'Shop One MI', 'Stylist One', '2026-10-05', 9, 360, '4h, 30m');
    seedPerf(teamId, 'Shop One MI', 'Stylist One', '2026-10-09', 99, 9999, '9h, 0m');
    const res: any = await get(teamId, { startDate: '2026-10-05', endDate: '2026-10-07' });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ startDate: '2026-10-05', endDate: '2026-10-07', dataFrom: '2026-10-05', dataTo: '2026-10-09' });
    const shop = res.data.locations[0];
    expect(shop.stylists).toHaveLength(1);
    expect(shop.stylists[0]).toMatchObject({ onlineBookings: 7, regularBookings: 3, totalBookings: 10, haircuts: 9, customersPerHour: 2, salesPerHour: 80 });
    expect(shop.firstAvailable.totalBookings).toBe(10);
    expect(res.data.totals.totalBookings).toBe(20);
    expect(res.data.cohortMonths).toHaveLength(4);
  });

  it('ties each shop to its locations row: id, and the spelling the table uses', async () => {
    const teamId = freshTeam();
    const { sqlite } = initializeDatabase(teamId);
    const loc = sqlite.prepare('INSERT INTO locations (id, team_id, name, active, synced_at) VALUES (?,?,?,?,?)');
    loc.run('900', teamId, 'Shop  One MI', 0, '2026-10-01T00:00:00Z');  // retired duplicate
    loc.run('901', teamId, 'Shop  One MI', 1, '2026-10-01T00:00:00Z');
    seedPop(teamId, 'Shop One MI', 'Stylist One', '2026-10-05', 3, 2);
    seedPop(teamId, 'Shop Nowhere', 'Stylist Two', '2026-10-05', 1, 0);
    const res: any = await get(teamId, { startDate: '2026-10-05', endDate: '2026-10-05' });
    const byName = Object.fromEntries(res.data.locations.map((l: any) => [l.locationName, l.locationId]));
    expect(byName).toEqual({ 'Shop  One MI': '901', 'Shop Nowhere': null });
  });

  it('honours cohortMonths and clamps it', async () => {
    const teamId = freshTeam();
    expect(((await get(teamId, { cohortMonths: '6' })) as any).data.cohortMonths).toHaveLength(6);
    expect(((await get(teamId, { cohortMonths: '99' })) as any).data.cohortMonths).toHaveLength(12);
    expect(((await get(teamId, { cohortMonths: 'x' })) as any).data.cohortMonths).toHaveLength(4);
  });

  it('an empty window is an empty report, not an error', async () => {
    const res: any = await get(freshTeam(), { startDate: '2026-10-05', endDate: '2026-10-07' });
    expect(res.status).toBe(200);
    expect(res.data.locations).toEqual([]);
    expect(res.data.totals).toMatchObject({ totalBookings: 0, customersPerHour: null, newClientReturns: null });
  });
});
