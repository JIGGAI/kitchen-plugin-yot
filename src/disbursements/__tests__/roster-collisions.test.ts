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

  it('flags a staff id present on both rosters', () => {
    const corp = [entry({ staffId: '7777', location: 'Troy' })];
    const grp = [entry({ staffId: '7777', location: 'Middleburg Fl' })];
    const out = findRosterCollisions(corp, grp);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('staff-id');
    expect(out[0].value).toBe('7777');
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
    const grp = [entry({ staffId: '8955', location: 'Westland' })];
    const kinds = findRosterCollisions(corp, grp).map((c) => c.kind);
    expect(kinds).toEqual(['staff-id']);
  });

  it('reports each colliding value once even with several matching rows', () => {
    const corp = [entry({ staffId: '3', location: 'Troy' }), entry({ staffId: '4', location: 'Troy' })];
    const grp = [entry({ staffId: '5', location: 'Troy' })];
    expect(findRosterCollisions(corp, grp)).toHaveLength(1);
  });

  it('is symmetric — both groups see the same collision', () => {
    const corp = [entry({ staffId: '7777', location: 'Troy' })];
    const grp = [entry({ staffId: '7777', location: 'Middleburg Fl' })];
    expect(findRosterCollisions(corp, grp)).toHaveLength(1);
    expect(findRosterCollisions(grp, corp)).toHaveLength(1);
  });

  it('names both sides in the detail so the alert is actionable', () => {
    const corp = [entry({ staffId: '7777', firstName: 'Marcella', lastName: 'Belles', location: 'Troy' })];
    const grp = [entry({ staffId: '7777', firstName: 'Marcella', lastName: 'Belles', location: 'Middleburg Fl' })];
    expect(findRosterCollisions(corp, grp)[0].detail).toContain('Troy');
    expect(findRosterCollisions(corp, grp)[0].detail).toContain('Middleburg Fl');
  });
});
