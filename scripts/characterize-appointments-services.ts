// Live characterization of YOT appointments, services, and staff endpoints.
//
// Goal: feed ticket 0114 (schema for appointments/services/stylists tables)
// with real shape / field / paging / rate-limit observations — no ingestion,
// no plugin DB writes, no schema changes.
//
// Safety:
// - Reads the YOT API key once (readonly SQLite handle), then closes. Same
//   pattern as scripts/characterize-clients.ts.
// - Never writes to the plugin DB. The bulk client ingest is expected to be
//   running against the same DB; we only read the api key and release the
//   handle immediately.
// - Throttles 500ms between requests (matches characterize-clients.ts).
// - Caps per-location fan-out, per-endpoint stops on 429 / repeated 5xx.
//
// Usage (from repo root):
//   npx tsx scripts/characterize-appointments-services.ts > /tmp/yot-appts-probe.json
//
// Stdout: one JSON summary (feed into docs/0119-appointments-services-findings.md).
// Stderr: progress log.

import Database from 'better-sqlite3';

const DB_PATH = '/Users/hairmx/.openclaw/kitchen/plugins/yot/yot-hmx-marketing-team.db';
const TEAM_ID = 'hmx-marketing-team';
const BASE_URL = 'https://api2.youreontime.com';
const API_PREFIX = '/1/api';
const REQUEST_DELAY_MS = 500;
const MAX_CONSECUTIVE_5XX = 2;
const STOP_STATUS_CODES = new Set([429]);

// Per-location fan-out cap for the appointmentsrange probe (we only need
// signal, not completeness). Three locations is enough to characterize.
const MAX_LOCATIONS_PROBED = 3;
// Baseline date window for appointmentsrange: a recent 30-day window.
// After probing, YOT's Int64 date/enddate params are unix milliseconds
// (NOT YYYYMMDD as the openapi spec implies). Alternate formats are
// still tested for the doc record.
const DEFAULT_WINDOW_DAYS = 30;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type RequestRecord = {
  endpoint: string;
  params: Record<string, string>;
  status: number;
  ok: boolean;
  durationMs: number;
  sizeBytes: number;
  contentType: string | null;
  bodyShape: string;
  parseError?: string;
};

type ParsedBody =
  | { kind: 'json-array'; data: Record<string, unknown>[] }
  | { kind: 'json-object'; data: Record<string, unknown> }
  | { kind: 'text'; data: string; parseError?: string };

type EndpointStop = { endpoint: string; reason: string };

type AppointmentsRangeProbe = {
  locationId: number | null;
  locationName: string | null;
  dateParam: string;
  enddateParam: string;
  dateFormat: string; // e.g. 'YYYYMMDD', 'YYYY-MM-DD'
  status: number;
  durationMs: number;
  sizeBytes: number;
  bodyShape: string;
  rowCount: number;
  topLevelKeys: string[];
  firstRowKeys: string[];
  allObservedKeys: string[];
  sampleRow: Record<string, unknown> | null;
  pagingAttempted: boolean;
  pagingBehavior: string | null;
  firstRowId: string | null;
  request: RequestRecord;
};

type AppointmentsNonRangeProbe = {
  label: string;
  params: Record<string, string>;
  status: number;
  durationMs: number;
  bodyShape: string;
  rowCount: number;
  topLevelKeys: string[];
  firstRowKeys: string[];
  sampleRow: Record<string, unknown> | null;
  request: RequestRecord;
};

type ServicesProbe = {
  label: string;
  endpoint: string;
  params: Record<string, string>;
  locationId: number | null;
  status: number;
  durationMs: number;
  bodyShape: string;
  rowCount: number;
  topLevelKeys: string[];
  firstRowKeys: string[];
  allObservedKeys: string[];
  sampleRow: Record<string, unknown> | null;
  request: RequestRecord;
};

type StaffProbe = {
  label: string;
  endpoint: string;
  params: Record<string, string>;
  locationId: number | null;
  status: number;
  durationMs: number;
  bodyShape: string;
  rowCount: number;
  topLevelKeys: string[];
  firstRowKeys: string[];
  allObservedKeys: string[];
  sampleRow: Record<string, unknown> | null;
  request: RequestRecord;
};

type AppointmentDetailProbe = {
  appointmentId: string | null;
  status: number | null;
  durationMs: number | null;
  bodyShape: string | null;
  listKeys: string[];
  detailKeys: string[];
  addedKeys: string[];
  request?: RequestRecord;
  note?: string;
};

