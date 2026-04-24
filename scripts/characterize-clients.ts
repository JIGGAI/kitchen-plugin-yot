import Database from 'better-sqlite3';

const DB_PATH = '/Users/hairmx/.openclaw/kitchen/plugins/yot/yot-hmx-marketing-team.db';
const TEAM_ID = 'hmx-marketing-team';
const BASE_URL = 'https://api2.youreontime.com';
const API_PREFIX = '/1/api';
const REQUEST_DELAY_MS = 500;
const MAX_CONSECUTIVE_5XX = 2;
const MAX_BASELINE_PAGES = 80;
const STOP_STATUS_CODES = new Set([429]);
const INTERESTING_DETAIL_FIELDS = [
  'lastVisitAt',
  'lastVisitDate',
  'totalVisits',
  'totalSpend',
  'tags',
  'tagNames',
  'notes',
  'dob',
  'birthday',
  'loyaltyPoints',
  'memberSince',
  'preferredStaffId',
  'preferredLocationId',
  'marketingOptIn',
  'emailOptIn',
  'smsOptIn',
];

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

type PageProbeRecord = {
  page: number;
  count: number;
  status: number;
  durationMs: number;
  honoredLimitParam?: string | null;
  active?: 'true' | 'false' | 'none';
  stopReason?: string;
};

type VariantProbeRecord = {
  name: string;
  value: string;
  page: number;
  count: number;
  status: number;
  durationMs: number;
  inferredHonored: boolean | null;
  notes: string;
};

type ActiveProbeRecord = {
  active: 'true' | 'false' | 'none';
  page: number;
  count: number;
  status: number;
  durationMs: number;
  firstIds: string[];
  notes?: string;
};

type ExportProbeRecord = {
  label: string;
  status: number;
  durationMs: number;
  sizeBytes: number;
  contentType: string | null;
  shape: string;
  firstRecordKeys: string[];
  recordCount: number | null;
  topLevelKeys: string[];
  parseError?: string;
  request: RequestRecord;
};

type DetailProbeRecord = {
  clientId: string | null;
  status: number | null;
  durationMs: number | null;
  contentType: string | null;
  shape: string | null;
  listKeys: string[];
  detailKeys: string[];
  addedKeys: string[];
  interestingFieldsPresent: string[];
  request?: RequestRecord;
  note?: string;
};

type ProbeSummary = {
  generatedAt: string;
  dbPath: string;
  teamId: string;
  baseUrl: string;
  apiPrefix: string;
  throttleMs: number;
  keySource: string;
  clientsPaging: {
    baselinePageCount: number;
    firstEmptyPage: number | null;
    totalRowsAcrossNonEmptyPages: number;
    uniqueClientIds: number;
    duplicateIds: number;
    stoppedEarly: boolean;
    stopReason: string | null;
    pages: PageProbeRecord[];
  };
  limitVariants: VariantProbeRecord[];
  activeVariants: ActiveProbeRecord[];
  exportClients: ExportProbeRecord[];
  clientDetail: DetailProbeRecord;
  endpointStops: Array<{ endpoint: string; reason: string }>;
  fatalError?: string;
};

type ParsedBody =
  | { kind: 'json-array'; data: Record<string, unknown>[] }
  | { kind: 'json-object'; data: Record<string, unknown> }
  | { kind: 'text'; data: string; parseError?: string };

let lastRequestStartedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readApiKey(): string {
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

async function throttledFetch(apiKey: string, endpoint: string, params: Record<string, string> = {}): Promise<{ request: RequestRecord; body: ParsedBody }> {
  const now = Date.now();
  const elapsed = now - lastRequestStartedAt;
  if (lastRequestStartedAt > 0 && elapsed < REQUEST_DELAY_MS) {
    await sleep(REQUEST_DELAY_MS - elapsed);
  }
  lastRequestStartedAt = Date.now();

  const query = new URLSearchParams(params);
  const url = `${BASE_URL}${API_PREFIX}${endpoint}${query.toString() ? `?${query.toString()}` : ''}`;
  const startedAt = Date.now();
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      APIKey: apiKey,
    },
  });
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

  const candidates = ['clients', 'data', 'rows', 'items', 'results'];
  for (const key of candidates) {
    const value = body.data[key];
    if (Array.isArray(value)) return value as Record<string, unknown>[];
  }
  return [];
}

