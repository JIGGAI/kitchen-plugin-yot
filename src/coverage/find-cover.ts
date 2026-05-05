// "Find cover" — for a chosen window at a location, list stylists who could work it.
//
// Pool semantics:
//   - 'same'  : only stylists whose home location is the requested location.
//   - 'cross' : every known stylist (default). Includes staff not rostered
//               anywhere that day — useful for calling people in on a day off.
//
// Filtering:
//   1. Drop staff with an appointment overlapping [from, to] anywhere.
//   2. Compute the gap window:
//      - For staff scheduled today, intersect their roster shift with [from, to].
//      - For non-rostered staff, treat the requested window as the full gap.
//   3. If `serviceMinutes` is supplied, drop staff whose gap is shorter.
//
// Ranking:
//   qualifiedHere desc → rosteredToday desc → gapMinutes desc → lastWorkedHereAt desc.
// Rationale: prefer someone qualified and already on the clock; only suggest
// calling someone in on their day off if no rostered staff fits.

import type { Interval, StylistInterval } from './types';

export type FindCoverPool = 'cross' | 'same';

export type StylistRecord = {
  id: string;
  name: string;
  homeLocationId: string | null;
};

export type FindCoverInputs = {
  locationId: string;
  from: string;                                            // ISO datetime
  to: string;                                              // ISO datetime
  serviceMinutes: number;                                  // 0 disables length filter
  pool: FindCoverPool;
  stylists: StylistRecord[];
  scheduled: StylistInterval[];                            // across all locations today
  appointments: Array<Interval & { stylistId: string }>;   // across all locations
  pastAppointmentsAtLocation: Map<string, string>;         // stylistId -> last ISO ts at this loc
};

export type CoverCandidate = {
  stylistId: string;
  name: string;
  homeLocationId: string | null;
  qualifiedHere: boolean;
  rosteredToday: boolean;
  gapStart: string;
  gapEnd: string;
  gapMinutes: number;
  lastWorkedHereAt: string | null;
};

function overlaps(a: Interval, b: Interval): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

function minutesBetween(a: string, b: string): number {
  return Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

function maxIso(a: string, b: string): string { return a > b ? a : b; }
function minIso(a: string, b: string): string { return a < b ? a : b; }

export function findStaffAvailable(input: FindCoverInputs): CoverCandidate[] {
  const requestedWindow = { startsAt: input.from, endsAt: input.to };
  const out: CoverCandidate[] = [];

  for (const s of input.stylists) {
    if (input.pool === 'same' && s.homeLocationId !== input.locationId) continue;

    const myAppointments = input.appointments.filter((a) => a.stylistId === s.id);
    if (myAppointments.some((a) => overlaps(a, requestedWindow))) continue;

    const myRoster = input.scheduled.filter((r) => r.stylistId === s.id);
    let gapStart: string;
    let gapEnd: string;

    if (myRoster.length > 0) {
      const overlappingShifts = myRoster.filter((r) => overlaps(r, requestedWindow));
      if (overlappingShifts.length === 0) continue; // rostered today, but not for this window
      // Choose the largest overlap so a split shift doesn't accidentally exclude us.
      const seg = overlappingShifts.reduce((best, r) => {
        const candStart = maxIso(r.startsAt, input.from);
        const candEnd = minIso(r.endsAt, input.to);
        const candMin = minutesBetween(candStart, candEnd);
        const bestStart = maxIso(best.startsAt, input.from);
        const bestEnd = minIso(best.endsAt, input.to);
        const bestMin = minutesBetween(bestStart, bestEnd);
        return candMin > bestMin ? r : best;
      }, overlappingShifts[0]);
      gapStart = maxIso(seg.startsAt, input.from);
      gapEnd = minIso(seg.endsAt, input.to);
    } else {
      // Not rostered today — treat as fully free across the requested window.
      gapStart = input.from;
      gapEnd = input.to;
    }

    const gapMinutes = minutesBetween(gapStart, gapEnd);
    if (input.serviceMinutes > 0 && gapMinutes < input.serviceMinutes) continue;

    const lastWorkedHereAt = input.pastAppointmentsAtLocation.get(s.id) ?? null;
    const qualifiedHere = s.homeLocationId === input.locationId || lastWorkedHereAt != null;
    const rosteredToday = myRoster.length > 0;

    out.push({
      stylistId: s.id,
      name: s.name,
      homeLocationId: s.homeLocationId,
      qualifiedHere,
      rosteredToday,
      gapStart,
      gapEnd,
      gapMinutes,
      lastWorkedHereAt,
    });
  }

  return out.sort((a, b) =>
    Number(b.qualifiedHere) - Number(a.qualifiedHere) ||
    Number(b.rosteredToday) - Number(a.rosteredToday) ||
    b.gapMinutes - a.gapMinutes ||
    String(b.lastWorkedHereAt || '').localeCompare(String(a.lastWorkedHereAt || '')),
  );
}
