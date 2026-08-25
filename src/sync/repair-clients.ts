/**
 * Targeted roster repair: fetch clients BY ID instead of walking /clients.
 *
 * Background — why the paginated walk cannot keep the roster current:
 * YOT's `/clients` is a fixed-25-per-page OFFSET scan with no working
 * incremental filter, so a refresh means ~7,400 sequential pages. The scan
 * degrades with depth; past roughly page 2,000 a page can exceed YOT's ~30s
 * server-side query budget and comes back 500. The cursor then parks on that
 * page and the weekly job burns its whole run re-failing it — which is why
 * `sync_state.clients.last_success_at` sat at 2026-05-11 while ~47% of clients
 * with a visit in the trailing year were missing from the roster entirely (and
 * therefore unreachable by SMS marketing, which joins `clients` for the phone).
 *
 * The fix: we already know exactly WHICH clients we care about — the
 * appointments sync records a `client_id` on every appointment. `GET /client/{id}`
 * is a keyed lookup that returns in ~0.3s regardless of how deep the id is, so
 * we can repair (and thereafter maintain) the roster from the appointment
 * stream at a small, bounded cost, and never pay for the full-tenant walk.
 *
 * The run is idempotent and self-resuming: the work set is recomputed from the
 * DB on every invocation, so anything already upserted simply drops out. Killing
 * it mid-run loses nothing.
 */
import { and, eq, sql } from 'drizzle-orm';
import { initializeDatabase } from '../db';
import * as schema from '../db/schema';
import { fetchClient } from '../drivers/yot-client';
import { mapClientRow, readYotConfig, NotConfiguredError } from './sync-clients';

export type RepairClientsOptions = {
  teamId: string;
  /** Only repair clients whose most recent appointment is within N days. 0/undefined = all history. */
  sinceDays?: number | null;
  /** Also refresh clients ALREADY in the roster whose row is older than N days. 0/undefined = off. */
  refreshStaleDays?: number | null;
  /** Parallel in-flight requests. Default 8 (16 starts drawing occasional 500s). */
  concurrency?: number | null;
  /** Stop after this many ids (0/undefined = no limit). */
  limit?: number | null;
  perRequestTimeoutMs?: number | null;
  retries?: number | null;
  onProgress?: (done: number, total: number, written: number) => void;
};

