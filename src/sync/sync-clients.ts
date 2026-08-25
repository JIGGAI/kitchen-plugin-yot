/**
 * Resumable, streaming YOT clients sync — extracted from the API handler so it
 * can run BOTH in-process (the `/clients/sync` route) and, more importantly, as
 * a short-lived OUT-OF-PROCESS script (scripts/sync-clients.ts).
 *
 * Why out-of-process matters: this is the heaviest writer in the plugin (a full
 * ~7,400-page upsert walk). Running it through the long-lived kitchen gateway —
 * which accumulates many SQLite connections and gets restarted by launchd
 * KeepAlive — risks a torn WAL checkpoint mid-write, which is what corrupted the
 * 1.6 GB DB on 2026-06-18. A dedicated process holds ONE connection, checkpoints
 * and closes cleanly on exit, and a crash there never destabilizes the gateway.
 *
 * Semantics are unchanged from the original handler block: per-page upsert,
 * persisted resume cursor in sync_state.resume_page, per-page retry, and a
 * cleared cursor on a completed full pass.
 */
import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { initializeDatabase } from '../db';
import * as schema from '../db/schema';
import { fetchClients } from '../drivers/yot-client';
import type { YotConfig } from '../types';

function cleanString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeFullName(item: Record<string, any> | null | undefined): string | null {
  if (!item) return null;
  const direct = cleanString(item.name);
  if (direct) return direct;
  const composed = [cleanString(item.givenName ?? item.firstName), cleanString(item.otherName), cleanString(item.surname ?? item.lastName)]
    .filter(Boolean)
    .join(' ')
    .trim();
  return composed || null;
}

export function readYotConfig(teamId: string): YotConfig | null {
  const { db } = initializeDatabase(teamId);
  const rows = db
    .select()
    .from(schema.pluginConfig)
    .where(and(eq(schema.pluginConfig.teamId, teamId), eq(schema.pluginConfig.key, 'yot')))
    .all();
  if (!rows.length) return null;
  try {
    const parsed = JSON.parse(rows[0].value);
    if (!parsed?.apiKey) return null;
    return { apiKey: String(parsed.apiKey), baseUrl: parsed.baseUrl ? String(parsed.baseUrl) : undefined };
  } catch {
    return null;
  }
}

/**
 * Map one raw YOT client object to a `clients` row. Shared by the paginated
 * walk and the by-id roster repair so both write identical shapes.
 */
export function mapClientRow(
  item: Record<string, any>,
  ctx: { teamId: string; now: string; locationIdRaw?: string | null },
): schema.NewClient {
  return {
    id: String(item.id ?? item.privateId),
    teamId: ctx.teamId,
    firstName: cleanString(item.givenName ?? item.firstName),
    lastName: cleanString(item.surname ?? item.lastName),
    email: cleanString(item.emailAddress ?? item.email),
    phone: cleanString(item.mobilePhone ?? item.homePhone ?? item.businessPhone ?? item.phone),
    address: null,
    tags: null,
    lastVisitAt: cleanString(item.lastVisitAt),
    totalVisits: typeof item.totalVisits === 'number' ? item.totalVisits : null,
    totalSpend: typeof item.totalSpend === 'number' ? item.totalSpend : null,
    raw: JSON.stringify(item),
    syncedAt: ctx.now,
    privateId: cleanString(item.privateId),
    otherName: cleanString(item.otherName),
    fullName: normalizeFullName(item),
    homePhone: cleanString(item.homePhone),
    mobilePhone: cleanString(item.mobilePhone),
    businessPhone: cleanString(item.businessPhone),
    emailAddress: cleanString(item.emailAddress),
    birthday: cleanString(item.birthday),
    gender: cleanString(item.gender),
    active: typeof item.active === 'boolean' ? item.active : null,
    street: cleanString(item.street),
    suburb: cleanString(item.suburb),
    state: cleanString(item.state),
    postcode: cleanString(item.postcode),
    country: cleanString(item.country),
    sourceLocationId: ctx.locationIdRaw ?? null,
    createdAtRemote: cleanString(item.createdDate ?? item.createdAt),
  };
}

