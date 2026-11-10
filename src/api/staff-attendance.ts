// Staff Attendance: per-stylist absences and late arrivals for a window.
//
// Absences come from the roster grid cached in location_coverage_facts —
// when a manager marks a stylist out, YOT replaces the shift time with a red
// reason label ("Sick", "No Show", …) and the parser stores the cell as
// status 'absent' with that reason. Store-wide closures carry a label too,
// so every cached reason is re-classified here against CLOSURE_REASON_RE
// rather than trusting the status alone: labels added to the closure list
// after a week was cached would otherwise count as call-offs forever.
//
// Late arrivals come from staff_timecard_facts, which only holds shifts
// clocked in 15+ minutes late (the report is pre-filtered server-side), so
// a row is a late arrival by definition.
//
// A personal "Holiday" mark looks exactly like a store closure to the parser
// (both are a red label, and "holiday" is on the closure list), so holiday
// cells are read against the day: on a day the shop had anyone scheduled,
// a holiday cell is that stylist's time off and is counted, not penalised;
// on a day nobody was scheduled it is a closure and ignored.
//
// The two sources share no id: the roster is keyed by YOT stylist id with a
// preferred display name ("Ali Grider (Artist)"), the timecard report by
// legal full name ("Allison Grider") within a report-spelled location. They
// are bridged by cleaned, case-folded full name first, then by surname within
// the same shop when exactly one roster person there carries it. A person
// rostered at one shop gets all their lates there; someone rostered at
// several gets each shop's lates where the location names reconcile, and
// whatever cannot be placed lands on the shop where they were scheduled most,
// so no late is ever dropped or counted twice.

import { CLOSURE_REASON_RE } from '../coverage/parse-roster-html';

export type AbsenceKind = 'sick' | 'no-show' | 'other';

export type RosterFactRow = {
  locationId: string;
  date: string;              // YYYY-MM-DD
  rosteredPayload: string | null;
  computedAt: string | null;
};

export type TimecardFactRow = {
  locationName: string | null;
  staffName: string;
  shiftDate: string;         // YYYY-MM-DD
  arrivedMinutes: number | null;
  syncedAt: string | null;
};

export type AbsenceEvent = { date: string; kind: AbsenceKind; reason: string };

export type AttendanceStylist = {
  stylistId: string | null;
  staffName: string;
  role: string | null;
  scheduledShifts: number;   // shifts with a time on the roster
  expectedShifts: number;    // scheduled + absences
  absences: number;
  sick: number;
  noShow: number;
  other: number;
  absenceRate: number | null; // absences / expectedShifts, 0..1
  timeOff: number;           // personal Holiday marks on open days (not an absence)
  lateArrivals: number;
  lastAbsentDate: string | null;
  lastLateDate: string | null;
  absenceEvents: AbsenceEvent[];
  onRoster: boolean;         // false when known only from the timecard report
  flagged: boolean;          // over the late-arrival bonus threshold
};

export type AttendanceTotals = {
  scheduledShifts: number;
  expectedShifts: number;
  absences: number;
  sick: number;
  noShow: number;
  other: number;
  absenceRate: number | null;
  timeOff: number;
  lateArrivals: number;
  stylistCount: number;
  stylistsAbsent: number;    // at least one absence in the window
  stylistsFlagged: number;
};

export type AttendanceLocation = AttendanceTotals & {
  locationId: string | null;
  locationName: string;
  stylists: AttendanceStylist[];
};

export type StaffAttendanceResult = {
  totals: AttendanceTotals;
  locations: AttendanceLocation[];
  lastSyncedAt: string | null;          // newest roster write in the window
  timecardLastSyncedAt: string | null;
};

// Reason label → absence kind, or null for a store-wide closure.
export function classifyAbsenceReason(reason: string | null | undefined): AbsenceKind | null {
  const text = String(reason ?? '').trim();
  if (!text) return 'other';
  if (CLOSURE_REASON_RE.test(text)) return null;
  if (/\bsick\b|\bill\b|illness/i.test(text)) return 'sick';
  if (/no[\s-]*show|no[\s-]*call|\bncns\b/i.test(text)) return 'no-show';
  return 'other';
}

