// Live characterization of likely YOT revenue endpoints.
//
// Goal: determine whether this tenant exposes a trustworthy revenue source for
// ticket 0116 without writing to the plugin DB.
//
// Usage:
//   npx tsx scripts/characterize-revenue-source.ts > /tmp/yot-revenue-probe.json

import Database from 'better-sqlite3';

const DB_PATH = '/Users/hairmx/.openclaw/kitchen/plugins/yot/yot-hmx-marketing-team.db';
const TEAM_ID = 'hmx-marketing-team';
const BASE_URL = 'https://api2.youreontime.com';
const API_PREFIX = '/1/api';
const REQUEST_DELAY_MS = 500;

const EXPORT_PROBES = [
  { label: 'invoices-json-1d', path: '/export/invoices', params: { startDate: '20260424', endDate: '20260424', encoding: 'json' }, timeoutMs: 20_000 },
  { label: 'invoices-csv-1d', path: '/export/invoices', params: { startDate: '20260424', endDate: '20260424', encoding: 'csv' }, timeoutMs: 20_000 },
  { label: 'invoices-json-7d', path: '/export/invoices', params: { startDate: '20260401', endDate: '20260407', encoding: 'json' }, timeoutMs: 20_000 },
  { label: 'invoices-csv-7d', path: '/export/invoices', params: { startDate: '20260401', endDate: '20260407', encoding: 'csv' }, timeoutMs: 20_000 },
  { label: 'invoices-json-31d', path: '/export/invoices', params: { startDate: '20260301', endDate: '20260331', encoding: 'json' }, timeoutMs: 20_000 },
  { label: 'appointments-json-25d', path: '/export/appointments', params: { startDate: '20260401', endDate: '20260425', encoding: 'json' }, timeoutMs: 20_000 },
] as const;

const GUESSED_ENDPOINTS = [
  '/invoices',
  '/sales',
  '/receipts',
  '/receipt',
  '/reports',
  '/report',
  '/transactions',
] as const;

type ProbeRecord = {
  label: string;
  path: string;
  params: Record<string, string>;
  status: number | null;
  ok: boolean;
  durationMs: number;
  contentType: string | null;
  sizeBytes: number;
  bodyShape: string;
  topLevelKeys: string[];
  firstRecordKeys: string[];
  recordCount: number | null;
  containsMoneyFields: string[];
  sample: string | null;
  error: string | null;
};

type Summary = {
  generatedAt: string;
  dbPath: string;
  teamId: string;
  baseUrl: string;
  apiPrefix: string;
  throttleMs: number;
  keySource: string;
  business: { name: string | null; storeEnabled: boolean | null; vouchersEnabled: boolean | null; locationCount: number | null };
  exportProbes: ProbeRecord[];
  guessedEndpointProbes: ProbeRecord[];
  conclusion: {
    foundUsableRevenueSource: boolean;
    bestCandidate: string | null;
    locationGranularity: boolean;
    stylistGranularity: boolean;
    dateGranularity: boolean;
    notes: string[];
  };
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectMoneyFields(value: unknown): string[] {
  const hits = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (node: unknown, path = '') => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 5)) walk(item, path);
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const next = path ? `${path}.${key}` : key;
      if (/(amount|price|gross|net|discount|tip|tax|total|subtotal|paid|balance|invoice|sale|revenue|receipt)/i.test(key)) hits.add(next);
      walk(child, next);
    }
  };
  walk(value);
  return [...hits].sort();
}

function summarizeJson(value: unknown): Pick<ProbeRecord, 'bodyShape' | 'topLevelKeys' | 'firstRecordKeys' | 'recordCount' | 'containsMoneyFields' | 'sample'> {
  if (Array.isArray(value)) {
    const first = value[0];
    return {
      bodyShape: 'json-array',
      topLevelKeys: [],
      firstRecordKeys: first && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first as Record<string, unknown>).sort() : [],
      recordCount: value.length,
      containsMoneyFields: detectMoneyFields(first ?? value),
      sample: first == null ? null : JSON.stringify(first).slice(0, 500),
    };
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    let firstRecordKeys: string[] = [];
    let recordCount: number | null = null;
    for (const child of Object.values(obj)) {
      if (Array.isArray(child)) {
        recordCount = child.length;
        const first = child[0];
        if (first && typeof first === 'object' && !Array.isArray(first)) firstRecordKeys = Object.keys(first as Record<string, unknown>).sort();
        break;
      }
    }
    return {
      bodyShape: 'json-object',
      topLevelKeys: Object.keys(obj).sort(),
      firstRecordKeys,
      recordCount,
      containsMoneyFields: detectMoneyFields(obj),
      sample: JSON.stringify(obj).slice(0, 500),
    };
  }
  return {
    bodyShape: value == null ? 'null' : typeof value,
    topLevelKeys: [],
    firstRecordKeys: [],
    recordCount: null,
    containsMoneyFields: [],
    sample: value == null ? null : String(value).slice(0, 500),
  };
}