export type ClientsSyncOptions = {
  teamId: string;
  /** Explicit start page; otherwise resume from sync_state.resume_page, else page 1. */
  startPage?: number | null;
  /** Pages to walk this call (a chunk). Default 500, capped at 20000. */
  maxPages?: number | null;
  locationId?: number | null;
  pageTimeoutMs?: number | null;
  pageRetries?: number | null;
  retryBackoffMs?: number | null;
  /**
   * Pages that still fail after their retries are SKIPPED (cursor advances)
   * rather than parking the walk, up to this many per chunk. Default 25.
   * Set 0 to restore the old stop-on-first-bad-page behavior.
   */
  maxSkippedPages?: number | null;
};

export type ClientsSyncResult = {
  ok: true;
  synced: number;
  fromPage: number;
  lastPage: number;
  nextPage: number | null;
  complete: boolean;
  stoppedBecause: string;
  totalClients: number;
  /** Pages abandoned after retries and stepped over; each costs up to 25 clients until the next full pass. */
  skippedPages: number[];
  startedAt: string;
  completedAt: string;
  error: string | null;
};

export class NotConfiguredError extends Error {
  constructor(message: string) { super(message); this.name = 'NotConfiguredError'; }
}

/**
 * Run one resumable chunk of the clients sync. Throws NotConfiguredError if the
 * team has no YOT apiKey, and rethrows unexpected (non-fetch) errors after
 * recording them; transient per-page fetch failures are caught internally and
 * surface as `stoppedBecause: 'error'` with the cursor preserved.
 */
