// Sync orchestrator. Pulls one week of MVC roster data, reads the day's
// appointments from the local SQLite, computes the slot table, and persists
// into `location_coverage_facts`.
//
// One MVC fetch returns a 7-day Sun-Sat block, so a single call populates
// (up to) 7 day-rows. The caller passes the week-start date; convenience
// helpers below derive the week-start from any date in the week.

import { eq, and } from 'drizzle-orm';
import { initializeDatabase } from '../db';
import * as schema from '../db/schema';
import type { YotConfig } from '../types';
import { fetchLocationRosterHtml, withAutoLogin } from '../drivers/yot-mvc-client';
import { parseRosterHtml, scheduledOnly } from './parse-roster-html';
import { computeCoverageSlots, aggregateLightWindows } from './compute';
import { resolveBusinessHoursForDate, type BusinessHoursSchedule } from './business-hours';
import {
  DEFAULT_AVERAGING_DAYS,
  DEFAULT_RATIOS,
  DOW_KEYS,
  ratioForDate,
  type AverageByDow,
  type ClosedByDow,
  type CoverageSlot,
  type CustomerToStylistRatios,
  type DayOfWeek,
} from './types';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

export type SyncCoverageOptions = {
  teamId: string;
  locationId: string;
  date: string;                        // YYYY-MM-DD; the day we want freshness for
  ratios?: CustomerToStylistRatios;    // per-day-of-week ratios; defaults below
  averagingDays?: number;              // window for daily-average computation
  slotMinutes?: number;                // default 30
  businessHours?: BusinessHoursSchedule;
};

export type SyncCoverageResult = {
  date: string;
  slots: CoverageSlot[];
  computedAt: string;
  averageDailyAppointments: number;
  customersPerStylistForDay: number;
  requiredStylists: number;
  /** Per-DOW averages (Sun..Sat). Closed days excluded from the bucket. */
  averageByDow: AverageByDow;
  /** True for any DOW the store was never open in the averaging window. */
  closedByDow: ClosedByDow;
  /** True when the *requested* date's DOW is closed by history. */
  closed: boolean;
  /** Mean appointment count per hour-of-day for the requested date's DOW.
   *  Keys are hour numbers 0–23; missing keys mean no historical activity. */
  averageHourlyForDay: Record<number, number>;
};

function readConfig(sqlite: SqliteDb, teamId: string): YotConfig {
  const row = sqlite
    .prepare("SELECT value FROM plugin_config WHERE team_id = ? AND key = 'yot'")
    .get(teamId) as { value?: string } | undefined;
  if (!row?.value) throw new Error(`No YOT config found for team ${teamId}`);
  const parsed = JSON.parse(row.value) as YotConfig;
  if (!parsed?.apiKey) throw new Error(`Invalid YOT config payload for team ${teamId}`);
  return parsed;
}

/**
 * Persist a freshly-issued MVC cookie back into plugin_config.value JSON.
 */
function persistMvcCookie(sqlite: SqliteDb, teamId: string, cookie: string): void {
  sqlite
    .prepare("UPDATE plugin_config SET value = json_set(value, '$.mvcCookie', ?) WHERE team_id = ? AND key = 'yot'")
    .run(cookie, teamId);
}