function extractFirstIds(rows: Record<string, unknown>[], limit = 3): string[] {
  return rows
    .slice(0, limit)
    .map((row) => row.id ?? row.privateId)
    .filter((value): value is string | number => value !== undefined && value !== null)
    .map(String);
}

function unionKeys(rows: Record<string, unknown>[], limit = 5): string[] {
  const keys = new Set<string>();
  for (const row of rows.slice(0, limit)) {
    for (const key of Object.keys(row)) keys.add(key);
  }
  return [...keys].sort();
}

function inferLimitHonored(baselineCount: number, testValue: number, observedCount: number, status: number): { inferredHonored: boolean | null; notes: string } {
  if (status !== 200) return { inferredHonored: null, notes: 'Request did not succeed.' };
  if (observedCount === 0) return { inferredHonored: null, notes: 'No rows returned; cannot infer param handling.' };
  if (testValue < baselineCount && observedCount === testValue) {
    return { inferredHonored: true, notes: 'Observed row count matches requested lower limit.' };
  }
  if (testValue < baselineCount && observedCount === baselineCount) {
    return { inferredHonored: false, notes: 'Observed row count matches baseline, so lower limit appears ignored.' };
  }
  if (testValue >= baselineCount && observedCount > baselineCount) {
    return { inferredHonored: true, notes: 'Observed row count exceeds baseline, implying a larger page size was honored.' };
  }
  if (testValue >= baselineCount && observedCount === baselineCount) {
    return { inferredHonored: false, notes: 'Observed row count stayed at baseline despite a higher requested limit.' };
  }
  if (observedCount < baselineCount && observedCount < testValue) {
    return { inferredHonored: null, notes: 'Observed row count shrank, but not to the requested limit.' };
  }
  return { inferredHonored: null, notes: 'Param handling was ambiguous from the observed count.' };
}

function csvHeaderColumns(text: string): string[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  if (!firstLine.trim()) return [];
  return firstLine.split(',').map((value) => value.trim()).filter(Boolean);
}