// "Mary Clark (Artist)" → "Mary Clark"; "Heather  Davis" → "Heather Davis".
export function cleanStaffName(name: string | null | undefined): string {
  return String(name ?? '').replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim();
}

export function staffRoleOf(name: string | null | undefined): string | null {
  const m = /\(([^)]*)\)\s*$/.exec(String(name ?? ''));
  const role = m?.[1]?.trim();
  return role ? role.charAt(0).toUpperCase() + role.slice(1).toLowerCase() : null;
}

const nameKey = (name: string | null | undefined) => cleanStaffName(name).toLowerCase();

function blankTotals(): AttendanceTotals {
  return {
    scheduledShifts: 0, expectedShifts: 0, absences: 0, sick: 0, noShow: 0, other: 0,
    absenceRate: null, timeOff: 0, lateArrivals: 0, stylistCount: 0, stylistsAbsent: 0, stylistsFlagged: 0,
  };
}

function rate(absences: number, expected: number): number | null {
  return expected > 0 ? absences / expected : null;
}

type RosterRow = { stylistId?: string; stylistName?: string; status?: string; reason?: string };

export type BuildStaffAttendanceOptions = {
  rosterRows: RosterFactRow[];
  timecardRows: TimecardFactRow[];
  locationNameById: Map<string, string>;
  /** Same-shop test for roster (locations table) vs timecard (report) names. */
  sameLocation?: (rosterName: string, reportName: string) => boolean;
  lateThreshold?: number;
};