function weekStartOf(dateIso: string): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const local = new Date(y, m - 1, d);
  const sunday = new Date(local);
  sunday.setDate(local.getDate() - local.getDay()); // back up to Sunday
  const yyyy = sunday.getFullYear();
  const mm = String(sunday.getMonth() + 1).padStart(2, '0');
  const dd = String(sunday.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function readAppointmentsForDay(
  db: ReturnType<typeof initializeDatabase>['db'],
  teamId: string,
  locationId: string,
  date: string,
): Array<{ startsAt: string; endsAt: string; stylistId: string | null }> {
  const rows = db.select().from(schema.appointments)
    .where(and(eq(schema.appointments.teamId, teamId), eq(schema.appointments.locationId, locationId)))
    .all() as schema.Appointment[];
  return rows
    .map((r) => {
      const startsAt = r.startAt ?? r.startsAt;
      const endsAt = r.endAt ?? r.endsAt;
      return startsAt && endsAt && startsAt.slice(0, 10) === date
        ? { startsAt, endsAt, stylistId: (r.stylistId ?? r.staffId) ?? null }
        : null;
    })
    .filter((x): x is { startsAt: string; endsAt: string; stylistId: string | null } => x !== null);
}

/**
 * Per-day-of-week average appointment count for one location, looking back
 * `averagingDays` calendar days from `referenceDate`. Each historical date
 * is bucketed by its day-of-week, then the bucket's mean is taken over only
 * the dates the store was actually open.
 *
 * "Open" detection:
 *   - any appointments on that date  → open
 *   - within the last 30 days, also check if any stylist was rostered (we
 *     have roster history in `location_coverage_facts.rostered_payload`).
 *     A date with zero appointments BUT rostered stylists counts as open
 *     with zero demand (a real freak-slow day).
 *   - beyond 30 days the roster signal isn't available, so we fall back
 *     to "0 appointments = closed".
 *
 * Returns:
 *   - averageByDow: mean appts/day for each DOW the store was ever open
 *   - closedByDow: true for any DOW the store was never open in the window
 */
export function averageDailyAppointmentsByDow(
  db: ReturnType<typeof initializeDatabase>['db'],
  sqlite: SqliteDb,
  teamId: string,
  locationId: string,
  referenceDate: string,
  averagingDays: number,
): {
  averageByDow: AverageByDow;
  closedByDow: ClosedByDow;
  /** Per-DOW per-hour-of-day appointment averages: averageHourlyByDow[dow][hour 0-23] = mean count. */
  averageHourlyByDow: Record<DayOfWeek, Record<number, number>>;
} {
  const ref = new Date(`${referenceDate}T00:00:00`);
  const start = new Date(ref);
  start.setDate(ref.getDate() - averagingDays);
  const startIso = start.toISOString().slice(0, 10);
  const endIso = referenceDate; // exclusive end

  // 1. Daily totals come from revenue_facts.sales_count — the count of
  // distinct checkout transactions on YOT's DailySalesSummary report
  // ("Number of Sales" column). This matches the number business users
  // see in their YOT sales report. Falls back to:
  //   a) revenue_facts.appointment_count (counted from the local appointments
  //      table — line items, ~1.6× higher than sales)
  //   b) a fresh COUNT(*) over local appointments for any date revenue_facts
  //      hasn't covered yet (e.g. today, before the cron runs)
  //
  // Hourly bucketing still comes from the appointments table — DSS only
  // gives us daily totals, so the only way to know "when in the day"
  // demand peaks is to look at appointment start times. The hourly mean
  // is then scaled (further down) to sum to the DSS daily total so the
  // tooltip and headline numbers stay consistent.
  const apptCountByDate = new Map<string, number>();
  const dssRows = sqlite.prepare(
    `SELECT date, sales_count, appointment_count FROM revenue_facts
     WHERE team_id = ? AND location_id = ? AND date >= ? AND date < ?`,
  ).all(teamId, locationId, startIso, endIso) as Array<{
    date: string;
    sales_count: number | null;
    appointment_count: number | null;
  }>;
  for (const r of dssRows) {
    if (typeof r.sales_count === 'number') {
      apptCountByDate.set(r.date, r.sales_count);
    } else if (typeof r.appointment_count === 'number') {
      apptCountByDate.set(r.date, r.appointment_count);
    }
  }

  const apptRows = db.select().from(schema.appointments)
    .where(and(eq(schema.appointments.teamId, teamId), eq(schema.appointments.locationId, locationId)))
    .all() as schema.Appointment[];

  // Map<dateIso, Map<hour, count>>: how many appointments START in each
  // hour-of-day on each historical date.
  const apptCountByDateHour = new Map<string, Map<number, number>>();
  // Fallback daily count from the appointments table for dates DSS hasn't
  // covered yet.
  const apptFallbackCountByDate = new Map<string, number>();
  for (const r of apptRows) {
    const startsAt = r.startAt ?? r.startsAt;
    if (!startsAt) continue;
    const day = startsAt.slice(0, 10);
    if (day < startIso || day >= endIso) continue;
    apptFallbackCountByDate.set(day, (apptFallbackCountByDate.get(day) || 0) + 1);
    const hour = parseInt(startsAt.slice(11, 13), 10);
    if (!Number.isFinite(hour)) continue;
    let m = apptCountByDateHour.get(day);
    if (!m) { m = new Map<number, number>(); apptCountByDateHour.set(day, m); }
    m.set(hour, (m.get(hour) || 0) + 1);
  }
  // Fill DSS gaps with the appointments fallback so the open-day detection
  // and per-DOW averaging keep working for very-recent dates.
  for (const [day, count] of apptFallbackCountByDate) {
    if (!apptCountByDate.has(day)) apptCountByDate.set(day, count);
  }

  // 2. Within the strict-rule window (last 30 days), pull cached roster
  // payloads so we can also detect "open but zero appts" days.
  const strictWindowStart = new Date(ref);
  strictWindowStart.setDate(ref.getDate() - Math.min(averagingDays, 30));
  const strictStartIso = strictWindowStart.toISOString().slice(0, 10);

  const rosteredDates = new Set<string>();
  if (averagingDays > 0) {
    const rosterRows = sqlite.prepare(
      `SELECT date, rostered_payload FROM location_coverage_facts
       WHERE team_id = ? AND location_id = ? AND date >= ? AND date < ?`,
    ).all(teamId, locationId, strictStartIso, endIso) as Array<{ date: string; rostered_payload: string }>;
    for (const r of rosterRows) {
      try {
        const parsed = JSON.parse(r.rostered_payload || '{}') as { rows?: Array<{ status?: string }> };
        if ((parsed.rows || []).some((x) => x.status === 'scheduled')) {
          rosteredDates.add(r.date);
        }
      } catch { /* skip malformed cache rows */ }
    }
  }

  // 3. For each historical date in the window, decide open/closed and
  // bucket by DOW. Also accumulate per-hour totals so we can derive
  // averageHourlyByDow.
  const buckets: Record<DayOfWeek, { sum: number; openDays: number }> = {
    sun: { sum: 0, openDays: 0 }, mon: { sum: 0, openDays: 0 }, tue: { sum: 0, openDays: 0 },
    wed: { sum: 0, openDays: 0 }, thu: { sum: 0, openDays: 0 }, fri: { sum: 0, openDays: 0 },
    sat: { sum: 0, openDays: 0 },
  };
  const hourBuckets: Record<DayOfWeek, Record<number, number>> = {
    sun: {}, mon: {}, tue: {}, wed: {}, thu: {}, fri: {}, sat: {},
  };

  const cursor = new Date(start);
  while (cursor < ref) {
    const yyyy = cursor.getFullYear();
    const mm = String(cursor.getMonth() + 1).padStart(2, '0');
    const dd = String(cursor.getDate()).padStart(2, '0');
    const dateIso = `${yyyy}-${mm}-${dd}`;
    const dow = DOW_KEYS[cursor.getDay()];
    const apptCount = apptCountByDate.get(dateIso) || 0;
    const wasRostered = rosteredDates.has(dateIso);
    const isOpen = apptCount > 0 || wasRostered;
    if (isOpen) {
      buckets[dow].sum += apptCount;
      buckets[dow].openDays += 1;
      const hourMap = apptCountByDateHour.get(dateIso);
      if (hourMap) {
        for (const [hour, count] of hourMap) {
          hourBuckets[dow][hour] = (hourBuckets[dow][hour] || 0) + count;
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  const averageByDow: AverageByDow = { sun: 0, mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0 };
  const closedByDow: ClosedByDow = { sun: false, mon: false, tue: false, wed: false, thu: false, fri: false, sat: false };
  const averageHourlyByDow: Record<DayOfWeek, Record<number, number>> = {
    sun: {}, mon: {}, tue: {}, wed: {}, thu: {}, fri: {}, sat: {},
  };
  for (const dow of DOW_KEYS) {
    const b = buckets[dow];
    if (b.openDays === 0) {
      closedByDow[dow] = true;
      averageByDow[dow] = 0;
    } else {
      averageByDow[dow] = b.sum / b.openDays;
      // Hourly distribution comes from the appointments table (DSS only
      // gives daily totals, so we have no other source for "what hour"). To
      // keep the tooltip's hourly breakdown summing to the headline daily
      // avg (which is now DSS-sourced), scale each hour's appointments-based
      // mean by the ratio of the DSS daily total to the appointments-table
      // daily total for the same DOW.
      const apptHourlySum = Object.values(hourBuckets[dow]).reduce((acc, n) => acc + n, 0);
      const apptDailyAvg = apptHourlySum / b.openDays;
      const scale = apptDailyAvg > 0 ? averageByDow[dow] / apptDailyAvg : 1;
      for (const [hourStr, total] of Object.entries(hourBuckets[dow])) {
        const hour = Number(hourStr);
        averageHourlyByDow[dow][hour] = (total / b.openDays) * scale;
      }
    }
  }

  return { averageByDow, closedByDow, averageHourlyByDow };
}

function dowOf(dateIso: string): DayOfWeek {
  const [y, m, d] = dateIso.split('-').map(Number);
  return DOW_KEYS[new Date(y, m - 1, d).getDay()];
}

/**
 * Fetch one week of roster HTML, parse, then write a day-row into
 * `location_coverage_facts` for each day in the week. Returns the slots
 * for the *requested* date (the others are cached for cheap follow-up).
 */
export async function syncCoverageForLocationDay(opts: SyncCoverageOptions): Promise<SyncCoverageResult> {
  const ratios = opts.ratios ?? DEFAULT_RATIOS;
  const averagingDays = opts.averagingDays ?? DEFAULT_AVERAGING_DAYS;
  const slotMinutes = opts.slotMinutes ?? 30;
  const schedule = opts.businessHours; // undefined → DEFAULT_BUSINESS_HOURS inside resolver

  const { db, sqlite } = initializeDatabase(opts.teamId);
  const config = readConfig(sqlite, opts.teamId);

  // 1. Per-day-of-week average appointment count for this location, looking
  // back `averagingDays`. Closed days (zero appts AND no roster) are skipped
  // so they don't dilute the bucket. Required-stylists for each day in the
  // synced week is then computed from that day's specific average — so a
  // Friday's target uses Friday's average, not the global one.
  const { averageByDow, closedByDow, averageHourlyByDow } = averageDailyAppointmentsByDow(
    db, sqlite, opts.teamId, opts.locationId, opts.date, averagingDays,
  );
  // Back-compat scalar: average for the requested date's day-of-week.
  const avgDaily = averageByDow[dowOf(opts.date)];

  // 2. Fetch one week of HTML and parse. withAutoLogin re-logs in transparently
  // when mvcCookie is missing/expired AND mvcUserName/mvcPassword/mvcOrganisation
  // are configured, persisting the new cookie back to plugin_config.
  const weekStart = weekStartOf(opts.date);
  const html = await withAutoLogin(
    config,
    (cookie) => persistMvcCookie(sqlite, opts.teamId, cookie),
    (cfg) => fetchLocationRosterHtml(cfg, opts.locationId, weekStart),
    // An expired cookie returns `{"Items":[],"Any":false}` with no roster cells
    // instead of redirecting to login; probe + re-login rather than parse empty.
    { looksEmpty: (h) => !/change_staff_day_schedule/.test(h) },
  );
  const allEntries = parseRosterHtml(html);

  // 3. For each day in the week, compute slots and persist
  const computedAt = new Date().toISOString();
  const insert = sqlite.prepare(
    `INSERT OR REPLACE INTO location_coverage_facts
       (team_id, location_id, date, slot_payload, rostered_payload, timecard_payload, computed_at, customers_per_stylist)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const datesInWeek: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(`${weekStart}T00:00:00`);
    d.setDate(d.getDate() + i);
    datesInWeek.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }

  let requestedSlots: CoverageSlot[] = [];
  let requestedRequired = 0;
  let requestedRatio = ratios.weekday;
  let requestedClosed = false;
  for (const date of datesInWeek) {
    const customersPerStylistForDay = ratioForDate(date, ratios);
    const dateDow = dowOf(date);
    const dayAvg = averageByDow[dateDow];
    const dayIsClosedByHistory = closedByDow[dateDow];
    // Round-to-nearest, not ceil. Per HMX rule: 40–44 cuts → 4 stylists,
    // 45–54 → 5, 55–64 → 6 etc. (next stylist added at the .5 boundary).
    const requiredStylists = Math.round(dayAvg / customersPerStylistForDay);
    const businessHours = resolveBusinessHoursForDate(date, schedule);

    // Two separate "closed" signals:
    //   1. dayIsClosedByHistory: store has never had an appointment on this DOW
    //      across the averaging window. Strongest signal that the store is
    //      systematically closed that day — we skip slot computation and tag
    //      the response so the dashboard can render a "Closed" badge.
    //   2. !businessHours: the configured business-hours schedule says closed.
    //      (Today these are global defaults; future per-location overrides
    //      could differ.)
    const averageHourlyForDay = averageHourlyByDow[dateDow];
    if (dayIsClosedByHistory || !businessHours) {
      const payload = {
        slots: [],
        averageDailyAppointments: dayAvg,
        customersPerStylistForDay,
        requiredStylists: 0,
        closed: true,
        averageByDow,
        closedByDow,
        averageHourlyForDay,
      };
      insert.run(opts.teamId, opts.locationId, date, JSON.stringify(payload),
        JSON.stringify({ rows: [] }), '{}', computedAt, customersPerStylistForDay);
      if (date === opts.date) {
        requestedSlots = [];
        requestedRequired = 0;
        requestedRatio = customersPerStylistForDay;
        requestedClosed = true;
      }
      continue;
    }

    const dayScheduled = scheduledOnly(allEntries.filter((e) => e.date === date))
      .map((e) => ({ stylistId: e.stylistId, startsAt: e.startsAt, endsAt: e.endsAt }));
    const dayRosteredRaw = allEntries.filter((e) => e.date === date);
    const appointments = readAppointmentsForDay(db, opts.teamId, opts.locationId, date);

    const slots = computeCoverageSlots({
      date,
      businessHours,
      slotMinutes,
      requiredStylists,
      averageDailyAppointments: dayAvg,
      customersPerStylistForDay,
      appointments,
      scheduled: dayScheduled,
    });

    insert.run(
      opts.teamId, opts.locationId, date,
      JSON.stringify({
        slots,
        averageDailyAppointments: dayAvg,
        customersPerStylistForDay,
        requiredStylists,
        closed: false,
        averageByDow,
        closedByDow,
        averageHourlyForDay,
      }),
      JSON.stringify({ rows: dayRosteredRaw }),
      '{}',                                    // unused timecard slot
      computedAt,
      customersPerStylistForDay,
    );

    if (date === opts.date) {
      requestedSlots = slots;
      requestedRequired = requiredStylists;
      requestedRatio = customersPerStylistForDay;
      requestedClosed = false;
    }
  }

  return {
    date: opts.date,
    slots: requestedSlots,
    computedAt,
    averageDailyAppointments: avgDaily,
    customersPerStylistForDay: requestedRatio,
    requiredStylists: requestedRequired,
    averageByDow,
    closedByDow,
    closed: requestedClosed,
    averageHourlyForDay: averageHourlyByDow[dowOf(opts.date)],
  };
}

/**
 * Read the cached coverage row for one (location, date) without going to YOT.
 * Returns null when not previously synced.
 */
export function readCachedCoverage(
  teamId: string,
  locationId: string,
  date: string,
): SyncCoverageResult | null {
  const { sqlite } = initializeDatabase(teamId);
  const row = sqlite
    .prepare('SELECT slot_payload, computed_at, customers_per_stylist FROM location_coverage_facts WHERE team_id=? AND location_id=? AND date=?')
    .get(teamId, locationId, date) as { slot_payload?: string; computed_at?: string; customers_per_stylist?: number } | undefined;
  if (!row?.slot_payload) return null;
  const parsed = JSON.parse(row.slot_payload) as {
    slots: CoverageSlot[];
    averageDailyAppointments?: number;
    customersPerStylistForDay?: number;
    requiredStylists?: number;
    closed?: boolean;
    averageByDow?: AverageByDow;
    closedByDow?: ClosedByDow;
    averageHourlyForDay?: Record<number, number>;
  };
  const slots = parsed.slots;
  const customersPerStylistForDay = parsed.customersPerStylistForDay ?? row.customers_per_stylist ?? 10;
  const emptyDow: AverageByDow = { sun: 0, mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0 };
  const emptyClosed: ClosedByDow = { sun: false, mon: false, tue: false, wed: false, thu: false, fri: false, sat: false };
  return {
    date,
    slots,
    computedAt: row.computed_at as string,
    averageDailyAppointments: parsed.averageDailyAppointments ?? 0,
    customersPerStylistForDay,
    requiredStylists: parsed.requiredStylists ?? (slots[0]?.requiredStylists ?? 0),
    averageByDow: parsed.averageByDow ?? emptyDow,
    closedByDow: parsed.closedByDow ?? emptyClosed,
    closed: parsed.closed ?? false,
    averageHourlyForDay: parsed.averageHourlyForDay ?? {},
  };
}

export { aggregateLightWindows };