async function probeClientsPaging(apiKey: string, endpointStops: Array<{ endpoint: string; reason: string }>): Promise<{
  baselineRows: Record<string, unknown>[];
  pages: PageProbeRecord[];
  firstEmptyPage: number | null;
  uniqueClientIds: number;
  duplicateIds: number;
  totalRowsAcrossNonEmptyPages: number;
  stoppedEarly: boolean;
  stopReason: string | null;
}> {
  const pages: PageProbeRecord[] = [];
  const seenIds = new Set<string>();
  let duplicateIds = 0;
  let firstEmptyPage: number | null = null;
  let consecutive5xx = 0;
  let baselineRows: Record<string, unknown>[] = [];
  let stopReason: string | null = null;

  for (let page = 1; ; page += 1) {
    if (page > MAX_BASELINE_PAGES) {
      stopReason = `Reached MAX_BASELINE_PAGES=${MAX_BASELINE_PAGES} without an empty page`;
      endpointStops.push({ endpoint: '/clients', reason: stopReason });
      break;
    }
    const { request, body } = await throttledFetch(apiKey, '/clients', { page: String(page) });
    const rows = extractRecords(body);
    if (page === 1) baselineRows = rows;

    const record: PageProbeRecord = {
      page,
      count: rows.length,
      status: request.status,
      durationMs: request.durationMs,
    };
    pages.push(record);
    process.stderr.write(`[${new Date().toISOString()}] /clients page=${page} status=${request.status} rows=${rows.length} dur=${request.durationMs}ms\n`);

    if (STOP_STATUS_CODES.has(request.status)) {
      stopReason = `Received ${request.status} on page ${page}`;
      record.stopReason = stopReason;
      endpointStops.push({ endpoint: '/clients', reason: stopReason });
      break;
    }

    if (request.status >= 500) {
      consecutive5xx += 1;
      if (consecutive5xx >= MAX_CONSECUTIVE_5XX) {
        stopReason = `Received ${consecutive5xx} consecutive 5xx responses ending at page ${page}`;
        record.stopReason = stopReason;
        endpointStops.push({ endpoint: '/clients', reason: stopReason });
        break;
      }
      continue;
    }

    consecutive5xx = 0;
    if (request.status !== 200) {
      stopReason = `Received unexpected status ${request.status} on page ${page}`;
      record.stopReason = stopReason;
      endpointStops.push({ endpoint: '/clients', reason: stopReason });
      break;
    }

    if (rows.length === 0) {
      firstEmptyPage = page;
      break;
    }

    for (const row of rows) {
      const id = row.id ?? row.privateId;
      if (id === undefined || id === null) continue;
      const key = String(id);
      if (seenIds.has(key)) duplicateIds += 1;
      seenIds.add(key);
    }
  }

  return {
    baselineRows,
    pages,
    firstEmptyPage,
    uniqueClientIds: seenIds.size,
    duplicateIds,
    totalRowsAcrossNonEmptyPages: pages.filter((page) => page.status === 200 && page.count > 0).reduce((sum, page) => sum + page.count, 0),
    stoppedEarly: stopReason !== null,
    stopReason,
  };
}

async function probeLimitVariants(
  apiKey: string,
  baselineCount: number,
  endpointStops: Array<{ endpoint: string; reason: string }>,
): Promise<VariantProbeRecord[]> {
  const variants: VariantProbeRecord[] = [];

  for (const name of ['limit', 'pageSize']) {
    for (const value of [100, 500, 1000]) {
      const { request, body } = await throttledFetch(apiKey, '/clients', { page: '1', [name]: String(value) });
      const rows = extractRecords(body);
      const inference = inferLimitHonored(baselineCount, value, rows.length, request.status);
      variants.push({
        name,
        value: String(value),
        page: 1,
        count: rows.length,
        status: request.status,
        durationMs: request.durationMs,
        inferredHonored: inference.inferredHonored,
        notes: inference.notes,
      });

      if (STOP_STATUS_CODES.has(request.status)) {
        const reason = `Received ${request.status} while probing /clients ${name}=${value}`;
        endpointStops.push({ endpoint: '/clients', reason });
        return variants;
      }
    }
  }

  return variants;
}

async function probeActiveVariants(
  apiKey: string,
  endpointStops: Array<{ endpoint: string; reason: string }>,
): Promise<ActiveProbeRecord[]> {
  const variants: ActiveProbeRecord[] = [];
  const cases: Array<{ active: 'true' | 'false' | 'none'; params: Record<string, string> }> = [
    { active: 'none', params: { page: '1' } },
    { active: 'true', params: { page: '1', active: 'true' } },
    { active: 'false', params: { page: '1', active: 'false' } },
  ];

  for (const testCase of cases) {
    const { request, body } = await throttledFetch(apiKey, '/clients', testCase.params);
    const rows = extractRecords(body);
    variants.push({
      active: testCase.active,
      page: 1,
      count: rows.length,
      status: request.status,
      durationMs: request.durationMs,
      firstIds: extractFirstIds(rows),
    });

    if (STOP_STATUS_CODES.has(request.status)) {
      const reason = `Received ${request.status} while probing /clients active=${testCase.active}`;
      endpointStops.push({ endpoint: '/clients', reason });
      break;
    }
  }

  return variants;
}

