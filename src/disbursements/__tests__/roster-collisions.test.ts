import { describe, it, expect } from 'vitest';
import { findRosterCollisions, type RosterEntry } from '../roster-collisions';

const entry = (over: Partial<RosterEntry> = {}): RosterEntry => ({
  staffId: '1000', firstName: 'Ada', lastName: 'Lovelace', location: 'Auburn Hills', ...over,
});

describe('findRosterCollisions', () => {
  it('returns nothing for disjoint rosters', () => {
    const corp = [entry({ staffId: '1000', location: 'Auburn Hills' })];
    const grp = [entry({ staffId: '5409', location: 'Middleburg Fl' })];
    expect(findRosterCollisions(corp, grp)).toEqual([]);
  });

  it('allows the same staff id at different locations — ids are per Branch company', () => {
    // 2026-10-15: 8480 is Nadia Anderson @ Yulee (HMX Group) and Emily
    // Mertes @ Shelby (corp). Two people, two companies, no collision.
    const corp = [entry({ staffId: '8480', firstName: 'Emily', lastName: 'Mertes', location: 'Shelby' })];
    const grp = [entry({ staffId: '8480', firstName: 'Nadia', lastName: 'Anderson', location: 'Yulee Rt. 200 FL' })];
    expect(findRosterCollisions(corp, grp)).toEqual([]);
    expect(findRosterCollisions(grp, corp)).toEqual([]);
  });

  it('flags a staff id present on both rosters at the same location', () => {
    const corp = [entry({ staffId: '7777', location: 'Troy' })];
    const grp = [entry({ staffId: '7777', location: 'Troy MI' })];
    const out = findRosterCollisions(corp, grp);
    const staff = out.find((c) => c.kind === 'staff-id');
    expect(staff).toBeDefined();
    expect(staff!.value).toBe('7777');
    expect(staff!.location).toBe('troy');
    // The shared location is itself a collision, reported alongside.
    expect(out.map((c) => c.kind).sort()).toEqual(['location', 'staff-id']);
  });

  it('flags a location present on both rosters', () => {
    const corp = [entry({ staffId: '1', location: 'Monroe' })];
    const grp = [entry({ staffId: '2', location: 'Monroe FL' })];
    const out = findRosterCollisions(corp, grp);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('location');
    expect(out[0].value).toBe('monroe');
  });

  it('ignores case, padding and state suffixes when comparing', () => {
    const corp = [entry({ staffId: ' 8955 ', location: 'Waterford ' })];
    const grp = [entry({ staffId: '8955', location: 'waterford MI' })];
    const kinds = findRosterCollisions(corp, grp).map((c) => c.kind).sort();
    expect(kinds).toEqual(['location', 'staff-id']);
  });

  it('reports each colliding value once even with several matching rows', () => {
    const corp = [entry({ staffId: '3', location: 'Troy' }), entry({ staffId: '4', location: 'Troy' })];
    const grp = [entry({ staffId: '5', location: 'Troy' })];
    expect(findRosterCollisions(corp, grp)).toHaveLength(1);
  });

  it('is symmetric — both groups see the same collision', () => {
    const corp = [entry({ staffId: '7777', location: 'Troy' })];
    const grp = [entry({ staffId: '7777', location: 'Troy' })];
    expect(findRosterCollisions(corp, grp)).toHaveLength(2);
    expect(findRosterCollisions(grp, corp)).toHaveLength(2);
  });

  it('names both sides in the detail so the alert is actionable', () => {
    const corp = [entry({ staffId: '7777', firstName: 'Marcella', lastName: 'Belles', location: 'Troy' })];
    const grp = [entry({ staffId: '7777', firstName: 'Marcy', lastName: 'Belles', location: 'Troy MI' })];
    const staff = findRosterCollisions(corp, grp).find((c) => c.kind === 'staff-id')!;
    expect(staff.detail).toContain('Marcella Belles @ Troy');
    expect(staff.detail).toContain('Marcy Belles @ Troy MI');
  });
});
