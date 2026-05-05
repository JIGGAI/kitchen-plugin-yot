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
  customersPerStylist: number;        // typically 10
  appointments: AppointmentInterval[];
  scheduled: StylistInterval[];
};