async function probeExportClients(apiKey: string, endpointStops: Array<{ endpoint: string; reason: string }>): Promise<ExportProbeRecord[]> {
  const probes: Array<{ label: string; params: Record<string, string> }> = [
    { label: 'no-date-filter', params: {} },
    { label: '2026-01-01_to_2026-04-23', params: { startDate: '2026-01-01', endDate: '2026-04-23' } },
  ];
  const results: ExportProbeRecord[] = [];
  let consecutive5xx = 0;

  for (const probe of probes) {
    const { request, body } = await throttledFetch(apiKey, '/export/clients', probe.params);
    let shape = request.bodyShape;
    let firstRecordKeys: string[] = [];
    let recordCount: number | null = null;
    let topLevelKeys: string[] = [];
    let parseError: string | undefined;

    if (body.kind === 'json-array') {
      recordCount = body.data.length;
      firstRecordKeys = Object.keys(body.data[0] || {}).sort();
      shape = 'json-array';
    } else if (body.kind === 'json-object') {
      topLevelKeys = Object.keys(body.data).sort();
      const rows = extractRecords(body);
      if (rows.length > 0) {
        recordCount = rows.length;
        firstRecordKeys = Object.keys(rows[0] || {}).sort();
      } else {
        const nestedArray = Object.values(body.data).find((value) => Array.isArray(value));
        if (Array.isArray(nestedArray)) {
          recordCount = nestedArray.length;
          firstRecordKeys = Object.keys((nestedArray[0] as Record<string, unknown>) || {}).sort();
        }
      }
      shape = 'json-object';
    } else {
      parseError = body.parseError;
      const header = csvHeaderColumns(body.data);
      if (header.length > 0) {
        firstRecordKeys = header;
        shape = 'csv-or-text';
      }
    }

    results.push({
      label: probe.label,
      status: request.status,
      durationMs: request.durationMs,
      sizeBytes: request.sizeBytes,
      contentType: request.contentType,
      shape,
      firstRecordKeys,
      recordCount,
      topLevelKeys,
      parseError,
      request,
    });

    if (STOP_STATUS_CODES.has(request.status)) {
      const reason = `Received ${request.status} while probing /export/clients (${probe.label})`;
      endpointStops.push({ endpoint: '/export/clients', reason });
      break;
    }

    if (request.status >= 500) {
      consecutive5xx += 1;
      if (consecutive5xx >= MAX_CONSECUTIVE_5XX) {
        const reason = `Received ${consecutive5xx} consecutive 5xx responses on /export/clients`;
        endpointStops.push({ endpoint: '/export/clients', reason });
        break;
      }
      continue;
    }

    consecutive5xx = 0;
  }

  return results;
}

async function probeClientDetail(
  apiKey: string,
  baselineRows: Record<string, unknown>[],
  endpointStops: Array<{ endpoint: string; reason: string }>,
): Promise<DetailProbeRecord> {
  const firstClient = baselineRows[0];
  const clientIdValue = firstClient?.id ?? firstClient?.privateId;
  if (clientIdValue === undefined || clientIdValue === null) {
    return {
      clientId: null,
      status: null,
      durationMs: null,
      contentType: null,
      shape: null,
      listKeys: unionKeys(baselineRows),
      detailKeys: [],
      addedKeys: [],
      interestingFieldsPresent: [],
      note: 'Could not identify a client id from page 1.',
    };
  }

  const clientId = String(clientIdValue);
  const { request, body } = await throttledFetch(apiKey, `/clients/${encodeURIComponent(clientId)}`);
  let detail: Record<string, unknown> | null = null;
  if (body.kind === 'json-object') detail = body.data;
  if (body.kind === 'json-array') detail = body.data[0] || null;

  const listKeys = unionKeys(baselineRows);
  const detailKeys = detail ? Object.keys(detail).sort() : [];
  const addedKeys = detailKeys.filter((key) => !listKeys.includes(key));
  const interestingFieldsPresent = detailKeys.filter((key) => INTERESTING_DETAIL_FIELDS.includes(key));

  if (STOP_STATUS_CODES.has(request.status)) {
    endpointStops.push({ endpoint: '/clients/{id}', reason: `Received ${request.status} while probing /clients/${clientId}` });
  }

  return {
    clientId,
    status: request.status,
    durationMs: request.durationMs,
    contentType: request.contentType,
    shape: request.bodyShape,
    listKeys,
    detailKeys,
    addedKeys,
    interestingFieldsPresent,
    request,
  };
}