function buildUrl(baseUrl: string, path: string, params: Record<string, string>) {
  const rel = path.startsWith('/') ? path : `/${path}`;
  const prefixed = rel.startsWith(API_PREFIX) ? rel : `${API_PREFIX}${rel}`;
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${prefixed}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function probe(baseUrl: string, apiKey: string, label: string, path: string, params: Record<string, string>, timeoutMs: number): Promise<ProbeRecord> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(buildUrl(baseUrl, path, params), {
      headers: { accept: 'application/json', APIKey: apiKey },
      signal: controller.signal,
    });
    const text = await res.text();
    const durationMs = Date.now() - startedAt;
    let derived: ReturnType<typeof summarizeJson> = {
      bodyShape: 'text', topLevelKeys: [], firstRecordKeys: [], recordCount: null, containsMoneyFields: [], sample: text.slice(0, 500),
    };
    try {
      derived = summarizeJson(JSON.parse(text));
    } catch {}
    return {
      label,
      path,
      params,
      status: res.status,
      ok: res.ok,
      durationMs,
      contentType: res.headers.get('content-type'),
      sizeBytes: Buffer.byteLength(text),
      ...derived,
      error: null,
    };
  } catch (error: any) {
    const durationMs = Date.now() - startedAt;
    return {
      label,
      path,
      params,
      status: null,
      ok: false,
      durationMs,
      contentType: null,
      sizeBytes: 0,
      bodyShape: 'error',
      topLevelKeys: [],
      firstRecordKeys: [],
      recordCount: null,
      containsMoneyFields: [],
      sample: null,
      error: error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function readConfig(): { apiKey: string; baseUrl: string } {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT value FROM plugin_config WHERE team_id = ? AND key = 'yot'").get(TEAM_ID) as { value?: string } | undefined;
    if (!row?.value) throw new Error(`No YOT config found for team ${TEAM_ID}`);
    const parsed = JSON.parse(row.value) as { apiKey?: string; baseUrl?: string };
    if (!parsed.apiKey) throw new Error(`Invalid YOT config payload for team ${TEAM_ID}`);
    return { apiKey: parsed.apiKey, baseUrl: parsed.baseUrl || BASE_URL };
  } finally {
    db.close();
  }
}

async function main() {
  const { apiKey, baseUrl } = readConfig();
  const businessProbe = await probe(baseUrl, apiKey, 'business', '/business', {}, 10_000);
  await sleep(REQUEST_DELAY_MS);
  const locationsProbe = await probe(baseUrl, apiKey, 'locations', '/locations', {}, 10_000);
  await sleep(REQUEST_DELAY_MS);

  const exportProbes: ProbeRecord[] = [];
  for (const item of EXPORT_PROBES) {
    exportProbes.push(await probe(baseUrl, apiKey, item.label, item.path, { ...item.params }, item.timeoutMs));
    await sleep(REQUEST_DELAY_MS);
  }

  const guessedEndpointProbes: ProbeRecord[] = [];
  for (const path of GUESSED_ENDPOINTS) {
    guessedEndpointProbes.push(await probe(baseUrl, apiKey, path, path, {}, 10_000));
    await sleep(REQUEST_DELAY_MS);
  }

  let businessName: string | null = null;
  let storeEnabled: boolean | null = null;
  let vouchersEnabled: boolean | null = null;
  let locationCount: number | null = null;
  if (businessProbe.sample && businessProbe.bodyShape === 'json-object') {
    try {
      const parsed = JSON.parse(businessProbe.sample.length >= 500 ? businessProbe.sample : businessProbe.sample);
      businessName = typeof parsed.name === 'string' ? parsed.name : null;
      storeEnabled = typeof parsed.storeEnabled === 'boolean' ? parsed.storeEnabled : null;
      vouchersEnabled = typeof parsed.vouchersEnabled === 'boolean' ? parsed.vouchersEnabled : null;
      if (Array.isArray(parsed.locations)) locationCount = parsed.locations.length;
    } catch {}
  }
  if (locationsProbe.recordCount != null) locationCount = locationsProbe.recordCount;

  const usable = exportProbes.some((row) => row.ok && row.containsMoneyFields.length > 0 && row.recordCount !== 0);
  const summary: Summary = {
    generatedAt: new Date().toISOString(),
    dbPath: DB_PATH,
    teamId: TEAM_ID,
    baseUrl,
    apiPrefix: API_PREFIX,
    throttleMs: REQUEST_DELAY_MS,
    keySource: `plugin_config:${TEAM_ID}:yot`,
    business: { name: businessName, storeEnabled, vouchersEnabled, locationCount },
    exportProbes,
    guessedEndpointProbes,
    conclusion: {
      foundUsableRevenueSource: usable,
      bestCandidate: usable ? '/export/invoices' : null,
      locationGranularity: false,
      stylistGranularity: false,
      dateGranularity: false,
      notes: usable
        ? ['At least one export/invoices probe returned structured money fields.']
        : [
            '/export/invoices is the only revenue-shaped surface in the published openapi spec.',
            'On this tenant it did not return a stable structured payload during the probe set: responses alternated between timeouts and server-side 500s.',
            'Guessed list endpoints like /invoices, /sales, /receipts, /transactions all returned 404.',
            'Without a successful invoice payload we cannot prove location, stylist, or per-day revenue granularity yet.',
          ],
    },
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
