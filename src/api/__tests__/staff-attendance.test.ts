import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Staff Attendance: absences (sick / no-show / other) from the cached roster
// grid plus late arrivals from staff_timecard_facts, per stylist, grouped by
// location. The pure builder is tested directly; the route is tested through
// handleRequest against seeded tables.
import { buildStaffAttendance, classifyAbsenceReason, cleanStaffName, staffRoleOf } from '../staff-attendance';

vi.mock('../../drivers/yot-client', () => ({
  saveClient: vi.fn(), fetchClient: vi.fn(), fetchClients: vi.fn(),
  characterizeClientPaging: vi.fn(), extractAppointmentsRangeRows: vi.fn(),
  fetchAppointmentsRange: vi.fn(), fetchBusiness: vi.fn(),
  fetchLocationServices: vi.fn(), fetchLocationStaff: vi.fn(),
  fetchLocations: vi.fn(), fetchStaffProfile: vi.fn(), ping: vi.fn(),
}));

import { handleRequest } from '../handler';
import { initializeDatabase } from '../../db';

type Cell = { stylistId: string; stylistName: string; status: string; reason?: string };
const sched = (id: string, name: string): Cell => ({ stylistId: id, stylistName: name, status: 'scheduled' });
const out = (id: string, name: string, reason: string): Cell => ({ stylistId: id, stylistName: name, status: 'absent', reason });
const roster = (locationId: string, date: string, cells: Cell[], computedAt = '2026-11-08T09:00:00Z') => ({
  locationId, date, computedAt,
  rosteredPayload: JSON.stringify({ rows: cells.map((c) => ({ ...c, date, startsAt: null, endsAt: null })) }),
});
const late = (locationName: string, staffName: string, shiftDate: string) => ({
  locationName, staffName, shiftDate, arrivedMinutes: -20, syncedAt: '2026-11-09T10:00:00Z',
});
const names = new Map([['100', 'Brighton MI'], ['200', 'Howell MI']]);

describe('classifyAbsenceReason', () => {
  it('maps the labels managers type into three kinds', () => {
    expect(classifyAbsenceReason('Sick')).toBe('sick');
    expect(classifyAbsenceReason('sick day')).toBe('sick');
    expect(classifyAbsenceReason('No Show')).toBe('no-show');
    expect(classifyAbsenceReason('no-show')).toBe('no-show');
    expect(classifyAbsenceReason('NCNS')).toBe('no-show');
    expect(classifyAbsenceReason('All Day Break')).toBe('other');
    expect(classifyAbsenceReason('')).toBe('other');
  });
  it('returns null for store-wide closure labels, including the misspelled live ones', () => {
    expect(classifyAbsenceReason('Labor- Off')).toBeNull();
    expect(classifyAbsenceReason('Independance Day Weekend')).toBeNull();
    expect(classifyAbsenceReason('Memorial Day')).toBeNull();
    expect(classifyAbsenceReason('Closed')).toBeNull();
  });
});

describe('name helpers', () => {
  it('strips the role suffix and collapses whitespace', () => {
    expect(cleanStaffName('Mary Clark (Artist)')).toBe('Mary Clark');
    expect(cleanStaffName('Heather  Davis')).toBe('Heather Davis');
    expect(staffRoleOf('Abby  Dunmore (Receptionist)')).toBe('Receptionist');
    expect(staffRoleOf('Danielle Quinn (stylist)')).toBe('Stylist');
    expect(staffRoleOf('Sage Medina')).toBeNull();
  });
});