function logPhase(phase: string, detail = ''): void {
  const stamp = new Date().toISOString();
  process.stderr.write(`[${stamp}] ${phase}${detail ? ' ' + detail : ''}\n`);
}

async function main(): Promise<void> {
  logPhase('startup', 'reading api key');
  const apiKey = readApiKey();
  const endpointStops: Array<{ endpoint: string; reason: string }> = [];

  logPhase('probeClientsPaging', 'start');
  const paging = await probeClientsPaging(apiKey, endpointStops);
  logPhase('probeClientsPaging', `done pages=${paging.pages.length} first=${paging.baselineRows.length} total=${paging.totalRowsAcrossNonEmptyPages} stop=${paging.stopReason ?? 'empty-page'}`);

  logPhase('probeLimitVariants', 'start');
  const limitVariants = await probeLimitVariants(apiKey, paging.baselineRows.length, endpointStops);
  logPhase('probeLimitVariants', `done count=${limitVariants.length}`);

  logPhase('probeActiveVariants', 'start');
  const activeVariants = await probeActiveVariants(apiKey, endpointStops);
  logPhase('probeActiveVariants', `done count=${activeVariants.length}`);

  logPhase('probeExportClients', 'start');
  const exportClients = await probeExportClients(apiKey, endpointStops);
  logPhase('probeExportClients', `done count=${exportClients.length}`);

  logPhase('probeClientDetail', 'start');
  const clientDetail = await probeClientDetail(apiKey, paging.baselineRows, endpointStops);
  logPhase('probeClientDetail', `done status=${clientDetail.status ?? 'null'}`);

  const summary: ProbeSummary = {
    generatedAt: new Date().toISOString(),
    dbPath: DB_PATH,
    teamId: TEAM_ID,
    baseUrl: BASE_URL,
    apiPrefix: API_PREFIX,
    throttleMs: REQUEST_DELAY_MS,
    keySource: 'sqlite plugin_config',
    clientsPaging: {
      baselinePageCount: paging.baselineRows.length,
      firstEmptyPage: paging.firstEmptyPage,
      totalRowsAcrossNonEmptyPages: paging.totalRowsAcrossNonEmptyPages,
      uniqueClientIds: paging.uniqueClientIds,
      duplicateIds: paging.duplicateIds,
      stoppedEarly: paging.stoppedEarly,
      stopReason: paging.stopReason,
      pages: paging.pages,
    },
    limitVariants,
    activeVariants,
    exportClients,
    clientDetail,
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
    keySource: 'sqlite plugin_config',
    clientsPaging: {
      baselinePageCount: 0,
      firstEmptyPage: null,
      totalRowsAcrossNonEmptyPages: 0,
      uniqueClientIds: 0,
      duplicateIds: 0,
      stoppedEarly: true,
      stopReason: fatalError,
      pages: [],
    },
    limitVariants: [],
    activeVariants: [],
    exportClients: [],
    clientDetail: {
      clientId: null,
      status: null,
      durationMs: null,
      contentType: null,
      shape: null,
      listKeys: [],
      detailKeys: [],
      addedKeys: [],
      interestingFieldsPresent: [],
      note: 'Probe aborted before a successful /clients page 1 response.',
    },
    endpointStops: [{ endpoint: 'startup', reason: fatalError }],
    fatalError,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = 1;
});
