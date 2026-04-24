// Bulk /clients capture script for the hmx-marketing-team YOT tenant.
//
// Purpose:
//   - Full-tenant ingestion of YOT clients into the local plugin DB, paced to
//     ~25,000 clients per hour (~1000 pages/hour given YOT's fixed 25 rows
//     per page).
//   - Crash-safe: writes after every page, tracks last_successful_page in
//     sync_state.last_error (JSON payload), resumes from last page on restart.
//   - Never touches runtime plugin code; runs standalone against the existing
//     kitchen plugin SQLite DB.
//
// Safety:
//   - API key is read from sqlite plugin_config at runtime; never logged.
//   - Paced by PACE_MS per page cycle; respects YOT throttle guidance.
//   - Stops on 429 or N consecutive 5xx / timeouts.
//   - Caps walk at MAX_PAGES to prevent runaway.
//
// Usage:
//   npx tsx scripts/bulk-capture-clients.ts
//   npx tsx scripts/bulk-capture-clients.ts --start-page 1234   # force resume
//   npx tsx scripts/bulk-capture-clients.ts --max-pages 200     # partial run
//   npx tsx scripts/bulk-capture-clients.ts --pace-ms 3600      # default 3600ms
//   npx tsx scripts/bulk-capture-clients.ts --reset             # clear resume state

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const DB_PATH = '/Users/hairmx/.openclaw/kitchen/plugins/yot/yot-hmx-marketing-team.db';
const TEAM_ID = 'hmx-marketing-team';
const BASE_URL = 'https://api2.youreontime.com';
const API_PREFIX = '/1/api';

// Pacing target: ~25,000 clients / hour. At 25 rows/page that's ~1000 pages/hour
// = 3600ms per page cycle. PACE_MS is measured from request-start to the next
// request-start, so slow-response pages naturally absorb some of the budget.
const DEFAULT_PACE_MS = 3600;

// Upper bound on pages walked in one run. Our characterization found >=7000
// real pages for this tenant plus a server-side timeout wall past ~7500. This
// default is a safety cap; set --max-pages to override.
const DEFAULT_MAX_PAGES = 10000;

// Abort conditions.
const STOP_STATUS_CODES = new Set([429]);
const MAX_CONSECUTIVE_5XX = 3;
const MAX_CONSECUTIVE_TIMEOUT = 3;
const REQUEST_TIMEOUT_MS = 30000;

// Sync state bookkeeping. We stash resume metadata as JSON in the existing
// sync_state.last_error column to avoid a schema migration. The column is
// normally a text error message, which is fine for humans but structured JSON
// is safe for us to overwrite on each run.
const RESOURCE = 'clients';

type BulkState = {
  bulk?: {
    lastCompletedPage: number;
    lastRunStartedAt: string;
    lastRunCompletedAt?: string;
    stopReason?: string;
    totalPagesSeen?: number;
    totalRowsUpserted?: number;
  };
};

type Args = {
  startPage?: number;
  maxPages: number;
  paceMs: number;
  reset: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { maxPages: DEFAULT_MAX_PAGES, paceMs: DEFAULT_PACE_MS, reset: false };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === '--start-page' && val) { args.startPage = parseInt(val, 10); i++; continue; }
    if (flag === '--max-pages' && val) { args.maxPages = parseInt(val, 10); i++; continue; }
    if (flag === '--pace-ms' && val) { args.paceMs = parseInt(val, 10); i++; continue; }
    if (flag === '--reset') { args.reset = true; continue; }
  }
  return args;
}

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readApiKey(db: Database.Database): string {
  const row = db.prepare("SELECT value FROM plugin_config WHERE team_id = ? AND key = 'yot'").get(TEAM_ID) as { value?: string } | undefined;
  if (!row?.value) throw new Error(`No YOT config for team ${TEAM_ID}`);
  const parsed = JSON.parse(row.value) as { apiKey?: unknown };
  if (typeof parsed.apiKey !== 'string' || !parsed.apiKey) throw new Error(`Invalid YOT config payload for team ${TEAM_ID}`);
  return parsed.apiKey;
}