type PagingVariantProbe = {
  endpoint: string;
  params: Record<string, string>;
  status: number;
  durationMs: number;
  rowCount: number;
  firstRowId: string | null;
  notes: string;
};

type DateFormatProbe = {
  format: string;
  dateParam: string;
  enddateParam: string;
  locationId: number;
  status: number;
  durationMs: number;
  bodyShape: string;
  rowCount: number;
  notes: string;
};

type ProbeSummary = {
  generatedAt: string;
  dbPath: string;
  teamId: string;
  baseUrl: string;
  apiPrefix: string;
  throttleMs: number;
  keySource: string;
  locationsProbed: Array<{ id: number; name: string | null }>;
  allLocationCount: number | null;
  dateFormatProbes: DateFormatProbe[];
  appointmentsRange: AppointmentsRangeProbe[];
  appointmentsNonRange: AppointmentsNonRangeProbe[];
  appointmentsRangePaging: PagingVariantProbe[];
  services: ServicesProbe[];
  staff: StaffProbe[];
  appointmentDetail: AppointmentDetailProbe;
  endpointStops: EndpointStop[];
  fatalError?: string;
};

let lastRequestStartedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readApiKey(): string {
  // Same pattern as scripts/characterize-clients.ts.
  // Readonly handle, one statement, close immediately. The bulk ingest may
  // be writing concurrently; readonly SQLite handles are safe with WAL or
  // rollback-journal modes.
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const row = db
      .prepare("SELECT value FROM plugin_config WHERE team_id = ? AND key = 'yot'")
      .get(TEAM_ID) as { value?: string } | undefined;
    if (!row?.value) {
      throw new Error(`No YOT config found for team ${TEAM_ID}`);
    }
    const parsed = JSON.parse(row.value) as { apiKey?: unknown };
    if (!parsed?.apiKey || typeof parsed.apiKey !== 'string') {
      throw new Error(`Invalid YOT config payload for team ${TEAM_ID}`);
    }
    return parsed.apiKey;
  } finally {
    db.close();
  }
}

async function throttledFetch(
  apiKey: string,
  endpoint: string,
  params: Record<string, string> = {},
): Promise<{ request: RequestRecord; body: ParsedBody }> {
  const now = Date.now();
  const elapsed = now - lastRequestStartedAt;
  if (lastRequestStartedAt > 0 && elapsed < REQUEST_DELAY_MS) {
    await sleep(REQUEST_DELAY_MS - elapsed);
  }
  lastRequestStartedAt = Date.now();

  const query = new URLSearchParams(params);
  const url = `${BASE_URL}${API_PREFIX}${endpoint}${query.toString() ? `?${query.toString()}` : ''}`;
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        APIKey: apiKey,
      },
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const request: RequestRecord = {
      endpoint,
      params,
      status: 0,
      ok: false,
      durationMs,
      sizeBytes: 0,
      contentType: null,
      bodyShape: 'fetch-error',
      parseError: error instanceof Error ? error.message : String(error),
    };
    return { request, body: { kind: 'text', data: '' } };
  }
  const durationMs = Date.now() - startedAt;
  const buffer = await response.arrayBuffer();
  const text = Buffer.from(buffer).toString('utf8');
  const contentType = response.headers.get('content-type');
  const request: RequestRecord = {
    endpoint,
    params,
    status: response.status,
    ok: response.ok,
    durationMs,
    sizeBytes: buffer.byteLength,
    contentType,
    bodyShape: 'empty',
  };

  if (!text.trim()) {
    request.bodyShape = 'empty';
    return { request, body: { kind: 'text', data: '' } };
  }

  try {
    const parsed = JSON.parse(text) as JsonValue;
    if (Array.isArray(parsed)) {
      request.bodyShape = 'json-array';
      return { request, body: { kind: 'json-array', data: parsed as Record<string, unknown>[] } };
    }
    if (parsed && typeof parsed === 'object') {
      request.bodyShape = 'json-object';
      return { request, body: { kind: 'json-object', data: parsed as Record<string, unknown> } };
    }
  } catch (error) {
    request.parseError = error instanceof Error ? error.message : String(error);
  }

  request.bodyShape = 'text';
  return { request, body: { kind: 'text', data: text, parseError: request.parseError } };
}

