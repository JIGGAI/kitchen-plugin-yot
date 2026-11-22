import type Database from 'better-sqlite3';

// Each cached appointment keeps the full YOT payload it was built from in
// `raw`. Nothing aggregates that column: only the single-appointment detail
// view shows it. Over a few years of history it becomes the largest thing in
// the database, so it is kept only for recent appointments. Every typed
// column stays for all of history.
export const DEFAULT_RAW_RETENTION_DAYS = 90;

/** Days of `raw` to keep. `YOT_APPOINTMENT_RAW_RETENTION_DAYS=0` keeps it forever. */
export function rawRetentionDays(env: Record<string, string | undefined> = process.env): number {
  const value = env.YOT_APPOINTMENT_RAW_RETENTION_DAYS;
  if (value == null || String(value).trim() === '') return DEFAULT_RAW_RETENTION_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) return DEFAULT_RAW_RETENTION_DAYS;
  return Math.floor(days);
}

/**
 * The first date whose appointments keep `raw`, as YYYY-MM-DD, or null when
 * retention is off. Appointment times are stored as local wall-clock ISO
 * strings, so a plain string comparison against this date is correct.
 */
export function rawRetentionCutoff(nowMs: number = Date.now(), days: number = rawRetentionDays()): string | null {
  if (days <= 0) return null;
  const d = new Date(nowMs - days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** What to store in `raw` for an appointment starting at `startAt`. */
export function rawForStorage(item: unknown, startAt: string | null | undefined, cutoff: string | null): string | null {
  if (cutoff && startAt && startAt < cutoff) return null;
  return JSON.stringify(item);
}

/** Clear `raw` on a team's appointments that start before `cutoff`. Returns rows changed. */
export function trimAppointmentRaw(sqlite: Database.Database, teamId: string, cutoff: string | null): number {
  if (!cutoff) return 0;
  const byStartAt = sqlite.prepare(
    `UPDATE appointments SET raw = NULL
      WHERE team_id = ? AND start_at < ? AND raw IS NOT NULL`,
  ).run(teamId, cutoff);
  // Rows from before start_at existed carry the time in starts_at only.
  const legacy = sqlite.prepare(
    `UPDATE appointments SET raw = NULL
      WHERE team_id = ? AND start_at IS NULL AND starts_at < ? AND raw IS NOT NULL`,
  ).run(teamId, cutoff);
  return Number(byStartAt.changes) + Number(legacy.changes);
}
