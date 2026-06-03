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

export type ValueRender = 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA';
export type ValueInput = 'USER_ENTERED' | 'RAW';

/** Read a range. FORMATTED_VALUE preserves display strings (e.g. leading
 *  zeros on staff IDs) — same default the old `gog sheets get --render
 *  FORMATTED_VALUE` used. Returns rows as strings; short/empty rows come
 *  back as shorter arrays (callers already guard with `row[i] || ''`). */
export async function getValues(spreadsheetId: string, range: string, render: ValueRender = 'FORMATTED_VALUE'): Promise<string[][]> {
  const res = await client().spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: render });
  return ((res.data.values as unknown[][]) || []).map((row) => row.map((c) => (c == null ? '' : String(c))));
}

/** Write a range. USER_ENTERED mirrors the old gog default (so "=SUM(...)"
 *  is parsed as a formula and a leading-apostrophe forces text). */
export async function updateValues(spreadsheetId: string, range: string, values: (string | number)[][], input: ValueInput = 'USER_ENTERED'): Promise<void> {
  await client().spreadsheets.values.update({ spreadsheetId, range, valueInputOption: input, requestBody: { values } });
}

export async function clearValues(spreadsheetId: string, range: string): Promise<void> {
  await client().spreadsheets.values.clear({ spreadsheetId, range });
}

export type TabMeta = { title: string; sheetId: number; index: number };

export async function listTabs(spreadsheetId: string): Promise<TabMeta[]> {
  const res = await client().spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(title,sheetId,index)' });
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
  const res = await client().spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title } } }] } });
  return Number(res.data.replies?.[0]?.addSheet?.properties?.sheetId);
}

export async function deleteTab(spreadsheetId: string, sheetId: number): Promise<void> {
  await client().spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ deleteSheet: { sheetId } }] } });
}

/** Reorder a tab (replaces the old refresh-token→access-token→batchUpdate hack). */
export async function moveTab(spreadsheetId: string, sheetId: number, newIndex: number): Promise<void> {
  await client().spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId, index: newIndex }, fields: 'index' } }] },
  });
}