function extractRecords(body: ParsedBody): Record<string, unknown>[] {
  if (body.kind === 'json-array') return body.data;
  if (body.kind !== 'json-object') return [];

  // The appointmentsrange / appointments endpoints wrap results inside a
  // calendar-view DTO where `data.appointments` is the real list. Try the
  // nested path FIRST before falling back to other containers.
  const dataField = body.data.data;
  if (dataField && typeof dataField === 'object' && !Array.isArray(dataField)) {
    const nestedCandidates = ['appointments', 'items', 'rows', 'results'];
    for (const key of nestedCandidates) {
      const value = (dataField as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as Record<string, unknown>[];
    }
  }

  const candidates = [
    'appointments', 'appointmentsRange', 'services', 'stylists',
    'rows', 'items', 'results', 'records', 'staff',
  ];
  for (const key of candidates) {
    const value = body.data[key];
    if (Array.isArray(value)) return value as Record<string, unknown>[];
  }
  return [];
}

function topLevelKeysOf(body: ParsedBody): string[] {
  if (body.kind === 'json-object') return Object.keys(body.data).sort();
  return [];
}

function unionKeys(rows: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === 'object') {
      for (const key of Object.keys(row)) keys.add(key);
    }
  }
  return [...keys].sort();
}

function firstRowKeys(rows: Record<string, unknown>[]): string[] {
  const first = rows[0];
  if (!first || typeof first !== 'object') return [];
  return Object.keys(first).sort();
}

function firstRowId(rows: Record<string, unknown>[]): string | null {
  const first = rows[0];
  if (!first) return null;
  const id = first.id ?? first.appointmentId ?? first.privateId ?? first.uid;
  return id === undefined || id === null ? null : String(id);
}