export async function runClientsSync(opts: ClientsSyncOptions): Promise<ClientsSyncResult> {
  const { teamId } = opts;
  const config = readYotConfig(teamId);
  if (!config) throw new NotConfiguredError('YOT apiKey not set for this team. POST /config first.');

  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const PAGE_TIMEOUT_MS = Math.min(Number(opts.pageTimeoutMs) || 25000, 60000);
  const MAX_PAGES = Math.min(Number(opts.maxPages) || 500, 20000);
  const locationId = opts.locationId != null ? Number(opts.locationId) : undefined;
  const locationIdRaw = locationId != null && Number.isFinite(locationId) ? String(locationId) : null;

  const { db, sqlite } = initializeDatabase(teamId);

  try {
    // Resume cursor: explicit startPage wins; else persisted resume_page; else 1.
    const stateRow = db.select().from(schema.syncState)
      .where(and(eq(schema.syncState.teamId, teamId), eq(schema.syncState.resource, 'clients'))).all()[0] as any;
    const explicitStart = Number(opts.startPage);
    const startPage = Number.isFinite(explicitStart) && explicitStart > 0
      ? explicitStart
      : (stateRow?.resumePage && stateRow.resumePage > 0 ? stateRow.resumePage : 1);

    db.insert(schema.syncRuns).values({ id: runId, teamId, resource: 'clients', status: 'running', startedAt, notes: `startPage=${startPage}` }).run();
    // Ensure a sync_state row exists so the cursor UPDATEs below have a target.
    db.run(sql`INSERT INTO sync_state (team_id, resource, last_synced_at) VALUES (${teamId}, 'clients', ${startedAt})
               ON CONFLICT(team_id, resource) DO UPDATE SET last_synced_at = ${startedAt}`);

    const toRow = (item: Record<string, any>, now: string): schema.NewClient =>
      mapClientRow(item, { teamId, now, locationIdRaw });

    // Upsert one page inside a transaction (fast); returns rows written.
    const upsertPage = (rows: Record<string, any>[], now: string): number => sqlite.transaction(() => {
      let n = 0;
      for (const item of rows) {
        if (!item?.id && !item?.privateId) continue;
        const values = toRow(item, now);
        const existing = db.select().from(schema.clients).where(eq(schema.clients.id, values.id)).all();
        if (existing.length) db.update(schema.clients).set({ ...values }).where(eq(schema.clients.id, values.id)).run();
        else db.insert(schema.clients).values(values).run();
        n++;
      }
      return n;
    })();

    const endPage = startPage + MAX_PAGES - 1;
    let upserts = 0;
    let lastPage = startPage - 1;       // last page successfully ingested
    let stoppedBecause = 'maxPages';
    let errMsg: string | null = null;

    // Per-page retry so a transient YOT blip doesn't end the whole chunk.
    const PAGE_RETRIES = Math.max(1, Math.min(Number(opts.pageRetries) || 3, 10));
    // Why skip rather than stop: YOT's OFFSET scan blows its ~30s server-side
    // query budget on some deep pages and 500s DETERMINISTICALLY. Stopping left
    // the cursor pinned to that page, and the weekly job spent every run
    // re-failing it — the walk made zero progress from 2026-06-18 to 2026-08-25.
    // Stepping over the page loses at most 25 clients (recoverable by the by-id
    // repair, see repair-clients.ts) instead of losing the entire walk.
    const MAX_SKIPPED = Math.max(0, Math.min(opts.maxSkippedPages == null ? 25 : Number(opts.maxSkippedPages) || 0, 500));
    const skippedPages: number[] = [];
    const RETRY_BACKOFF_MS = Math.max(0, Math.min(opts.retryBackoffMs == null ? 750 : (Number(opts.retryBackoffMs) || 0), 10000));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    for (let page = startPage; page <= endPage; page++) {
      let chunk: Record<string, any>[] | null = null;
      let pageErr: string | null = null;
      for (let attempt = 1; attempt <= PAGE_RETRIES; attempt++) {
        try {
          chunk = await fetchClients(config, { page, locationId, timeoutMs: PAGE_TIMEOUT_MS });
          pageErr = null;
          break;
        } catch (e: any) {
          pageErr = e?.message || String(e);
          if (attempt < PAGE_RETRIES && RETRY_BACKOFF_MS) await sleep(RETRY_BACKOFF_MS * attempt);
        }
      }
      if (pageErr !== null) {
        errMsg = pageErr;
        if (skippedPages.length < MAX_SKIPPED) {
          skippedPages.push(page);
          lastPage = page;
          db.run(sql`UPDATE sync_state SET resume_page = ${page + 1} WHERE team_id = ${teamId} AND resource = 'clients'`);
          continue; // step over the bad page; the walk keeps moving
        }
        stoppedBecause = 'error';
        break; // too many bad pages in a row-ish — stop and preserve the cursor
      }
      if (!chunk!.length) { stoppedBecause = 'empty-page'; break; } // full pass complete
      const now = new Date().toISOString();
      upserts += upsertPage(chunk!, now);
      lastPage = page;
      // Persist the cursor every page so a killed process resumes cleanly.
      db.run(sql`UPDATE sync_state SET resume_page = ${page + 1}, last_synced_at = ${now} WHERE team_id = ${teamId} AND resource = 'clients'`);
    }

    const completedAt = new Date().toISOString();
    const complete = stoppedBecause === 'empty-page';
    const nextPage = complete ? null : lastPage + 1;
    const totalClients = (db.select().from(schema.clients).where(eq(schema.clients.teamId, teamId)).all() as any[]).length;

    // On a completed full pass, clear the cursor so the NEXT run starts fresh.
    db.run(sql`UPDATE sync_state SET resume_page = ${nextPage}, row_count = ${totalClients},
               last_success_at = ${complete ? completedAt : (stateRow?.lastSuccessAt ?? null)},
               last_error = ${errMsg} WHERE team_id = ${teamId} AND resource = 'clients'`);
    db.update(schema.syncRuns).set({
      status: stoppedBecause === 'error' ? 'error' : 'success', completedAt,
      rowsWritten: upserts, pageCount: Math.max(0, lastPage - startPage + 1),
      notes: `startPage=${startPage}; lastPage=${lastPage}; stop=${stoppedBecause}; nextPage=${nextPage ?? 'done'}; skipped=${skippedPages.length}`,
      error: errMsg,
    }).where(eq(schema.syncRuns.id, runId)).run();

    return { ok: true, synced: upserts, fromPage: startPage, lastPage, nextPage, complete, stoppedBecause, totalClients, skippedPages, startedAt, completedAt, error: errMsg };
  } catch (error: any) {
    const errMsg = error?.message || String(error);
    const now = new Date().toISOString();
    try {
      db.update(schema.syncRuns).set({ status: 'error', completedAt: now, error: errMsg }).where(eq(schema.syncRuns.id, runId)).run();
      db.run(sql`UPDATE sync_state SET last_synced_at = ${now}, last_error = ${errMsg} WHERE team_id = ${teamId} AND resource = 'clients'`);
    } catch {}
    throw error;
  }
}
