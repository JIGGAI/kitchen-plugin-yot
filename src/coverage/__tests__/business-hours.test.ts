import { describe, it, expect } from 'vitest';
import { DEFAULT_BUSINESS_HOURS, resolveBusinessHoursForDate } from '../business-hours';

describe('resolveBusinessHoursForDate', () => {
  it('returns 10:00–20:00 for Mon–Thu', () => {
    // 2026-05-04 is a Monday, 05-05 Tue, 05-06 Wed, 05-07 Thu
    for (const date of ['2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07']) {
      const win = resolveBusinessHoursForDate(date);
      expect(win).toEqual({ startsAt: `${date}T10:00:00`, endsAt: `${date}T20:00:00` });
    }
  });

  it('returns 09:00–20:00 for Friday', () => {
    expect(resolveBusinessHoursForDate('2026-05-08')).toEqual({
      startsAt: '2026-05-08T09:00:00',
      endsAt: '2026-05-08T20:00:00',
    });
  });

  it('returns 09:00–17:00 for Saturday', () => {
    expect(resolveBusinessHoursForDate('2026-05-09')).toEqual({
      startsAt: '2026-05-09T09:00:00',
      endsAt: '2026-05-09T17:00:00',
    });
  });

  it('returns 09:00–15:00 for Sunday', () => {
    expect(resolveBusinessHoursForDate('2026-05-03')).toEqual({
      startsAt: '2026-05-03T09:00:00',
      endsAt: '2026-05-03T15:00:00',
    });
  });

  it('returns null when a day is configured as closed', () => {
    const closedSchedule = { ...DEFAULT_BUSINESS_HOURS, 0: null };
    expect(resolveBusinessHoursForDate('2026-05-03', closedSchedule)).toBeNull();
  });
});