describe('buildStaffAttendance', () => {
  it('counts scheduled shifts and absences by kind per stylist, with rate = absences / (scheduled + absences)', () => {
    const r = buildStaffAttendance({
      locationNameById: names,
      timecardRows: [],
      rosterRows: [
        roster('100', '2026-11-02', [sched('1', 'Ann Able (Stylist)'), sched('2', 'Bo Baker (Stylist)')]),
        roster('100', '2026-11-03', [out('1', 'Ann Able (Stylist)', 'Sick'), sched('2', 'Bo Baker (Stylist)')]),
        roster('100', '2026-11-04', [out('1', 'Ann Able (Stylist)', 'No Show'), { stylistId: '2', stylistName: 'Bo Baker (Stylist)', status: 'not-scheduled' }]),
        roster('100', '2026-11-05', [out('1', 'Ann Able (Stylist)', 'All Day Break'), sched('2', 'Bo Baker (Stylist)')]),
      ],
    });
    expect(r.locations).toHaveLength(1);
    const loc = r.locations[0]!;
    expect(loc.locationName).toBe('Brighton MI');
    const ann = loc.stylists.find((s) => s.staffName === 'Ann Able')!;
    expect(ann).toMatchObject({ stylistId: '1', role: 'Stylist', scheduledShifts: 1, absences: 3, sick: 1, noShow: 1, other: 1, expectedShifts: 4, lastAbsentDate: '2026-11-05', onRoster: true, flagged: false });
    expect(ann.absenceRate).toBeCloseTo(0.75);
    expect(ann.absenceEvents.map((e) => `${e.date}:${e.kind}`)).toEqual(['2026-11-03:sick', '2026-11-04:no-show', '2026-11-05:other']);
    const bo = loc.stylists.find((s) => s.staffName === 'Bo Baker')!;
    expect(bo).toMatchObject({ scheduledShifts: 3, absences: 0, absenceRate: 0 });
    // Worst attendance first within the shop.
    expect(loc.stylists.map((s) => s.staffName)).toEqual(['Ann Able', 'Bo Baker']);
    expect(loc).toMatchObject({ scheduledShifts: 4, absences: 3, expectedShifts: 7, stylistCount: 2, stylistsAbsent: 1 });
    expect(r.totals).toMatchObject({ scheduledShifts: 4, absences: 3, sick: 1, noShow: 1, other: 1, stylistCount: 2, stylistsAbsent: 1, lateArrivals: 0 });
    expect(r.totals.absenceRate).toBeCloseTo(3 / 7);
    expect(r.lastSyncedAt).toBe('2026-11-08T09:00:00Z');
  });

  it('drops closure labels cached as absences instead of charging them to stylists', () => {
    const r = buildStaffAttendance({
      locationNameById: names, timecardRows: [],
      rosterRows: [roster('100', '2026-09-06', [out('1', 'Ann Able', 'Labor- Off'), out('2', 'Bo Baker', 'Independance Day Weekend')])],
    });
    expect(r.totals.absences).toBe(0);
    expect(r.totals.stylistCount).toBe(0);
  });

  it('attaches late arrivals by cleaned name and flags anyone over the threshold', () => {
    const r = buildStaffAttendance({
      locationNameById: names, lateThreshold: 4,
      rosterRows: [roster('100', '2026-11-02', [sched('1', 'Mary Clark (Artist)'), sched('2', 'Bo Baker')])],
      timecardRows: ['01', '02', '03', '04', '05'].map((d) => late('Brighton Mi.', 'Mary  Clark', `2026-11-${d}`)).concat([late('Brighton Mi.', 'Bo Baker', '2026-11-02')]),
    });
    const mary = r.locations[0]!.stylists.find((s) => s.staffName === 'Mary Clark')!;
    expect(mary).toMatchObject({ lateArrivals: 5, lastLateDate: '2026-11-05', flagged: true });
    const bo = r.locations[0]!.stylists.find((s) => s.staffName === 'Bo Baker')!;
    expect(bo).toMatchObject({ lateArrivals: 1, flagged: false });
    expect(r.locations[0]!.stylistsFlagged).toBe(1);
    expect(r.totals.lateArrivals).toBe(6);
    expect(r.timecardLastSyncedAt).toBe('2026-11-09T10:00:00Z');
  });

  it('splits a two-shop stylist\'s lates by reconciled location and parks the rest on the busier shop', () => {
    const r = buildStaffAttendance({
      locationNameById: names,
      sameLocation: (a, b) => a.toLowerCase().startsWith(b.toLowerCase().slice(0, 4)),
      rosterRows: [
        roster('100', '2026-11-02', [sched('1', 'Flo Floater')]),
        roster('100', '2026-11-03', [sched('1', 'Flo Floater')]),
        roster('200', '2026-11-04', [sched('1', 'Flo Floater')]),
      ],
      timecardRows: [
        late('Howell Mi', 'Flo Floater', '2026-11-04'),
        late('Somewhere Else', 'Flo Floater', '2026-11-05'),
        late('Somewhere Else', 'Flo Floater', '2026-11-06'),
      ],
    });
    const brighton = r.locations.find((l) => l.locationName === 'Brighton MI')!.stylists[0]!;
    const howell = r.locations.find((l) => l.locationName === 'Howell MI')!.stylists[0]!;
    expect(howell.lateArrivals).toBe(1);
    expect(brighton.lateArrivals).toBe(2); // unplaceable lates go where she was scheduled most
    expect(r.totals.lateArrivals).toBe(3);
  });

  it('bridges a legal-name timecard row to the preferred-name roster row by surname within the shop', () => {
    const r = buildStaffAttendance({
      locationNameById: names,
      sameLocation: (a, b) => a.toLowerCase().startsWith(b.toLowerCase().slice(0, 4)),
      rosterRows: [
        roster('100', '2026-11-02', [sched('1', 'Ali Grider (Artist)'), sched('2', 'Josh Christen (Artist)')]),
        // Same surname at ANOTHER shop must not attract the lates.
        roster('200', '2026-11-02', [sched('3', 'Pat Grider')]),
      ],
      timecardRows: [
        late('Brighton Mi.', 'Allison Grider', '2026-11-02'),
        late('Brighton Mi.', 'Alison Grider', '2026-11-03'), // the report's own typo variant
        late('Brighton Mi.', 'Joslyn Christen', '2026-11-04'),
      ],
    });
    const brighton = r.locations.find((l) => l.locationName === 'Brighton MI')!;
    expect(brighton.stylists.find((s) => s.staffName === 'Ali Grider')).toMatchObject({ lateArrivals: 2, lastLateDate: '2026-11-03', onRoster: true });
    expect(brighton.stylists.find((s) => s.staffName === 'Josh Christen')).toMatchObject({ lateArrivals: 1 });
    expect(brighton.stylists.every((s) => s.onRoster)).toBe(true);
    expect(r.locations.find((l) => l.locationName === 'Howell MI')!.stylists[0]!.lateArrivals).toBe(0);
  });

  it('leaves an ambiguous surname off-roster rather than guessing between two people', () => {
    const r = buildStaffAttendance({
      locationNameById: names,
      sameLocation: (a, b) => a.toLowerCase().startsWith(b.toLowerCase().slice(0, 4)),
      rosterRows: [roster('100', '2026-11-02', [sched('1', 'Ali Grider'), sched('2', 'Pat Grider')])],
      timecardRows: [late('Brighton Mi.', 'Allison Grider', '2026-11-02')],
    });
    const brighton = r.locations.find((l) => l.locationName === 'Brighton MI')!;
    expect(brighton.stylists.filter((s) => s.onRoster).every((s) => s.lateArrivals === 0)).toBe(true);
    expect(brighton.stylists.find((s) => !s.onRoster)).toMatchObject({ staffName: 'Allison Grider', lateArrivals: 1 });
  });

  it('counts a personal Holiday mark on an open day as time off, and ignores holiday cells on a closed day', () => {
    const hol = (id: string, name: string): Cell => ({ stylistId: id, stylistName: name, status: 'holiday' });
    const r = buildStaffAttendance({
      locationNameById: names, timecardRows: [],
      rosterRows: [
        roster('100', '2026-11-02', [hol('1', 'Ann Able'), sched('2', 'Bo Baker')]),   // open day: Ann is off
        roster('100', '2026-11-27', [hol('1', 'Ann Able'), hol('2', 'Bo Baker')]),     // closed day
      ],
    });
    const ann = r.locations[0]!.stylists.find((s) => s.staffName === 'Ann Able')!;
    expect(ann).toMatchObject({ timeOff: 1, absences: 0, scheduledShifts: 0, expectedShifts: 0, absenceRate: null });
    expect(r.totals.timeOff).toBe(1);
    expect(r.totals.absences).toBe(0);
  });

  it('lists a stylist known only from the timecard report under the matching shop, marked off-roster', () => {
    const r = buildStaffAttendance({
      locationNameById: names,
      sameLocation: (a, b) => a.toLowerCase().startsWith(b.toLowerCase().slice(0, 4)),
      rosterRows: [roster('100', '2026-11-02', [sched('1', 'Ann Able')])],
      timecardRows: [late('Howell Mi.', 'Gus Ghost', '2026-11-02')],
    });
    const howell = r.locations.find((l) => l.locationName === 'Howell MI')!;
    expect(howell.locationId).toBe('200');
    expect(howell.stylists[0]).toMatchObject({ staffName: 'Gus Ghost', onRoster: false, scheduledShifts: 0, lateArrivals: 1, absenceRate: null });
  });
});

