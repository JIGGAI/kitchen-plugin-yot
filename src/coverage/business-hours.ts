// Per-day-of-week business hours.
//
// Hair Mechanix store hours (Eastern Time):
//   Mon–Thu: 10:00 – 20:00
//   Fri:      9:00 – 20:00
//   Sat:      9:00 – 17:00
//   Sun:      9:00 – 15:00
//
// We model this as a map keyed by JS Date.getDay() (0=Sun..6=Sat). Hours are
// stored as local-naive `HH:MM` strings; resolveBusinessHoursForDate combines
// them with a YYYY-MM-DD date to produce the local-naive Interval that
// computeCoverageSlots expects.
//
// Per-location override is intentionally not in v1. When YotConfig grows a
// `coverage.businessHours` block we'll merge it over the default here.

import type { Interval } from './types';

export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun..6=Sat

export type DayHours = { open: string; close: string }; // 'HH:MM'

export type BusinessHoursSchedule = Record<DayOfWeek, DayHours | null>;

export const DEFAULT_BUSINESS_HOURS: BusinessHoursSchedule = {
  0: { open: '09:00', close: '15:00' }, // Sun
  1: { open: '10:00', close: '20:00' }, // Mon
  2: { open: '10:00', close: '20:00' }, // Tue
  3: { open: '10:00', close: '20:00' }, // Wed
  4: { open: '10:00', close: '20:00' }, // Thu
  5: { open: '09:00', close: '20:00' }, // Fri
  6: { open: '09:00', close: '17:00' }, // Sat
};

function dayOfWeekFor(dateIso: string): DayOfWeek {
  // Use parseInt rather than `new Date(date).getDay()` to avoid TZ surprises:
  // we treat the date as a local calendar day, so Zeller's-like math is safer.
  const [y, m, d] = dateIso.split('-').map(Number);
  // JS: Date(year, month-1, day) → local-zone date → getDay() returns 0..6
  return new Date(y, m - 1, d).getDay() as DayOfWeek;
}

export function resolveBusinessHoursForDate(
  dateIso: string,
  schedule: BusinessHoursSchedule = DEFAULT_BUSINESS_HOURS,
): Interval | null {
  const dow = dayOfWeekFor(dateIso);
  const hours = schedule[dow];
  if (!hours) return null; // store closed that day
  return {
    startsAt: `${dateIso}T${hours.open}:00`,
    endsAt: `${dateIso}T${hours.close}:00`,
  };
}