function formatYYYYMMDD(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function formatDashed(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function logPhase(phase: string, detail = ''): void {
  const stamp = new Date().toISOString();
  process.stderr.write(`[${stamp}] ${phase}${detail ? ' ' + detail : ''}\n`);
}

function shouldStop(status: number, endpointStops: EndpointStop[], endpoint: string, context: string): boolean {
  if (STOP_STATUS_CODES.has(status)) {
    endpointStops.push({ endpoint, reason: `Received ${status} while probing ${context}` });
    return true;
  }
  return false;
}

async function fetchLocations(apiKey: string): Promise<Record<string, unknown>[]> {
  const { request, body } = await throttledFetch(apiKey, '/locations');
  logPhase('/locations', `status=${request.status} dur=${request.durationMs}ms shape=${request.bodyShape}`);
  const rows = extractRecords(body);
  return rows;
}

// ---------------------------------------------------------------------------
// appointmentsrange — main probe
// ---------------------------------------------------------------------------

async function probeAppointmentsRange(
  apiKey: string,
  locations: Array<{ id: number; name: string | null }>,
  staffIdForActor: number | null,
  endpointStops: EndpointStop[],
): Promise<AppointmentsRangeProbe[]> {
  const results: AppointmentsRangeProbe[] = [];
  const end = new Date(); // now UTC
  const start = new Date(end.getTime() - DEFAULT_WINDOW_DAYS * 86400 * 1000);

  for (const loc of locations) {
    // NOTE: post-discovery, date/enddate are unix milliseconds. We still
    // record the format string for the doc.
    const dateParam = String(start.getTime());
    const enddateParam = String(end.getTime());
    const params: Record<string, string> = {
      locationId: String(loc.id),
      date: dateParam,
      enddate: enddateParam,
    };
    if (staffIdForActor !== null) params.staffId = String(staffIdForActor);
    const { request, body } = await throttledFetch(apiKey, '/appointmentsrange', params);
    const rows = extractRecords(body);
    const result: AppointmentsRangeProbe = {
      locationId: loc.id,
      locationName: loc.name,
      dateParam,
      enddateParam,
      dateFormat: 'unix-ms',
      status: request.status,
      durationMs: request.durationMs,
      sizeBytes: request.sizeBytes,
      bodyShape: request.bodyShape,
      rowCount: rows.length,
      topLevelKeys: topLevelKeysOf(body),
      firstRowKeys: firstRowKeys(rows),
      allObservedKeys: unionKeys(rows),
      sampleRow: rows[0] ?? null,
      pagingAttempted: false,
      pagingBehavior: null,
      firstRowId: firstRowId(rows),
      request,
    };
    results.push(result);
    logPhase('/appointmentsrange', `loc=${loc.id} status=${request.status} rows=${rows.length} dur=${request.durationMs}ms`);
    if (shouldStop(request.status, endpointStops, '/appointmentsrange', `locationId=${loc.id}`)) break;
  }

  return results;
}

async function probeAppointmentsRangePaging(
  apiKey: string,
  loc: { id: number; name: string | null } | null,
  staffIdForActor: number | null,
  endpointStops: EndpointStop[],
): Promise<PagingVariantProbe[]> {
  const probes: PagingVariantProbe[] = [];
  if (!loc) return probes;

  const end = new Date();
  const start = new Date(end.getTime() - DEFAULT_WINDOW_DAYS * 86400 * 1000);
  const dateParam = String(start.getTime());
  const enddateParam = String(end.getTime());

  const baseline: Record<string, string> = { locationId: String(loc.id), date: dateParam, enddate: enddateParam };
  if (staffIdForActor !== null) baseline.staffId = String(staffIdForActor);

  // Probe: does page=1 return the same as no-page?
  for (const variant of [
    { label: 'no-page', params: { ...baseline } },
    { label: 'page=1', params: { ...baseline, page: '1' } },
    { label: 'page=2', params: { ...baseline, page: '2' } },
    { label: 'page=3', params: { ...baseline, page: '3' } },
    { label: 'limit=500', params: { ...baseline, limit: '500' } },
    { label: 'pageSize=500', params: { ...baseline, pageSize: '500' } },
  ]) {
    const { request, body } = await throttledFetch(apiKey, '/appointmentsrange', variant.params);
    const rows = extractRecords(body);
    const rowId = firstRowId(rows);
    const probe: PagingVariantProbe = {
      endpoint: '/appointmentsrange',
      params: variant.params,
      status: request.status,
      durationMs: request.durationMs,
      rowCount: rows.length,
      firstRowId: rowId,
      notes: `variant=${variant.label}`,
    };
    probes.push(probe);
    logPhase('/appointmentsrange paging', `variant=${variant.label} status=${request.status} rows=${rows.length}`);
    if (shouldStop(request.status, endpointStops, '/appointmentsrange', `paging ${variant.label}`)) break;
  }

  return probes;
}

async function probeDateFormats(
  apiKey: string,
  loc: { id: number; name: string | null } | null,
  staffIdForActor: number | null,
  endpointStops: EndpointStop[],
): Promise<DateFormatProbe[]> {
  const probes: DateFormatProbe[] = [];
  if (!loc) return probes;

  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86400 * 1000);

  const formats: Array<{ label: string; start: string; end: string }> = [
    { label: 'YYYYMMDD', start: formatYYYYMMDD(start), end: formatYYYYMMDD(end) },
    { label: 'YYYY-MM-DD', start: formatDashed(start), end: formatDashed(end) },
    { label: 'unix-seconds', start: String(Math.floor(start.getTime() / 1000)), end: String(Math.floor(end.getTime() / 1000)) },
    { label: 'unix-ms', start: String(start.getTime()), end: String(end.getTime()) },
  ];

  for (const fmt of formats) {
    const params: Record<string, string> = {
      locationId: String(loc.id),
      date: fmt.start,
      enddate: fmt.end,
    };
    if (staffIdForActor !== null) params.staffId = String(staffIdForActor);
    const { request, body } = await throttledFetch(apiKey, '/appointmentsrange', params);
    const rows = extractRecords(body);
    const probe: DateFormatProbe = {
      format: fmt.label,
      dateParam: fmt.start,
      enddateParam: fmt.end,
      locationId: loc.id,
      status: request.status,
      durationMs: request.durationMs,
      bodyShape: request.bodyShape,
      rowCount: rows.length,
      notes: request.parseError ?? '',
    };
    probes.push(probe);
    logPhase('/appointmentsrange date-format', `fmt=${fmt.label} status=${request.status} rows=${rows.length}`);
    if (shouldStop(request.status, endpointStops, '/appointmentsrange', `date-format ${fmt.label}`)) break;
  }

  return probes;
}

// ---------------------------------------------------------------------------
// appointments — non-range
// ---------------------------------------------------------------------------

async function probeAppointmentsNonRange(
  apiKey: string,
  loc: { id: number; name: string | null } | null,
  staffIdForActor: number | null,
  endpointStops: EndpointStop[],
): Promise<AppointmentsNonRangeProbe[]> {
  const today = new Date();
  const todayMs = String(today.getTime());
  const probes: Array<{ label: string; params: Record<string, string> }> = [
    { label: 'no-params', params: {} },
    { label: 'date-today-ms', params: { date: todayMs } },
  ];
  if (loc) {
    probes.push({ label: 'loc+date-today-ms', params: { locationId: String(loc.id), date: todayMs } });
    probes.push({ label: 'loc-only', params: { locationId: String(loc.id) } });
    if (staffIdForActor !== null) {
      probes.push({
        label: 'loc+staff+date-today-ms',
        params: { locationId: String(loc.id), staffId: String(staffIdForActor), date: todayMs },
      });
    }
  }

  const results: AppointmentsNonRangeProbe[] = [];
  for (const p of probes) {
    const { request, body } = await throttledFetch(apiKey, '/appointments', p.params);
    const rows = extractRecords(body);
    results.push({
      label: p.label,
      params: p.params,
      status: request.status,
      durationMs: request.durationMs,
      bodyShape: request.bodyShape,
      rowCount: rows.length,
      topLevelKeys: topLevelKeysOf(body),
      firstRowKeys: firstRowKeys(rows),
      sampleRow: rows[0] ?? null,
      request,
    });
    logPhase('/appointments', `variant=${p.label} status=${request.status} rows=${rows.length}`);
    if (shouldStop(request.status, endpointStops, '/appointments', p.label)) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// services — per-location and fallback
// ---------------------------------------------------------------------------

async function probeServices(
  apiKey: string,
  locations: Array<{ id: number; name: string | null }>,
  endpointStops: EndpointStop[],
): Promise<ServicesProbe[]> {
  const results: ServicesProbe[] = [];

  // Fallback: try /services with no location (spec does not list it, but
  // worth confirming it's actually 404 vs. a lucky find).
  {
    const { request, body } = await throttledFetch(apiKey, '/services');
    const rows = extractRecords(body);
    results.push({
      label: 'global /services',
      endpoint: '/services',
      params: {},
      locationId: null,
      status: request.status,
      durationMs: request.durationMs,
      bodyShape: request.bodyShape,
      rowCount: rows.length,
      topLevelKeys: topLevelKeysOf(body),
      firstRowKeys: firstRowKeys(rows),
      allObservedKeys: unionKeys(rows),
      sampleRow: rows[0] ?? null,
      request,
    });
    logPhase('/services (global)', `status=${request.status} rows=${rows.length}`);
    if (shouldStop(request.status, endpointStops, '/services', 'global')) return results;
  }

  for (const loc of locations) {
    const endpoint = `/${loc.id}/services`;
    const { request, body } = await throttledFetch(apiKey, endpoint);
    const rows = extractRecords(body);
    results.push({
      label: `per-location /${loc.id}/services`,
      endpoint,
      params: {},
      locationId: loc.id,
      status: request.status,
      durationMs: request.durationMs,
      bodyShape: request.bodyShape,
      rowCount: rows.length,
      topLevelKeys: topLevelKeysOf(body),
      firstRowKeys: firstRowKeys(rows),
      allObservedKeys: unionKeys(rows),
      sampleRow: rows[0] ?? null,
      request,
    });
    logPhase('/services (per-loc)', `loc=${loc.id} status=${request.status} rows=${rows.length}`);
    if (shouldStop(request.status, endpointStops, endpoint, `location ${loc.id}`)) break;
  }

  return results;
}

// ---------------------------------------------------------------------------
// staff — per-location, plus /staff and /stylists fallbacks
// ---------------------------------------------------------------------------

async function probeStaff(
  apiKey: string,
  locations: Array<{ id: number; name: string | null }>,
  endpointStops: EndpointStop[],
): Promise<StaffProbe[]> {
  const results: StaffProbe[] = [];

  for (const endpoint of ['/staff', '/stylists']) {
    // Also test with services=true since /{loc}/staff requires it.
    const { request, body } = await throttledFetch(apiKey, endpoint, { services: 'true' });
    const rows = extractRecords(body);
    results.push({
      label: `global ${endpoint}`,
      endpoint,
      params: {},
      locationId: null,
      status: request.status,
      durationMs: request.durationMs,
      bodyShape: request.bodyShape,
      rowCount: rows.length,
      topLevelKeys: topLevelKeysOf(body),
      firstRowKeys: firstRowKeys(rows),
      allObservedKeys: unionKeys(rows),
      sampleRow: rows[0] ?? null,
      request,
    });
    logPhase(endpoint, `(global) status=${request.status} rows=${rows.length}`);
    if (shouldStop(request.status, endpointStops, endpoint, 'global')) return results;
  }

  for (const loc of locations) {
    const endpoint = `/${loc.id}/staff`;
    const params = { services: 'true' };
    const { request, body } = await throttledFetch(apiKey, endpoint, params);
    const rows = extractRecords(body);
    results.push({
      label: `per-location /${loc.id}/staff?services=true`,
      endpoint,
      params,
      locationId: loc.id,
      status: request.status,
      durationMs: request.durationMs,
      bodyShape: request.bodyShape,
      rowCount: rows.length,
      topLevelKeys: topLevelKeysOf(body),
      firstRowKeys: firstRowKeys(rows),
      allObservedKeys: unionKeys(rows),
      sampleRow: rows[0] ?? null,
      request,
    });
    logPhase('/staff (per-loc)', `loc=${loc.id} status=${request.status} rows=${rows.length}`);
    if (shouldStop(request.status, endpointStops, endpoint, `location ${loc.id}`)) break;
  }

  return results;
}

// ---------------------------------------------------------------------------
// appointments/{id} — detail probe
// ---------------------------------------------------------------------------

async function probeAppointmentDetail(
  apiKey: string,
  rangeProbes: AppointmentsRangeProbe[],
  endpointStops: EndpointStop[],
): Promise<AppointmentDetailProbe> {
  // Find the first available appointment id out of any range probe.
  let apptId: string | null = null;
  let listKeys: string[] = [];
  for (const p of rangeProbes) {
    if (p.firstRowId) {
      apptId = p.firstRowId;
      listKeys = p.allObservedKeys;
      break;
    }
  }
  if (!apptId) {
    return {
      appointmentId: null,
      status: null,
      durationMs: null,
      bodyShape: null,
      listKeys,
      detailKeys: [],
      addedKeys: [],
      note: 'No appointment id was observed in any range probe; detail endpoint not tested.',
    };
  }

  const { request, body } = await throttledFetch(apiKey, `/appointments/${encodeURIComponent(apptId)}`);
  let detail: Record<string, unknown> | null = null;
  if (body.kind === 'json-object') detail = body.data;
  if (body.kind === 'json-array') detail = body.data[0] || null;
  const detailKeys = detail ? Object.keys(detail).sort() : [];
  const addedKeys = detailKeys.filter((k) => !listKeys.includes(k));
  if (shouldStop(request.status, endpointStops, `/appointments/{id}`, `id=${apptId}`)) {
    // fall through
  }
  logPhase('/appointments/{id}', `id=${apptId} status=${request.status}`);
  return {
    appointmentId: apptId,
    status: request.status,
    durationMs: request.durationMs,
    bodyShape: request.bodyShape,
    listKeys,
    detailKeys,
    addedKeys,
    request,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logPhase('startup', 'reading api key');
  const apiKey = readApiKey();

  const endpointStops: EndpointStop[] = [];

  logPhase('locations', 'fetching');
  const locationsRaw = await fetchLocations(apiKey);
  const allLocations: Array<{ id: number; name: string | null }> = [];
  for (const row of locationsRaw) {
    const idVal = row.id ?? row.locationId;
    if (idVal === undefined || idVal === null) continue;
    const nameVal = (row.name ?? row.locationName ?? null) as string | null;
    const n = Number(idVal);
    if (Number.isFinite(n)) {
      allLocations.push({ id: n, name: nameVal });
    }
  }
  logPhase('locations', `count=${allLocations.length}`);

  // Pick up to MAX_LOCATIONS_PROBED active-ish locations. Since we don't have
  // an activity filter, just use the first N stable ids.
  const locationsProbed = allLocations.slice(0, MAX_LOCATIONS_PROBED);
  logPhase('locations-probed', JSON.stringify(locationsProbed));

  // Discover a real staff id at the first probed location so we can
  // satisfy the REQUIRED (despite openapi 'false') staffId param on
  // /appointmentsrange and /appointments.
  let staffIdForActor: number | null = null;
  if (locationsProbed[0]) {
    const { body: staffBody } = await throttledFetch(
      apiKey,
      `/${locationsProbed[0].id}/staff`,
      { services: 'true' },
    );
    const staffRows = extractRecords(staffBody);
    for (const row of staffRows) {
      const idVal = row.id;
      if (typeof idVal === 'number' && Number.isFinite(idVal)) {
        staffIdForActor = idVal;
        break;
      }
      if (typeof idVal === 'string' && Number.isFinite(Number(idVal))) {
        staffIdForActor = Number(idVal);
        break;
      }
    }
  }
  logPhase('staffIdForActor', `picked=${staffIdForActor ?? 'null'}`);

  // ---- date-format probe (one location) ----
  logPhase('dateFormats', 'start');
  const dateFormatProbes = await probeDateFormats(apiKey, locationsProbed[0] ?? null, staffIdForActor, endpointStops);
  logPhase('dateFormats', `done count=${dateFormatProbes.length}`);

  // ---- appointmentsrange main probe ----
  logPhase('appointmentsRange', 'start');
  const appointmentsRange = await probeAppointmentsRange(apiKey, locationsProbed, staffIdForActor, endpointStops);
  logPhase('appointmentsRange', `done count=${appointmentsRange.length}`);

  // ---- appointmentsrange paging probe ----
  logPhase('appointmentsRangePaging', 'start');
  const appointmentsRangePaging = await probeAppointmentsRangePaging(apiKey, locationsProbed[0] ?? null, staffIdForActor, endpointStops);
  logPhase('appointmentsRangePaging', `done count=${appointmentsRangePaging.length}`);

  // ---- /appointments non-range ----
  logPhase('appointmentsNonRange', 'start');
  const appointmentsNonRange = await probeAppointmentsNonRange(apiKey, locationsProbed[0] ?? null, staffIdForActor, endpointStops);
  logPhase('appointmentsNonRange', `done count=${appointmentsNonRange.length}`);

  // ---- /services ----
  logPhase('services', 'start');
  const services = await probeServices(apiKey, locationsProbed, endpointStops);
  logPhase('services', `done count=${services.length}`);

  // ---- /staff ----
  logPhase('staff', 'start');
  const staff = await probeStaff(apiKey, locationsProbed, endpointStops);
  logPhase('staff', `done count=${staff.length}`);

  // ---- /appointments/{id} ----
  logPhase('appointmentDetail', 'start');
  const appointmentDetail = await probeAppointmentDetail(apiKey, appointmentsRange, endpointStops);
  logPhase('appointmentDetail', `done status=${appointmentDetail.status ?? 'null'}`);

  const summary: ProbeSummary = {
    generatedAt: new Date().toISOString(),
    dbPath: DB_PATH,
    teamId: TEAM_ID,
    baseUrl: BASE_URL,
    apiPrefix: API_PREFIX,
    throttleMs: REQUEST_DELAY_MS,
    keySource: 'sqlite plugin_config (readonly, opened once, closed immediately)',
    locationsProbed,
    allLocationCount: allLocations.length,
    dateFormatProbes,
    appointmentsRange,
    appointmentsNonRange,
    appointmentsRangePaging,
    services,
    staff,
    appointmentDetail,
    endpointStops,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  const err = error instanceof Error ? error : new Error(String(error));
  const fatalError = err.cause instanceof Error ? `${err.message} (cause: ${err.cause.message})` : err.message;
  const summary: ProbeSummary = {
    generatedAt: new Date().toISOString(),
    dbPath: DB_PATH,
    teamId: TEAM_ID,
    baseUrl: BASE_URL,
    apiPrefix: API_PREFIX,
    throttleMs: REQUEST_DELAY_MS,
    keySource: 'sqlite plugin_config (readonly, opened once, closed immediately)',
    locationsProbed: [],
    allLocationCount: null,
    dateFormatProbes: [],
    appointmentsRange: [],
    appointmentsNonRange: [],
    appointmentsRangePaging: [],
    services: [],
    staff: [],
    appointmentDetail: {
      appointmentId: null,
      status: null,
      durationMs: null,
      bodyShape: null,
      listKeys: [],
      detailKeys: [],
      addedKeys: [],
      note: 'Probe aborted before reaching appointment detail probe.',
    },
    endpointStops: [{ endpoint: 'startup', reason: fatalError }],
    fatalError,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = 1;
});
