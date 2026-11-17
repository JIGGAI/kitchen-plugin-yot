/**
 * Google Sheets helper backed by a **service account** — replaces the
 * `gog sheets …` CLI calls (which depend on an OAuth token that expires
 * ~weekly) and the hand-rolled refresh-token→access-token dance the export
 * used for tab reordering. The service account never expires and needs no
 * consent screen; each spreadsheet is simply shared with its email as Editor.
 *
 * Credentials: a service-account JSON key at $HMX_SHEETS_SA_KEY, else
 * ~/.openclaw/secrets/hmx-sheets-sa.json.
 */
import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';
import { homedir } from 'node:os';
import path from 'node:path';
import { isNetworkFailure, retryTransient } from '../reports/transient-retry';

const KEY_FILE = process.env.HMX_SHEETS_SA_KEY || path.join(homedir(), '.openclaw', 'secrets', 'hmx-sheets-sa.json');

let cachedClient: sheets_v4.Sheets | null = null;
function client(): sheets_v4.Sheets {
  if (cachedClient) return cachedClient;
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  cachedClient = google.sheets({ version: 'v4', auth });
  return cachedClient;
}

// ───────────────────────── retry ─────────────────────────
//
// On 2026-11-16 the corp disbursement export fetched the YOT report, then
// died on a Sheets read that was aborted mid-request ("The operation was
// aborted.") — no CSV, no email. Every call below therefore goes through
// `call()`: a per-request timeout so a hung connection fails instead of
// stalling the run, and a bounded retry for failures a second identical
// request can plausibly get past (5xx, 429 quota, network). Auth, missing
// tabs and bad ranges (4xx) still fail on the first answer.

/** Per-request timeout. Sheets answers these calls in a second or two. */
const CALL_TIMEOUT_MS = 60_000;
const REQUEST_OPTIONS = { timeout: CALL_TIMEOUT_MS };

type RetryTiming = { windowMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number };
const DEFAULT_RETRY_TIMING: RetryTiming = { windowMs: 6 * 60_000, intervalMs: 20_000 };
let retryTiming: RetryTiming = DEFAULT_RETRY_TIMING;
const retryLog: string[] = [];

/** Failed attempts that were retried, oldest first — for run diagnostics. */
export function sheetsRetryFailures(): string[] {
  return [...retryLog];
}

function httpStatus(error: unknown): number | null {
  const e = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const candidate of [e?.status, e?.response?.status, e?.code]) {
    const n = typeof candidate === 'number' ? candidate : typeof candidate === 'string' && /^\d{3}$/.test(candidate) ? Number(candidate) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function isTransientSheetsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = httpStatus(error);
  if (status !== null) return status >= 500 || status === 429 || status === 408;
  return isNetworkFailure(error);
}

async function call<T>(label: string, fn: (attempt: number) => Promise<T>): Promise<T> {
  const { value } = await retryTransient(fn, {
    ...retryTiming,
    label: `Google Sheets ${label}`,
    isTransient: isTransientSheetsError,
    onRetry: ({ attempt, error }) => {
      const line = `${label} attempt ${attempt}: ${error.message.slice(0, 200)}`;
      retryLog.push(line);
      console.error(`[retry] sheets ${line} — retrying in ${Math.round(retryTiming.intervalMs / 1000)}s`);
    },
  });
  return value;
}

/** Test seam: swap the API client and/or the retry timing. Pass nothing to reset. */
export function __setSheetsTestHooks(hooks: { client?: sheets_v4.Sheets | null; timing?: Partial<RetryTiming> } = {}): void {
  cachedClient = hooks.client ?? null;
  retryTiming = { ...DEFAULT_RETRY_TIMING, ...hooks.timing };
  retryLog.length = 0;
}

export type ValueRender = 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA';
export type ValueInput = 'USER_ENTERED' | 'RAW';

/** Read a range. FORMATTED_VALUE preserves display strings (e.g. leading
 *  zeros on staff IDs) — same default the old `gog sheets get --render
 *  FORMATTED_VALUE` used. Returns rows as strings; short/empty rows come
 *  back as shorter arrays (callers already guard with `row[i] || ''`). */
export async function getValues(spreadsheetId: string, range: string, render: ValueRender = 'FORMATTED_VALUE'): Promise<string[][]> {
  const res = await call(`read ${range}`, () => client().spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: render }, REQUEST_OPTIONS));
  return ((res.data.values as unknown[][]) || []).map((row) => row.map((c) => (c == null ? '' : String(c))));
}

/** Write a range. USER_ENTERED mirrors the old gog default (so "=SUM(...)"
 *  is parsed as a formula and a leading-apostrophe forces text). */
export async function updateValues(spreadsheetId: string, range: string, values: (string | number)[][], input: ValueInput = 'USER_ENTERED'): Promise<void> {
  // Writing the same values to the same range twice is harmless, so a retry
  // after an answer that never arrived is safe.
  await call(`write ${range}`, () => client().spreadsheets.values.update({ spreadsheetId, range, valueInputOption: input, requestBody: { values } }, REQUEST_OPTIONS));
}

