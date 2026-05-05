import { describe, it, expect } from 'vitest';
import { findStaffAvailable } from '../find-cover';

const baseInputs = (overrides: any = {}) => ({
  locationId: 'L1',
  from: '2026-05-05T09:30:00',
  to: '2026-05-05T11:00:00',
  serviceMinutes: 30,
  pool: 'cross' as const,
  stylists: [
    { id: 's1', name: 'Sarah', homeLocationId: 'L1' },
    { id: 's2', name: 'Mike', homeLocationId: 'L2' },
    { id: 's3', name: 'Jen', homeLocationId: 'L1' },
  ],
  scheduled: [],
  appointments: [],
  pastAppointmentsAtLocation: new Map<string, string>(),
  ...overrides,
});

describe('findStaffAvailable', () => {
  it('returns rostered staff with gap covering the requested window', () => {
    const out = findStaffAvailable(baseInputs({
      scheduled: [
        { stylistId: 's1', startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T13:00:00' },
      ],
    }));
    expect(out).toHaveLength(3); // s1 rostered, s2/s3 included as non-rostered (cross pool)
    const s1 = out.find((o) => o.stylistId === 's1')!;
    expect(s1.rosteredToday).toBe(true);
    expect(s1.gapMinutes).toBe(90); // 09:30 → 11:00 (clipped to requested window)
    expect(s1.qualifiedHere).toBe(true); // home is L1
    expect(s1.gapStart).toBe('2026-05-05T09:30:00');
    expect(s1.gapEnd).toBe('2026-05-05T11:00:00');
  });

  it('drops staff with an overlapping appointment', () => {
    const out = findStaffAvailable(baseInputs({
      scheduled: [{ stylistId: 's1', startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T13:00:00' }],
      appointments: [{ stylistId: 's1', startsAt: '2026-05-05T10:00:00', endsAt: '2026-05-05T10:30:00' }],
    }));
    expect(out.find((o) => o.stylistId === 's1')).toBeUndefined();
  });

  it('drops staff whose gap is shorter than serviceMinutes', () => {
    const out = findStaffAvailable(baseInputs({
      serviceMinutes: 120,
      scheduled: [{ stylistId: 's1', startsAt: '2026-05-05T10:30:00', endsAt: '2026-05-05T11:00:00' }],
    }));
    // s1 has only a 30-min overlap with the requested window, < 120
    expect(out.find((o) => o.stylistId === 's1')).toBeUndefined();
  });

  it('drops a rostered-today stylist with no overlap with the requested window', () => {
    const out = findStaffAvailable(baseInputs({
      pool: 'cross',
      scheduled: [{ stylistId: 's1', startsAt: '2026-05-05T13:00:00', endsAt: '2026-05-05T17:00:00' }],
    }));
    // s1's shift starts after the requested window ends; should be dropped.
    expect(out.find((o) => o.stylistId === 's1')).toBeUndefined();
  });

  it('includes non-rostered staff in the cross pool', () => {
    const out = findStaffAvailable(baseInputs({
      scheduled: [], // nobody rostered
    }));
    // All 3 stylists should appear; qualifiedHere wins ranking
    expect(out.map((o) => o.stylistId)).toEqual(['s1', 's3', 's2']);
    expect(out[0].rosteredToday).toBe(false);
    expect(out[0].gapStart).toBe('2026-05-05T09:30:00');
    expect(out[0].gapEnd).toBe('2026-05-05T11:00:00');
  });

  it('drops non-home-location staff in the same pool', () => {
    const out = findStaffAvailable(baseInputs({
      pool: 'same',
      scheduled: [{ stylistId: 's2', startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T13:00:00' }],
    }));
    expect(out.map((o) => o.stylistId)).not.toContain('s2');
  });

  it('marks qualifiedHere=true via past appointments at this location', () => {
    const past = new Map<string, string>([['s2', '2026-04-20T15:00:00']]);
    const out = findStaffAvailable(baseInputs({ pastAppointmentsAtLocation: past }));
    const s2 = out.find((o) => o.stylistId === 's2')!;
    expect(s2.qualifiedHere).toBe(true);
    expect(s2.lastWorkedHereAt).toBe('2026-04-20T15:00:00');
  });

  it('ranks rostered+qualified above non-rostered+qualified above unqualified', () => {
    const out = findStaffAvailable(baseInputs({
      scheduled: [
        { stylistId: 's3', startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T13:00:00' },
      ],
    }));
    // s3 rostered+qualified → first; s1 non-rostered+qualified → second; s2 unqualified+non-rostered → third
    expect(out.map((o) => o.stylistId)).toEqual(['s3', 's1', 's2']);
  });
});
