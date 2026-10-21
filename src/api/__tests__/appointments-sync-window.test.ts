import { describe, it, expect } from 'vitest';
import { resolveAppointmentsSyncWindow } from '../handler';

// The appointments cache floor is wherever the last backfill reached, because
// lookbackDays is clamped to 365 from today. An explicit startDate/endDate
// pair lets a backfill walk arbitrarily far back, one bounded window per call.

const NOW = Date.parse('2026-10-20T16:00:00Z');
const auto = () => 30;

describe('resolveAppointmentsSyncWindow', () => {
  it('an explicit startDate/endDate pair is the window, whole local days, no clamp to today', () => {
    const w = resolveAppointmentsSyncWindow({ startDate: '2024-05-24', endDate: '2025-05-23' }, NOW, auto);
    expect(w.mode).toBe('explicit');
    expect(w.windowStartDate).toBe('2024-05-24');
    expect(w.windowEndDate).toBe('2025-05-23');
    expect(w.date).toBe(new Date('2024-05-24T00:00:00').getTime());
    expect(w.enddate).toBe(new Date('2025-05-23T23:59:59.999').getTime());
    expect(w.lookbackDays).toBe(365);
    expect(w.forwardDays).toBe(0);
    expect(w.note).toContain('startDate=2024-05-24');
  });

  it('refuses a half pair, a bad date, a reversed pair, and a window over 400 days', () => {
    expect(() => resolveAppointmentsSyncWindow({ startDate: '2024-05-24' }, NOW, auto)).toThrow(/startDate and endDate/);
    expect(() => resolveAppointmentsSyncWindow({ startDate: '2024-5-24', endDate: '2025-05-23' }, NOW, auto)).toThrow(/YYYY-MM-DD/);
    expect(() => resolveAppointmentsSyncWindow({ startDate: '2025-05-23', endDate: '2024-05-24' }, NOW, auto)).toThrow(/before/);
    expect(() => resolveAppointmentsSyncWindow({ startDate: '2023-01-01', endDate: '2025-05-23' }, NOW, auto)).toThrow(/400/);
  });

  it('without the pair, lookbackDays still clamps to 365 and forwardDays to 0..365', () => {
    const w = resolveAppointmentsSyncWindow({ lookbackDays: '9999', forwardDays: '3' }, NOW, auto);
    expect(w.mode).toBe('lookback');
    expect(w.lookbackDays).toBe(365);
    expect(w.forwardDays).toBe(3);
    expect(w.date).toBe(NOW - 365 * 86_400_000);
    expect(w.enddate).toBe(NOW + 3 * 86_400_000);
    expect(w.windowStartDate).toBe(new Date(NOW - 365 * 86_400_000).toISOString().slice(0, 10));
    expect(w.note).toBe('lookbackDays=365; forwardDays=3');
  });

  it('without any window param it auto-resumes from the cache', () => {
    const w = resolveAppointmentsSyncWindow({}, NOW, () => 7);
    expect(w.mode).toBe('lookback');
    expect(w.lookbackDays).toBe(7);
    expect(w.note).toBe('lookbackDays=7 (auto-resume); forwardDays=0');
  });
});