export async function clearValues(spreadsheetId: string, range: string): Promise<void> {
  await call(`clear ${range}`, () => client().spreadsheets.values.clear({ spreadsheetId, range }, REQUEST_OPTIONS));
}

/**
 * Replace a tab's whole contents with `values` in ONE request.
 *
 * The ledger tabs used to be rewritten as clear-then-update. A failure
 * between the two left the tab empty, and the rows that had been read from
 * it existed only in a process that was about to exit. Here the new rows are
 * padded with blank cells out to the tab's current size (capped at column Z,
 * what the old `A:Z` clear covered), so a single update both writes the new
 * rows and blanks whatever used to sit below or beside them. It either lands
 * or the tab is untouched. An empty string clears a cell.
 */
export async function replaceValues(spreadsheetId: string, tabTitle: string, values: (string | number)[][], input: ValueInput = 'USER_ENTERED'): Promise<void> {
  const meta = await call(`size of '${tabTitle}'`, () => client().spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(title,gridProperties(rowCount,columnCount))' }, REQUEST_OPTIONS));
  const tab = (meta.data.sheets || []).find((sh) => sh.properties?.title === tabTitle);
  if (!tab) throw new Error(`Tab '${tabTitle}' not found on spreadsheet ${spreadsheetId}`);
  const gridRows = Number(tab.properties?.gridProperties?.rowCount) || 0;
  const gridCols = Number(tab.properties?.gridProperties?.columnCount) || 0;
  const dataCols = values.reduce((max, row) => Math.max(max, row.length), 1);
  const width = Math.max(dataCols, Math.min(gridCols, 26));
  const height = Math.max(values.length, gridRows, 1);
  const grid: (string | number)[][] = [];
  for (let r = 0; r < height; r++) {
    const source = values[r] || [];
    const row: (string | number)[] = [];
    for (let c = 0; c < width; c++) row.push(source[c] ?? '');
    grid.push(row);
  }
  await updateValues(spreadsheetId, `'${tabTitle}'!A1:${columnLetter(width)}${height}`, grid, input);
}

function columnLetter(n: number): string {
  let out = '';
  for (let v = n; v > 0; v = Math.floor((v - 1) / 26)) out = String.fromCharCode(65 + ((v - 1) % 26)) + out;
  return out;
}

export type TabMeta = { title: string; sheetId: number; index: number };

export async function listTabs(spreadsheetId: string): Promise<TabMeta[]> {
  const res = await call('list tabs', () => fetchTabs(spreadsheetId));
  return tabsOf(res);
}

function fetchTabs(spreadsheetId: string) {
  return client().spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(title,sheetId,index)' }, REQUEST_OPTIONS);
}

function tabsOf(res: { data: sheets_v4.Schema$Spreadsheet }): TabMeta[] {
  return (res.data.sheets || []).map((s) => ({
    title: String(s.properties?.title ?? ''),
    sheetId: Number(s.properties?.sheetId),
    index: Number(s.properties?.index),
  }));
}

export async function sheetIdByTitle(spreadsheetId: string, title: string): Promise<number | null> {
  const tab = (await listTabs(spreadsheetId)).find((t) => t.title === title);
  return tab ? tab.sheetId : null;
}

/** Create a tab; returns its new sheetId. */
export async function addTab(spreadsheetId: string, title: string): Promise<number> {
  return call(`add tab '${title}'`, async (attempt) => {
    // A retry follows a request whose answer never arrived — the tab may
    // have been created anyway, and adding it again would be a 400.
    if (attempt > 1) {
      const existing = tabsOf(await fetchTabs(spreadsheetId)).find((t) => t.title === title);
      if (existing) return existing.sheetId;
    }
    const res = await client().spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title } } }] } }, REQUEST_OPTIONS);
    return Number(res.data.replies?.[0]?.addSheet?.properties?.sheetId);
  });
}

export async function deleteTab(spreadsheetId: string, sheetId: number): Promise<void> {
  await call(`delete tab ${sheetId}`, async (attempt) => {
    // Same reasoning as addTab: on a retry the tab may already be gone.
    if (attempt > 1 && !tabsOf(await fetchTabs(spreadsheetId)).some((t) => t.sheetId === sheetId)) return;
    await client().spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ deleteSheet: { sheetId } }] } }, REQUEST_OPTIONS);
  });
}

/** Reorder a tab (replaces the old refresh-token→access-token→batchUpdate hack). */
export async function moveTab(spreadsheetId: string, sheetId: number, newIndex: number): Promise<void> {
  await call(`move tab ${sheetId}`, () => client().spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId, index: newIndex }, fields: 'index' } }] },
  }, REQUEST_OPTIONS));
}
