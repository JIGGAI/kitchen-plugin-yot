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
import type { CoverageSlot } from './types';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

export type SyncCoverageOptions = {
  teamId: string;
  locationId: string;
  date: string;                        // YYYY-MM-DD; the day we want freshness for
  customersPerStylist?: number;        // default 10
  slotMinutes?: number;                // default 30
  businessHours?: BusinessHoursSchedule;
};

export type SyncCoverageResult = {
  date: string;
  slots: CoverageSlot[];
  computedAt: string;
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
 * Fetch one week of roster HTML, parse, then write a day-row into
 * `location_coverage_facts` for each day in the week. Returns the slots
 * for the *requested* date (the others are cached for cheap follow-up).
 */
export async function syncCoverageForLocationDay(opts: SyncCoverageOptions): Promise<SyncCoverageResult> {
  const customersPerStylist = opts.customersPerStylist ?? 10;
  const slotMinutes = opts.slotMinutes ?? 30;
  const schedule = opts.businessHours; // undefined → DEFAULT_BUSINESS_HOURS inside resolver

  const { db, sqlite } = initializeDatabase(opts.teamId);
  const config = readConfig(sqlite, opts.teamId);

  // 1. Fetch one week of HTML and parse. withAutoLogin re-logs in transparently
  // when mvcCookie is missing/expired AND mvcUserName/mvcPassword/mvcOrganisation
  // are configured, persisting the new cookie back to plugin_config.
  const weekStart = weekStartOf(opts.date);
  const html = await withAutoLogin(
    config,
    (cookie) => persistMvcCookie(sqlite, opts.teamId, cookie),
    (cfg) => fetchLocationRosterHtml(cfg, opts.locationId, weekStart),
  );
  const allEntries = parseRosterHtml(html);

  // 2. For each day in the week, compute slots and persist
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
  for (const date of datesInWeek) {
    const businessHours = resolveBusinessHoursForDate(date, schedule);
    if (!businessHours) {
      // Store closed: persist empty slot table so the API returns a clean 200.
      insert.run(opts.teamId, opts.locationId, date, JSON.stringify({ slots: [] }),
        JSON.stringify({ rows: [] }), '{}', computedAt, customersPerStylist);
      if (date === opts.date) requestedSlots = [];
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
      customersPerStylist,
      appointments,
      scheduled: dayScheduled,
    });

    insert.run(
      opts.teamId, opts.locationId, date,
      JSON.stringify({ slots }),
      JSON.stringify({ rows: dayRosteredRaw }),
      '{}',                                    // unused timecard slot
      computedAt,
      customersPerStylist,
    );

    if (date === opts.date) requestedSlots = slots;
  }

  return { date: opts.date, slots: requestedSlots, computedAt };
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
    .prepare('SELECT slot_payload, computed_at FROM location_coverage_facts WHERE team_id=? AND location_id=? AND date=?')
    .get(teamId, locationId, date) as { slot_payload?: string; computed_at?: string } | undefined;
  if (!row?.slot_payload) return null;
  const parsed = JSON.parse(row.slot_payload) as { slots: CoverageSlot[] };
  return { date, slots: parsed.slots, computedAt: row.computed_at as string };
}

export { aggregateLightWindows };
