import { describe, it, expect } from 'vitest';
import { parseHoursWorkedToMinutes, formatMinutesAsHours } from '../reports/staff-performance';

describe('parseHoursWorkedToMinutes', () => {
  it('parses the standard "Xh, Ym" shape', () => {
    expect(parseHoursWorkedToMinutes('8h, 0m')).toBe(480);
    expect(parseHoursWorkedToMinutes('1h, 30m')).toBe(90);
    expect(parseHoursWorkedToMinutes('8h, 45m')).toBe(525);
  });

  it('handles hours-only and minutes-only', () => {
    expect(parseHoursWorkedToMinutes('8h')).toBe(480);
    expect(parseHoursWorkedToMinutes('45m')).toBe(45);
  });

  it('handles decimals', () => {
    expect(parseHoursWorkedToMinutes('8.5h')).toBe(510);
  });

  it('treats blank / null / junk as 0', () => {
    expect(parseHoursWorkedToMinutes('')).toBe(0);
    expect(parseHoursWorkedToMinutes(null)).toBe(0);
    expect(parseHoursWorkedToMinutes(undefined)).toBe(0);
    expect(parseHoursWorkedToMinutes('n/a')).toBe(0);
    expect(parseHoursWorkedToMinutes('0h, 0m')).toBe(0);
  });
});

describe('formatMinutesAsHours', () => {
  it('formats minutes back into "Xh, Ym"', () => {
    expect(formatMinutesAsHours(480)).toBe('8h, 0m');
    expect(formatMinutesAsHours(90)).toBe('1h, 30m');
    expect(formatMinutesAsHours(525)).toBe('8h, 45m');
  });

  it('clamps non-positive / non-finite to "0h, 0m"', () => {
    expect(formatMinutesAsHours(0)).toBe('0h, 0m');
    expect(formatMinutesAsHours(-5)).toBe('0h, 0m');
    expect(formatMinutesAsHours(NaN)).toBe('0h, 0m');
  });

  it('round-trips a summed range', () => {
    const total = parseHoursWorkedToMinutes('8h, 0m') + parseHoursWorkedToMinutes('8h, 30m');
    expect(total).toBe(990);
    expect(formatMinutesAsHours(total)).toBe('16h, 30m');
  });
});