function readBulkState(db: Database.Database): BulkState {
  const row = db.prepare('SELECT last_error FROM sync_state WHERE team_id = ? AND resource = ?').get(TEAM_ID, RESOURCE) as { last_error?: string } | undefined;
  if (!row?.last_error) return {};
  try {
    return JSON.parse(row.last_error) as BulkState;
  } catch {
    return {}; // legacy text error, ignore
  }
}

function writeBulkState(db: Database.Database, state: BulkState, rowCount: number | null): void {
  const now = new Date().toISOString();
  const payload = JSON.stringify(state);
  const existing = db.prepare('SELECT 1 FROM sync_state WHERE team_id = ? AND resource = ?').get(TEAM_ID, RESOURCE);
  if (existing) {
    if (rowCount !== null) {
      db.prepare('UPDATE sync_state SET last_synced_at = ?, last_error = ?, row_count = ? WHERE team_id = ? AND resource = ?')
        .run(now, payload, rowCount, TEAM_ID, RESOURCE);
    } else {
      db.prepare('UPDATE sync_state SET last_synced_at = ?, last_error = ? WHERE team_id = ? AND resource = ?')
        .run(now, payload, TEAM_ID, RESOURCE);
    }
  } else {
    db.prepare('INSERT INTO sync_state (team_id, resource, last_synced_at, last_error, row_count) VALUES (?, ?, ?, ?, ?)')
      .run(TEAM_ID, RESOURCE, now, payload, rowCount ?? 0);
  }
}

function markSyncSuccess(db: Database.Database, rowCount: number): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE sync_state SET last_success_at = ?, row_count = ? WHERE team_id = ? AND resource = ?')
    .run(now, rowCount, TEAM_ID, RESOURCE);
}

function startSyncRun(db: Database.Database, notes: string): string {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  db.prepare('INSERT INTO sync_runs (id, team_id, resource, status, started_at, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(runId, TEAM_ID, RESOURCE, 'running', startedAt, notes);
  return runId;
}

function finishSyncRun(db: Database.Database, runId: string, status: 'success' | 'error' | 'aborted', stats: { rowsSeen: number; rowsWritten: number; pageCount: number; notes: string; error?: string }): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE sync_runs SET status = ?, completed_at = ?, rows_seen = ?, rows_written = ?, page_count = ?, notes = ?, error = ? WHERE id = ?')
    .run(status, now, stats.rowsSeen, stats.rowsWritten, stats.pageCount, stats.notes, stats.error ?? null, runId);
}

type ClientRow = Record<string, any>;

async function fetchPage(apiKey: string, page: number, signal: AbortSignal): Promise<{ status: number; rows: ClientRow[]; durationMs: number; sizeBytes: number }> {
  const url = `${BASE_URL}${API_PREFIX}/clients?page=${page}`;
  const startedAt = Date.now();
  const res = await fetch(url, { headers: { accept: 'application/json', APIKey: apiKey }, signal });
  const buf = await res.arrayBuffer();
  const durationMs = Date.now() - startedAt;
  const sizeBytes = buf.byteLength;
  if (res.status !== 200) return { status: res.status, rows: [], durationMs, sizeBytes };
  const text = Buffer.from(buf).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return { status: 200, rows: parsed as ClientRow[], durationMs, sizeBytes };
    if (parsed && typeof parsed === 'object') {
      for (const key of ['clients', 'data', 'rows', 'items', 'results']) {
        const v = (parsed as any)[key];
        if (Array.isArray(v)) return { status: 200, rows: v as ClientRow[], durationMs, sizeBytes };
      }
    }
    return { status: 200, rows: [], durationMs, sizeBytes };
  } catch {
    return { status: 200, rows: [], durationMs, sizeBytes };
  }
}