export type RepairClientsResult = {
  ok: true;
  candidates: number;
  attempted: number;
  written: number;
  notFound: number;
  failed: number;
  /** ids YOT itself cannot serialize (HTTP 500 on every attempt) — a permanent upstream data defect, ~1% of the tenant. */
  brokenIds: string[];
  rosterBefore: number;
  rosterAfter: number;
  startedAt: string;
  completedAt: string;
  errorSample: string[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ids worth fetching: every client_id the appointments table references that is
 * absent from `clients` (plus, optionally, roster rows that have gone stale).
 * Ordered most-recent-visit first so a partial run repairs the most marketable
 * clients before the long tail. Recency deliberately ignores FUTURE-dated rows:
 * appointments hold bookings months ahead, and ranking on a raw MAX(start_at)
 * floated a block of legacy standing-appointment clients to the top instead of
 * the people who were actually in the chair recently.
 *
 * `client_id = '0'` is YOT's walk-in sentinel, not a real client — always skipped.
 */
export function selectRepairCandidates(
  sqlite: any,
  opts: { teamId: string; sinceDays?: number | null; refreshStaleDays?: number | null; limit?: number | null },
): string[] {
  const params: Record<string, any> = { teamId: opts.teamId, nowIso: new Date().toISOString() };
  let recencyClause = '';
  if (opts.sinceDays && opts.sinceDays > 0) {
    params.minVisit = new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString();
    recencyClause = 'HAVING lv >= @minVisit';
  }

  let staleClause = 'c.id IS NULL';
  if (opts.refreshStaleDays && opts.refreshStaleDays > 0) {
    params.staleBefore = new Date(Date.now() - opts.refreshStaleDays * 86_400_000).toISOString();
    staleClause = '(c.id IS NULL OR c.synced_at < @staleBefore)';
  }

  const limitClause = opts.limit && opts.limit > 0 ? `LIMIT ${Math.floor(opts.limit)}` : '';

  const rows = sqlite.prepare(`
    SELECT a.client_id AS id,
           MAX(CASE WHEN a.start_at <= @nowIso THEN a.start_at END) AS lv
    FROM appointments a
    LEFT JOIN clients c ON c.id = a.client_id
    WHERE a.team_id = @teamId
      AND a.client_id IS NOT NULL AND a.client_id <> '' AND a.client_id <> '0'
      AND ${staleClause}
    GROUP BY a.client_id
    ${recencyClause}
    ORDER BY lv IS NULL, lv DESC
    ${limitClause}
  `).all(params) as Array<{ id: string }>;

  return rows.map((r) => String(r.id));
}

export async function repairClientsById(opts: RepairClientsOptions): Promise<RepairClientsResult> {
  const { teamId } = opts;
  const config = readYotConfig(teamId);
  if (!config) throw new NotConfiguredError('YOT apiKey not set for this team. POST /config first.');

  const startedAt = new Date().toISOString();
  const { db, sqlite } = initializeDatabase(teamId);

  const countRoster = () =>
    (sqlite.prepare('SELECT COUNT(*) AS n FROM clients WHERE team_id = ?').get(teamId) as any).n as number;

  const rosterBefore = countRoster();
  const ids = selectRepairCandidates(sqlite, opts);

  const CONCURRENCY = Math.max(1, Math.min(Number(opts.concurrency) || 8, 24));
  const TIMEOUT_MS = Math.max(1000, Math.min(Number(opts.perRequestTimeoutMs) || 20000, 60000));
  const RETRIES = Math.max(1, Math.min(Number(opts.retries) || 3, 8));

  let cursor = 0;
  let attempted = 0;
  let written = 0;
  let notFound = 0;
  let failed = 0;
  const brokenIds: string[] = [];
  const errorSample: string[] = [];

  // Buffer fetched records and flush in transactions — one txn per row would
  // multiply fsyncs, and holding one txn for the whole run would block the
  // gateway's readers for the duration.
  let pending: Array<Record<string, any>> = [];
  const FLUSH_EVERY = 200;

  const flush = () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const now = new Date().toISOString();
    sqlite.transaction(() => {
      for (const item of batch) {
        const values = mapClientRow(item, { teamId, now });
        const existing = db.select().from(schema.clients).where(eq(schema.clients.id, values.id)).all();
        if (existing.length) db.update(schema.clients).set({ ...values }).where(eq(schema.clients.id, values.id)).run();
        else db.insert(schema.clients).values(values).run();
        written++;
      }
    })();
  };

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= ids.length) return;
      if (opts.limit && opts.limit > 0 && idx >= opts.limit) return;
      const id = ids[idx];
      let lastErr: string | null = null;
      for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
          const rec = await fetchClient(config!, id, { timeoutMs: TIMEOUT_MS });
          lastErr = null;
          if (rec) pending.push(rec);
          else notFound++;   // 404 = deleted/merged upstream; nothing to write
          break;
        } catch (e: any) {
          const msg: string = e?.message || String(e);
          lastErr = msg;
          // A 500 here is usually YOT failing to serialize that one record
          // (server-side ArgumentNullException on a null field) — deterministic,
          // so cap it at two attempts instead of burning the full retry budget.
          const isServerError = /failed: 5\d\d$/.test(msg);
          const budget = isServerError ? Math.min(2, RETRIES) : RETRIES;
          if (attempt >= budget) break;
          await sleep(500 * attempt);
        }
      }
      attempted++;
      if (lastErr) {
        failed++;
        if (/failed: 5\d\d$/.test(lastErr)) brokenIds.push(id);
        if (errorSample.length < 10) errorSample.push(`${id}: ${lastErr}`);
      }
      if (pending.length >= FLUSH_EVERY) flush();
      if (opts.onProgress && attempted % 500 === 0) opts.onProgress(attempted, ids.length, written);
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    flush();
  } finally {
    flush();
  }

  const completedAt = new Date().toISOString();
  const rosterAfter = countRoster();

  // Recorded under its own resource so it never disturbs the paginated walk's
  // resume_page cursor.
  db.run(sql`INSERT INTO sync_state (team_id, resource, last_synced_at, last_success_at, last_error, row_count)
             VALUES (${teamId}, 'clients_repair', ${completedAt}, ${completedAt},
                     ${failed ? `${failed} id(s) unfetchable upstream (HTTP 500)` : null}, ${rosterAfter})
             ON CONFLICT(team_id, resource) DO UPDATE SET
               last_synced_at = ${completedAt},
               last_success_at = ${completedAt},
               last_error = ${failed ? `${failed} id(s) unfetchable upstream (HTTP 500)` : null},
               row_count = ${rosterAfter}`);

  return { ok: true, candidates: ids.length, attempted, written, notFound, failed, brokenIds, rosterBefore, rosterAfter, startedAt, completedAt, errorSample };
}