// ── Route ────────────────────────────────────────────────────────────────
let tmp: string;
let teamSeq = 0;
function freshTeam(): string {
  const teamId = `A${teamSeq++}`;
  initializeDatabase(teamId);
  return teamId;
}
const get = (teamId: string, query: Record<string, string> = {}) =>
  handleRequest({ method: 'GET', path: '/staff-attendance', query: { team: teamId, ...query }, headers: {}, body: null }, {} as any);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'yot-staff-attendance-'));
  process.env.HOME = tmp;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('GET /staff-attendance', () => {
  it('reads the roster cache and timecard facts for the window and names locations from the locations table', async () => {
    const teamId = freshTeam();
    const { sqlite } = initializeDatabase(teamId);
    sqlite.prepare(`INSERT INTO locations (id, team_id, name, synced_at) VALUES ('100', ?, 'Brighton MI', '2026-11-01T00:00:00Z')`).run(teamId);
    const ins = sqlite.prepare(`INSERT INTO location_coverage_facts (team_id, location_id, date, slot_payload, rostered_payload, timecard_payload, computed_at, customers_per_stylist) VALUES (?, '100', ?, '{}', ?, '{}', '2026-11-08T09:00:00Z', 10)`);
    const payload = (cells: Cell[]) => JSON.stringify({ rows: cells });
    ins.run(teamId, '2026-11-02', payload([sched('1', 'Ann Able (Stylist)')]));
    ins.run(teamId, '2026-11-03', payload([out('1', 'Ann Able (Stylist)', 'Sick')]));
    ins.run(teamId, '2026-10-30', payload([out('1', 'Ann Able (Stylist)', 'Sick')])); // outside the window
    sqlite.prepare(`INSERT INTO staff_timecard_facts (id, team_id, location_name, staff_name, shift_date, arrived_minutes, raw_row, synced_at) VALUES ('t1', ?, 'Brighton Mi.', 'Ann Able', '2026-11-02', -20, '[]', '2026-11-09T10:00:00Z')`).run(teamId);

    const res: any = await get(teamId, { startDate: '2026-11-01', endDate: '2026-11-07' });
    expect(res.status).toBe(200);
    expect(res.data.scope).toEqual({ startDate: '2026-11-01', endDate: '2026-11-07', requestedEndDate: '2026-11-07' });
    expect(res.data.coverageFrom).toBe('2026-10-30');
    expect(res.data.lateThreshold).toBe(4);
    expect(res.data.locations).toHaveLength(1);
    expect(res.data.locations[0].locationName).toBe('Brighton MI');
    expect(res.data.locations[0].stylists[0]).toMatchObject({ staffName: 'Ann Able', scheduledShifts: 1, sick: 1, absences: 1, lateArrivals: 1 });
    expect(res.data.totals).toMatchObject({ scheduledShifts: 1, absences: 1, lateArrivals: 1 });
  });

  it('clamps a future end date to today and returns an empty window when the start is in the future', async () => {
    const teamId = freshTeam();
    const res: any = await get(teamId, { startDate: '2099-01-01', endDate: '2099-01-31' });
    expect(res.status).toBe(200);
    expect(res.data.scope.requestedEndDate).toBe('2099-01-31');
    expect(res.data.scope.endDate < '2099-01-01').toBe(true);
    expect(res.data.locations).toEqual([]);
    expect(res.data.totals.scheduledShifts).toBe(0);
  });
});
