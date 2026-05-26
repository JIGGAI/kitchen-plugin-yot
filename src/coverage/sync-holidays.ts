// Sync public holidays from the YOT MVC /Staff/PublicHolidays/List page into
// the local SQLite `public_holidays` table, and helpers to read them back.
// YOT is the source of truth; we never write holidays back to YOT.

import { initializeDatabase } from '../db';
import type { YotConfig } from '../types';
import { fetchPublicHolidaysHtml, withAutoLogin } from '../drivers/yot-mvc-client';
import { parsePublicHolidaysHtml, type PublicHolidayEntry } from './parse-public-holidays-html';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

export type SyncHolidaysResult = { syncedAt: string; count: number };

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

/** Replace all of a team's holiday rows with `entries` in a single transaction. */
export function replaceHolidays(sqlite: SqliteDb, teamId: string, entries: PublicHolidayEntry[]): string {
  const syncedAt = new Date().toISOString();
  const del = sqlite.prepare('DELETE FROM public_holidays WHERE team_id = ?');
  const ins = sqlite.prepare(
    'INSERT INTO public_holidays (team_id, holiday_id, name, date, synced_at) VALUES (?, ?, ?, ?, ?)',
  );
  const tx = sqlite.transaction((rows: PublicHolidayEntry[]) => {
    del.run(teamId);
    for (const r of rows) ins.run(teamId, r.holidayId, r.name, r.date, syncedAt);
  });
  tx(entries);
  return syncedAt;
}

/** date (YYYY-MM-DD) → holiday name, for the subset of `dates` that are holidays. */
export function holidaysByDate(sqlite: SqliteDb, teamId: string, dates: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (dates.length === 0) return out;
  const placeholders = dates.map(() => '?').join(',');
  const rows = sqlite
    .prepare(`SELECT date, name FROM public_holidays WHERE team_id = ? AND date IN (${placeholders})`)
    .all(teamId, ...dates) as Array<{ date: string; name: string }>;
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

export async function syncPublicHolidays(opts: { teamId: string }): Promise<SyncHolidaysResult> {
  const { teamId } = opts;
  const { sqlite } = initializeDatabase(teamId);
  const config = readConfig(sqlite, teamId);
  const html = await withAutoLogin(
    config,
    (cookie) => persistMvcCookie(sqlite, teamId, cookie),
    (cfg) => fetchPublicHolidaysHtml(cfg),
    { looksEmpty: (h) => !/itemId=/i.test(h) },
  );
  const entries = parsePublicHolidaysHtml(html);
  const syncedAt = replaceHolidays(sqlite, teamId, entries);
  return { syncedAt, count: entries.length };
}
