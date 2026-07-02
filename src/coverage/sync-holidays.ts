// Sync public holidays from the YOT MVC /Staff/PublicHolidays/List page into
// the local SQLite `public_holidays` table, and helpers to read them back.
// YOT is the source of truth; we never write holidays back to YOT.

import { initializeDatabase } from '../db';
import type { YotConfig } from '../types';
import {
  fetchPublicHolidaysHtml,
  fetchPublicHolidayEditHtml,
  withAutoLogin,
  MvcAuthExpiredError,
  MvcAuthMissingError,
} from '../drivers/yot-mvc-client';
import {
  parsePublicHolidaysHtml,
  parseHolidayEditLocations,
  type PublicHolidayEntry,
} from './parse-public-holidays-html';

/** holidayId → the location ids that holiday closes (from its Edit page). */
export type HolidayScoping = Map<string, string[]>;

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

function readConfig(sqlite: SqliteDb, teamId: string): YotConfig {
  const row = sqlite
    .prepare("SELECT value FROM plugin_config WHERE team_id = ? AND key = 'yot'")
    .get(teamId) as { value?: string } | undefined;
  if (!row?.value) throw new Error(`No YOT config found for team ${teamId}`);
  const parsed = JSON.parse(row.value) as YotConfig;
  if (!parsed?.apiKey) throw new Error(`Invalid YOT config payload for team ${teamId}`);
  return parsed;
}

function persistMvcCookie(sqlite: SqliteDb, teamId: string, cookie: string): void {
  sqlite
    .prepare("UPDATE plugin_config SET value = json_set(value, '$.mvcCookie', ?) WHERE team_id = ? AND key = 'yot'")
    .run(cookie, teamId);
}

/**
 * Replace all of a team's holiday rows with `entries` in a single transaction.
 * When `scoping` is provided, also replaces per-holiday location rows: an entry
 * for a holidayId whose value is a non-empty array closes only those locations;
 * a holiday absent from `scoping` (or with an empty array) has no rows and
 * therefore closes ALL locations (see holidaysByDate / migration 0020).
 */
export function replaceHolidays(
  sqlite: SqliteDb,
  teamId: string,
  entries: PublicHolidayEntry[],
  scoping?: HolidayScoping,
): string {
  const syncedAt = new Date().toISOString();
  const del = sqlite.prepare('DELETE FROM public_holidays WHERE team_id = ?');
  const ins = sqlite.prepare(
    'INSERT INTO public_holidays (team_id, holiday_id, name, date, synced_at) VALUES (?, ?, ?, ?, ?)',
  );
  const delLoc = sqlite.prepare('DELETE FROM public_holiday_locations WHERE team_id = ?');
  const insLoc = sqlite.prepare(
    'INSERT OR IGNORE INTO public_holiday_locations (team_id, holiday_id, location_id) VALUES (?, ?, ?)',
  );
  const tx = sqlite.transaction((rows: PublicHolidayEntry[]) => {
    del.run(teamId);
    delLoc.run(teamId);
    for (const r of rows) ins.run(teamId, r.holidayId, r.name, r.date, syncedAt);
    if (scoping) {
      for (const [holidayId, locationIds] of scoping) {
        for (const locId of locationIds) insLoc.run(teamId, holidayId, locId);
      }
    }
  });
  tx(entries);
  return syncedAt;
}

/**
 * date (YYYY-MM-DD) → holiday name, for the subset of `dates` that are holidays.
 *
 * When `locationId` is given, a date only counts as a holiday if it closes that
 * location: the holiday either has NO location-scoping rows (closes all — the
 * unscraped/back-compat default) OR has a row for `locationId`. Without a
 * locationId the lookup is team-wide (any holiday on the date), preserving the
 * original org-wide behaviour for callers that don't have a location in scope.
 */
export function holidaysByDate(
  sqlite: SqliteDb,
  teamId: string,
  dates: string[],
  locationId?: string,
): Map<string, string> {
  const out = new Map<string, string>();
  if (dates.length === 0) return out;
  const placeholders = dates.map(() => '?').join(',');
  if (!locationId) {
    const rows = sqlite
      .prepare(`SELECT date, name FROM public_holidays WHERE team_id = ? AND date IN (${placeholders})`)
      .all(teamId, ...dates) as Array<{ date: string; name: string }>;
    for (const r of rows) out.set(r.date, r.name);
    return out;
  }
  const rows = sqlite
    .prepare(
      `SELECT h.date AS date, h.name AS name
         FROM public_holidays h
        WHERE h.team_id = ? AND h.date IN (${placeholders})
          AND (
            NOT EXISTS (
              SELECT 1 FROM public_holiday_locations l
               WHERE l.team_id = h.team_id AND l.holiday_id = h.holiday_id
            )
            OR EXISTS (
              SELECT 1 FROM public_holiday_locations l
               WHERE l.team_id = h.team_id AND l.holiday_id = h.holiday_id AND l.location_id = ?
            )
          )`,
    )
    .all(teamId, ...dates, locationId) as Array<{ date: string; name: string }>;
  for (const r of rows) out.set(r.date, r.name);
  return out;
}

export type PublicHolidayRow = { holidayId: string; name: string; date: string };

export function listPublicHolidays(teamId: string, from?: string, to?: string): PublicHolidayRow[] {
  const { sqlite } = initializeDatabase(teamId);
  let sql = 'SELECT holiday_id AS holidayId, name, date FROM public_holidays WHERE team_id = ?';
  const args: string[] = [teamId];
  if (from) { sql += ' AND date >= ?'; args.push(from); }
  if (to) { sql += ' AND date <= ?'; args.push(to); }
  sql += ' ORDER BY date';
  return sqlite.prepare(sql).all(...args) as PublicHolidayRow[];
}

export type SyncHolidaysResult = { syncedAt: string; count: number; scopedCount: number };

export async function syncPublicHolidays(opts: { teamId: string }): Promise<SyncHolidaysResult> {
  const { teamId } = opts;
  const { sqlite } = initializeDatabase(teamId);
  const config = readConfig(sqlite, teamId);
  // Fetch the list AND each holiday's per-location scoping under a single
  // auto-login wrapper: a mid-walk session expiry re-logs in and retries the
  // whole op once (rather than half-writing scoping against a dead cookie).
  const { entries, scoping } = await withAutoLogin(
    config,
    (cookie) => persistMvcCookie(sqlite, teamId, cookie),
    async (cfg) => {
      const listHtml = await fetchPublicHolidaysHtml(cfg);
      const parsed = parsePublicHolidaysHtml(listHtml);
      const scope: HolidayScoping = new Map();
      for (const entry of parsed) {
        // Auth errors must propagate so withAutoLogin can re-login + retry.
        // Any other per-holiday failure is tolerated: we skip its scoping,
        // which falls back to closing all locations (safer than showing open).
        try {
          const editHtml = await fetchPublicHolidayEditHtml(cfg, entry.holidayId);
          const { found, closedLocationIds } = parseHolidayEditLocations(editHtml);
          if (found) scope.set(entry.holidayId, closedLocationIds);
        } catch (err) {
          if (err instanceof MvcAuthExpiredError || err instanceof MvcAuthMissingError) throw err;
          // swallow — leave this holiday unscoped (closes-all fallback)
        }
      }
      return { entries: parsed, scoping: scope };
    },
    { looksEmpty: (r) => r.entries.length === 0 },
  );
  const syncedAt = replaceHolidays(sqlite, teamId, entries, scoping);
  let scopedCount = 0;
  for (const ids of scoping.values()) if (ids.length > 0) scopedCount++;
  return { syncedAt, count: entries.length, scopedCount };
}
