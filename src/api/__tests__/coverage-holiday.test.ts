import { describe, it, expect } from 'vitest';
import { attachHolidayToCells } from '../coverage-holiday';

describe('attachHolidayToCells', () => {
  const holidays = new Map<string, string>([['2026-05-25', 'Memorial Day']]);

  it('marks a holiday cell closed with the holiday name and suppresses warnings', () => {
    const cell = { date: '2026-05-25', stylists: 3, appts: 5, required: 4, lightHours: 6, underCover: true, closed: false, hasRoster: true };
    const out = attachHolidayToCells([cell], holidays)[0];
    expect(out.closed).toBe(true);
    expect(out.holiday).toEqual({ name: 'Memorial Day' });
    expect(out.underCover).toBe(false);
    expect(out.lightHours).toBe(0);
  });

  it('leaves non-holiday cells unchanged with holiday=null', () => {
    const cell = { date: '2026-05-26', stylists: 3, appts: 5, required: 4, lightHours: 6, underCover: true, closed: false, hasRoster: true };
    const out = attachHolidayToCells([cell], holidays)[0];
    expect(out.holiday).toBeNull();
    expect(out.closed).toBe(false);
    expect(out.underCover).toBe(true);
  });
});
