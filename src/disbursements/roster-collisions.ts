// Cross-roster safety check for the multi-group disbursement pipeline.
//
// The groups are partitioned by roster: each nightly run pays only the staff
// on its own roster tab. That is sound only while the rosters stay disjoint —
// a stylist listed on both would be paid twice on the same night, once per
// run. This finds those overlaps so the export can exclude and report them.
//
// Staff ids are scoped to a Branch company, and each group is its own
// company, so the SAME id at DIFFERENT locations is two different people
// (RJ, 2026-10-15: e.g. 8480 is Nadia Anderson at Yulee for HMX Group and
// Emily Mertes at Shelby for corp). A staff-id collision therefore requires
// the same id at the same normalized location on both rosters.
//
// Deliberately NOT an abort: failing the run would stop payment for every
// correctly-rostered stylist because of one bad row, and would let one
// group's roster mistake break the other group's payroll. Excluding just the
// ambiguous stylist pays everyone unambiguous, pays nobody twice, and routes
// the ambiguity to a human via diagnostics + the watchdog email.
import { normalizeLocation } from './normalize';

export type RosterEntry = {
  staffId: string;
  firstName: string;
  lastName: string;
  location: string;
};

export type RosterCollision = {
  kind: 'staff-id' | 'location';
  /** The normalized colliding value — staff id, or normalized location. */
  value: string;
  /** Normalized location of the collision. For 'staff-id' this is the
   *  location both rosters list the id at; for 'location' it equals value. */
  location: string;
  /** Human-readable explanation naming both sides, for the alert email. */
  detail: string;
};

function normalizeStaffId(value: string | null | undefined): string {
  return String(value || '').trim();
}

function describe(e: RosterEntry): string {
  return `${e.firstName} ${e.lastName} @ ${e.location}`.trim();
}

export function findRosterCollisions(own: RosterEntry[], other: RosterEntry[]): RosterCollision[] {
  const collisions: RosterCollision[] = [];

  const otherByIdAndLocation = new Map<string, RosterEntry>();
  for (const e of other) {
    const id = normalizeStaffId(e.staffId);
    const loc = normalizeLocation(e.location);
    if (id && loc) otherByIdAndLocation.set(`${id}|${loc}`, e);
  }
  const seenIds = new Set<string>();
  for (const e of own) {
    const id = normalizeStaffId(e.staffId);
    const loc = normalizeLocation(e.location);
    if (!id || !loc) continue;
    const key = `${id}|${loc}`;
    if (seenIds.has(key)) continue;
    const hit = otherByIdAndLocation.get(key);
    if (!hit) continue;
    seenIds.add(key);
    collisions.push({
      kind: 'staff-id',
      value: id,
      location: loc,
      detail: `Staff id ${id} is on both rosters at the same location: ${describe(e)} and ${describe(hit)}.`,
    });
  }

  const otherByLocation = new Map<string, RosterEntry>();
  for (const e of other) {
    const loc = normalizeLocation(e.location);
    if (loc) otherByLocation.set(loc, e);
  }
  const seenLocations = new Set<string>();
  for (const e of own) {
    const loc = normalizeLocation(e.location);
    if (!loc || seenLocations.has(loc)) continue;
    const hit = otherByLocation.get(loc);
    if (!hit) continue;
    seenLocations.add(loc);
    collisions.push({
      kind: 'location',
      value: loc,
      location: loc,
      detail: `Location "${e.location}" also appears on the other roster as "${hit.location}".`,
    });
  }

  return collisions;
}