export function buildStaffAttendance(opts: BuildStaffAttendanceOptions): StaffAttendanceResult {
  const lateThreshold = opts.lateThreshold ?? 4;
  const sameLocation = opts.sameLocation
    ?? ((a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase());

  // ── 1. Roster: one bucket per (location, stylist id) ───────────────────
  type Bucket = AttendanceStylist & { locationId: string | null; locationName: string; nameKey: string };
  const buckets = new Map<string, Bucket>();
  let lastSyncedAt: string | null = null;

  const bucketFor = (locationId: string | null, locationName: string, stylistId: string | null, rawName: string): Bucket => {
    const key = `${locationId ?? locationName}::${stylistId ?? nameKey(rawName)}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        locationId, locationName, nameKey: nameKey(rawName),
        stylistId, staffName: cleanStaffName(rawName), role: staffRoleOf(rawName),
        scheduledShifts: 0, expectedShifts: 0, absences: 0, sick: 0, noShow: 0, other: 0,
        absenceRate: null, timeOff: 0, lateArrivals: 0, lastAbsentDate: null, lastLateDate: null,
        absenceEvents: [], onRoster: true, flagged: false,
      };
      buckets.set(key, b);
    }
    return b;
  };

  for (const fact of opts.rosterRows) {
    if (fact.computedAt && (!lastSyncedAt || fact.computedAt > lastSyncedAt)) lastSyncedAt = fact.computedAt;
    let rows: RosterRow[] = [];
    try {
      rows = (JSON.parse(fact.rosteredPayload || '{}') as { rows?: RosterRow[] }).rows ?? [];
    } catch { rows = []; }
    const locationName = opts.locationNameById.get(fact.locationId) || `Location ${fact.locationId}`;
    const openDay = rows.some((r) => r.status === 'scheduled');
    for (const r of rows) {
      if (!r.stylistName && !r.stylistId) continue;
      if (r.status === 'scheduled') {
        bucketFor(fact.locationId, locationName, r.stylistId ?? null, r.stylistName ?? '').scheduledShifts += 1;
      } else if (r.status === 'holiday') {
        if (openDay) bucketFor(fact.locationId, locationName, r.stylistId ?? null, r.stylistName ?? '').timeOff += 1;
      } else if (r.status === 'absent') {
        const kind = classifyAbsenceReason(r.reason);
        if (!kind) continue; // store-wide closure mislabelled as an absence
        const b = bucketFor(fact.locationId, locationName, r.stylistId ?? null, r.stylistName ?? '');
        b.absences += 1;
        if (kind === 'sick') b.sick += 1;
        else if (kind === 'no-show') b.noShow += 1;
        else b.other += 1;
        b.absenceEvents.push({ date: fact.date, kind, reason: String(r.reason ?? '').trim() || 'Out' });
        if (!b.lastAbsentDate || fact.date > b.lastAbsentDate) b.lastAbsentDate = fact.date;
      }
    }
  }

  // ── 2. Late arrivals, per person, with a per-report-location split ─────
  type LateAgg = { total: number; lastLateDate: string | null; byLocation: Map<string, number>; displayName: string };
  const lateByName = new Map<string, LateAgg>();
  let timecardLastSyncedAt: string | null = null;
  for (const t of opts.timecardRows) {
    if (t.syncedAt && (!timecardLastSyncedAt || t.syncedAt > timecardLastSyncedAt)) timecardLastSyncedAt = t.syncedAt;
    const key = nameKey(t.staffName);
    if (!key) continue;
    let agg = lateByName.get(key);
    if (!agg) {
      agg = { total: 0, lastLateDate: null, byLocation: new Map(), displayName: cleanStaffName(t.staffName) };
      lateByName.set(key, agg);
    }
    agg.total += 1;
    if (!agg.lastLateDate || t.shiftDate > agg.lastLateDate) agg.lastLateDate = t.shiftDate;
    const loc = String(t.locationName ?? '').trim();
    agg.byLocation.set(loc, (agg.byLocation.get(loc) ?? 0) + 1);
  }

  const bucketsByName = new Map<string, Bucket[]>();
  const surnameOf = (key: string) => key.split(' ').filter(Boolean).pop() ?? '';
  const bucketsBySurname = new Map<string, Bucket[]>(); // `${locKey}::${surname}`
  for (const b of buckets.values()) {
    const list = bucketsByName.get(b.nameKey) ?? [];
    list.push(b);
    bucketsByName.set(b.nameKey, list);
    const sk = `${b.locationId ?? b.locationName}::${surnameOf(b.nameKey)}`;
    const slist = bucketsBySurname.get(sk) ?? [];
    slist.push(b);
    bucketsBySurname.set(sk, slist);
  }
  const rosterLocations = [...buckets.values()].reduce((m, b) => m.set(b.locationId ?? b.locationName, b.locationName), new Map<string, string>());
  // Names the timecard report spells exactly as the roster does are spoken
  // for; a surname fallback must never steal lates from one of those.
  const exactlyMatched = new Set<Bucket>();
  for (const key of lateByName.keys()) for (const b of bucketsByName.get(key) ?? []) exactlyMatched.add(b);

  const touchLate = (b: Bucket, count: number, lastLateDate: string | null) => {
    b.lateArrivals += count;
    if (lastLateDate && (!b.lastLateDate || lastLateDate > b.lastLateDate)) b.lastLateDate = lastLateDate;
  };

  for (const [key, agg] of lateByName) {
    const rows = bucketsByName.get(key);
    if (!rows?.length) {
      // Preferred name on the roster, legal name on the report: try the
      // surname within the same shop, accepting only an unambiguous hit.
      let placed = 0;
      for (const [reportLoc, count] of agg.byLocation) {
        if (!reportLoc) continue;
        const surname = surnameOf(key);
        const hits = [...rosterLocations.entries()]
          .filter(([, name]) => sameLocation(name, reportLoc))
          .flatMap(([locKey]) => bucketsBySurname.get(`${locKey}::${surname}`) ?? [])
          .filter((b) => b.onRoster && !exactlyMatched.has(b));
        if (hits.length === 1) { touchLate(hits[0]!, count, agg.lastLateDate); placed += count; }
      }
      if (placed >= agg.total) continue;
      // Known only from the timecard report: file under the roster location
      // whose name reconciles, else a bucket named the report's way.
      const reportLoc = [...agg.byLocation.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      let locationId: string | null = null;
      let locationName = reportLoc || '(no location)';
      for (const [id, name] of opts.locationNameById) {
        if (reportLoc && sameLocation(name, reportLoc)) { locationId = id; locationName = name; break; }
      }
      const b = bucketFor(locationId, locationName, null, agg.displayName);
      b.onRoster = false;
      touchLate(b, agg.total - placed, agg.lastLateDate);
      continue;
    }
    if (rows.length === 1) {
      rows[0]!.lateArrivals = agg.total;
      rows[0]!.lastLateDate = agg.lastLateDate;
      continue;
    }
    let placed = 0;
    for (const [reportLoc, count] of agg.byLocation) {
      const home = rows.find((b) => reportLoc && sameLocation(b.locationName, reportLoc));
      if (home) { home.lateArrivals += count; placed += count; }
    }
    const remainder = agg.total - placed;
    if (remainder > 0) {
      const busiest = rows.slice().sort((a, b) => b.scheduledShifts - a.scheduledShifts || a.locationName.localeCompare(b.locationName))[0]!;
      busiest.lateArrivals += remainder;
    }
    for (const b of rows) {
      if (b.lateArrivals > 0 && (!b.lastLateDate || (agg.lastLateDate && agg.lastLateDate > b.lastLateDate))) b.lastLateDate = agg.lastLateDate;
    }
  }

  // ── 3. Finish rows, group by location, total up ────────────────────────
  const byLocation = new Map<string, AttendanceLocation>();
  for (const b of buckets.values()) {
    b.expectedShifts = b.scheduledShifts + b.absences;
    b.absenceRate = rate(b.absences, b.expectedShifts);
    b.flagged = b.lateArrivals > lateThreshold;
    b.absenceEvents.sort((x, y) => x.date.localeCompare(y.date));
    const locKey = b.locationId ?? b.locationName;
    let loc = byLocation.get(locKey);
    if (!loc) {
      loc = { ...blankTotals(), locationId: b.locationId, locationName: b.locationName, stylists: [] };
      byLocation.set(locKey, loc);
    }
    const { locationId: _l, locationName: _n, nameKey: _k, ...row } = b;
    loc.stylists.push(row);
  }

  const totals = blankTotals();
  const locations = [...byLocation.values()]
    .sort((a, b) => a.locationName.localeCompare(b.locationName))
    .map((loc) => {
      loc.stylists.sort((a, b) =>
        b.absences - a.absences || b.lateArrivals - a.lateArrivals || a.staffName.localeCompare(b.staffName));
      for (const s of loc.stylists) {
        loc.scheduledShifts += s.scheduledShifts;
        loc.timeOff += s.timeOff;
        loc.absences += s.absences;
        loc.sick += s.sick;
        loc.noShow += s.noShow;
        loc.other += s.other;
        loc.lateArrivals += s.lateArrivals;
        loc.stylistCount += 1;
        if (s.absences > 0) loc.stylistsAbsent += 1;
        if (s.flagged) loc.stylistsFlagged += 1;
      }
      loc.expectedShifts = loc.scheduledShifts + loc.absences;
      loc.absenceRate = rate(loc.absences, loc.expectedShifts);
      totals.scheduledShifts += loc.scheduledShifts;
      totals.timeOff += loc.timeOff;
      totals.absences += loc.absences;
      totals.sick += loc.sick;
      totals.noShow += loc.noShow;
      totals.other += loc.other;
      totals.lateArrivals += loc.lateArrivals;
      totals.stylistCount += loc.stylistCount;
      totals.stylistsAbsent += loc.stylistsAbsent;
      totals.stylistsFlagged += loc.stylistsFlagged;
      return loc;
    });
  totals.expectedShifts = totals.scheduledShifts + totals.absences;
  totals.absenceRate = rate(totals.absences, totals.expectedShifts);

  return { totals, locations, lastSyncedAt, timecardLastSyncedAt };
}
