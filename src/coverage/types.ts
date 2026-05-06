// Shared types for the staff-coverage feature.
//
// Inputs come from three sources:
//   - appointments: synced via the existing /appointments path; per-team
//     SQLite rows representing booked customer time at a location.
//   - scheduled: parsed via parseRosterHtml from the MVC LocationAvailability
//     endpoint; per-(stylist, day) shifts within business hours.
//   - businessHours, slotMinutes, customersPerStylist: configuration knobs
//     held in YotConfig (or per-call defaults).
//
// Outputs the UI consumes:
//   - CoverageSlot[]: 30-min buckets across the day with required vs
//     scheduled counts and a `light` flag.
//   - LightWindow[]: contiguous slots aggregated into actionable gaps,
//     ranked by deficit (highest first).

export type Interval = { startsAt: string; endsAt: string };

export type StylistInterval = Interval & { stylistId: string };

export type AppointmentInterval = Interval & { stylistId: string | null };

export type CoverageSlot = {
  startsAt: string;          // ISO datetime, slot start
  endsAt: string;            // ISO datetime, slot end
  customerCount: number;
  requiredStylists: number;
  scheduledStylists: number;
  light: boolean;
};

export type LightWindow = {
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  customerCount: number;     // peak across the window
  requiredStylists: number;  // peak across the window
  scheduledStylists: number; // min across the window
  deficit: number;           // requiredStylists - scheduledStylists
};

export type CoverageInputs = {
  date: string;                       // YYYY-MM-DD
  businessHours: Interval;            // local-day window we're slotting
  slotMinutes: number;                // typically 30
  /**
   * Daily required stylist count, applied uniformly to every slot. Computed
   * upstream as ceil(averageDailyAppointments / customersPerStylistForDay)
   * so the staffing target is steady across the day, not driven by per-slot
   * micro-variations.
   */
  requiredStylists: number;
  /** Backing data the UI surfaces alongside the heatmap (informational). */
  averageDailyAppointments: number;
  customersPerStylistForDay: number;  // the ratio that produced requiredStylists
  appointments: AppointmentInterval[];
  scheduled: StylistInterval[];
};

/**
 * Per-day-of-week customer-to-stylist ratios. JS Date.getDay(): 0=Sun..6=Sat.
 * Defaults: weekdays 1:10, Saturday 1:8, Sunday 1:6.
 */
export type CustomerToStylistRatios = {
  weekday: number;   // applies to Mon..Fri (1..5)
  saturday: number;  // 6
  sunday: number;    // 0
};

export const DEFAULT_RATIOS: CustomerToStylistRatios = {
  weekday: 10,
  saturday: 8,
  sunday: 6,
};

export const DEFAULT_AVERAGING_DAYS = 30;

export function ratioForDate(dateIso: string, ratios: CustomerToStylistRatios = DEFAULT_RATIOS): number {
  const [y, m, d] = dateIso.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  if (dow === 0) return ratios.sunday;
  if (dow === 6) return ratios.saturday;
  return ratios.weekday;
}