function cleanString(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function normalizeFullName(item: ClientRow): string | null {
  const direct = cleanString(item.name);
  if (direct) return direct;
  const parts = [cleanString(item.givenName), cleanString(item.otherName), cleanString(item.surname)].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

function upsertPage(db: Database.Database, page: number, rows: ClientRow[], now: string): number {
  const upsertStmt = db.prepare(`
    INSERT INTO clients (
      id, team_id, first_name, last_name, email, phone, address, tags,
      last_visit_at, total_visits, total_spend, raw, synced_at,
      private_id, other_name, full_name, home_phone, mobile_phone, business_phone,
      email_address, birthday, gender, active, street, suburb, state, postcode,
      country, source_location_id, created_at_remote
    ) VALUES (
      @id, @team_id, @first_name, @last_name, @email, @phone, @address, @tags,
      @last_visit_at, @total_visits, @total_spend, @raw, @synced_at,
      @private_id, @other_name, @full_name, @home_phone, @mobile_phone, @business_phone,
      @email_address, @birthday, @gender, @active, @street, @suburb, @state, @postcode,
      @country, @source_location_id, @created_at_remote
    )
    ON CONFLICT(id) DO UPDATE SET
      first_name=excluded.first_name,
      last_name=excluded.last_name,
      email=excluded.email,
      phone=excluded.phone,
      last_visit_at=excluded.last_visit_at,
      total_visits=excluded.total_visits,
      total_spend=excluded.total_spend,
      raw=excluded.raw,
      synced_at=excluded.synced_at,
      private_id=excluded.private_id,
      other_name=excluded.other_name,
      full_name=excluded.full_name,
      home_phone=excluded.home_phone,
      mobile_phone=excluded.mobile_phone,
      business_phone=excluded.business_phone,
      email_address=excluded.email_address,
      birthday=excluded.birthday,
      gender=excluded.gender,
      active=excluded.active,
      street=excluded.street,
      suburb=excluded.suburb,
      state=excluded.state,
      postcode=excluded.postcode,
      country=excluded.country,
      created_at_remote=excluded.created_at_remote
  `);

  const tx = db.transaction((items: ClientRow[]) => {
    let written = 0;
    for (const item of items) {
      const idRaw = item.id ?? item.privateId;
      if (idRaw === undefined || idRaw === null) continue;
      const id = String(idRaw);
      upsertStmt.run({
        id,
        team_id: TEAM_ID,
        first_name: cleanString(item.givenName ?? item.firstName),
        last_name: cleanString(item.surname ?? item.lastName),
        email: cleanString(item.emailAddress ?? item.email),
        phone: cleanString(item.mobilePhone ?? item.homePhone ?? item.businessPhone ?? item.phone),
        address: null,
        tags: null,
        last_visit_at: cleanString(item.lastVisitAt),
        total_visits: typeof item.totalVisits === 'number' ? item.totalVisits : null,
        total_spend: typeof item.totalSpend === 'number' ? item.totalSpend : null,
        raw: JSON.stringify(item),
        synced_at: now,
        private_id: cleanString(item.privateId),
        other_name: cleanString(item.otherName),
        full_name: normalizeFullName(item),
        home_phone: cleanString(item.homePhone),
        mobile_phone: cleanString(item.mobilePhone),
        business_phone: cleanString(item.businessPhone),
        email_address: cleanString(item.emailAddress),
        birthday: cleanString(item.birthday),
        gender: cleanString(item.gender),
        active: typeof item.active === 'boolean' ? (item.active ? 1 : 0) : null,
        street: cleanString(item.street),
        suburb: cleanString(item.suburb),
        state: cleanString(item.state),
        postcode: cleanString(item.postcode),
        country: cleanString(item.country),
        source_location_id: null,
        created_at_remote: cleanString(item.createdDate ?? item.createdAt),
      });
      written++;
    }
    return written;
  });

  return tx(rows);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  const apiKey = readApiKey(db);
  const state = readBulkState(db);

  if (args.reset) {
    log('reset flag set; clearing bulk resume state');
    writeBulkState(db, {}, null);
  }

  const resumeFrom = args.startPage ?? ((state.bulk?.lastCompletedPage ?? 0) + 1);
  const lastAllowed = resumeFrom + args.maxPages - 1;
  const paceMs = args.paceMs;

  const runNotes = `bulk maxPages=${args.maxPages} paceMs=${paceMs} startPage=${resumeFrom}`;
  const runId = startSyncRun(db, runNotes);
  log(`run=${runId} ${runNotes} estimate=${Math.round((args.maxPages * paceMs) / 1000 / 60)}min`);

  let pagesSeen = 0;
  let rowsSeen = 0;
  let rowsWritten = 0;
  let consecutive5xx = 0;
  let consecutiveTimeout = 0;
  let stopReason: string | null = null;

  // Periodic status cadence.
  const statusEvery = 25; // every ~100 pages? We'll log every 25 pages for visibility

  for (let page = resumeFrom; page <= lastAllowed; page++) {
    const cycleStart = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const { status, rows, durationMs, sizeBytes } = await fetchPage(apiKey, page, controller.signal);
      clearTimeout(timeout);

      if (STOP_STATUS_CODES.has(status)) {
        stopReason = `429 at page ${page}`;
        break;
      }

      if (status >= 500) {
        consecutive5xx++;
        log(`page=${page} status=${status} consecutive5xx=${consecutive5xx}`);
        if (consecutive5xx >= MAX_CONSECUTIVE_5XX) {
          stopReason = `${consecutive5xx} consecutive 5xx at page ${page}`;
          break;
        }
      } else if (status !== 200) {
        stopReason = `unexpected status ${status} at page ${page}`;
        break;
      } else {
        consecutive5xx = 0;
        consecutiveTimeout = 0;
        pagesSeen++;

        if (rows.length === 0) {
          stopReason = `empty page at ${page}`;
          break;
        }

        rowsSeen += rows.length;
        const now = new Date().toISOString();
        const written = upsertPage(db, page, rows, now);
        rowsWritten += written;

        state.bulk = {
          ...(state.bulk ?? {
            lastCompletedPage: 0,
            lastRunStartedAt: new Date().toISOString(),
          }),
          lastCompletedPage: page,
          totalPagesSeen: (state.bulk?.totalPagesSeen ?? 0) + 1,
          totalRowsUpserted: (state.bulk?.totalRowsUpserted ?? 0) + written,
        };
        writeBulkState(db, state, rowsSeen);

        if (page % statusEvery === 0 || page === resumeFrom) {
          const elapsedS = (Date.now() - new Date(state.bulk!.lastRunStartedAt).getTime()) / 1000;
          const ratePerHr = Math.round((rowsWritten / Math.max(1, elapsedS)) * 3600);
          log(`page=${page} status=200 rows=${rows.length} written=${written} bytes=${sizeBytes} reqMs=${durationMs} rowsTotal=${rowsSeen} rate~${ratePerHr}/hr`);
        }
      }
    } catch (err: any) {
      clearTimeout(timeout);
      if (err?.name === 'AbortError' || /timeout/i.test(String(err?.message))) {
        consecutiveTimeout++;
        log(`page=${page} TIMEOUT consecutive=${consecutiveTimeout}`);
        if (consecutiveTimeout >= MAX_CONSECUTIVE_TIMEOUT) {
          stopReason = `${consecutiveTimeout} consecutive timeouts at page ${page}`;
          break;
        }
      } else {
        stopReason = `transport error at page ${page}: ${err?.message ?? err}`;
        break;
      }
    }

    // Pace to target cadence (request-start to request-start).
    const elapsed = Date.now() - cycleStart;
    const sleepFor = paceMs - elapsed;
    if (sleepFor > 0) await sleep(sleepFor);
  }

  const finalNotes = `${runNotes} pagesSeen=${pagesSeen} lastPage=${state.bulk?.lastCompletedPage ?? '-'} stop=${stopReason ?? 'maxPages'}`;
  const status = stopReason && stopReason.startsWith('empty page') ? 'success' : (stopReason ? 'aborted' : 'aborted');
  finishSyncRun(db, runId, status, { rowsSeen, rowsWritten, pageCount: pagesSeen, notes: finalNotes });

  if (stopReason && stopReason.startsWith('empty page')) {
    markSyncSuccess(db, rowsSeen);
  }

  state.bulk = {
    ...(state.bulk ?? {
      lastCompletedPage: 0,
      lastRunStartedAt: new Date().toISOString(),
    }),
    lastRunCompletedAt: new Date().toISOString(),
    stopReason: stopReason ?? 'maxPages',
  };
  writeBulkState(db, state, rowsSeen);

  log(`done stop=${stopReason ?? 'maxPages'} pagesSeen=${pagesSeen} rowsSeen=${rowsSeen} rowsWritten=${rowsWritten} lastPage=${state.bulk.lastCompletedPage}`);
  db.close();
}

main().catch((err) => {
  log(`fatal: ${err?.message ?? err}`);
  process.exit(1);
});
