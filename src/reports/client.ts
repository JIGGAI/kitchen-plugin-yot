import type { YotConfig } from '../types';

const REPORTS_BASE_URL = 'https://youreontime-reports.azurewebsites.net';
const REQUEST_DELAY_MS = 500;
const DEFAULT_POLL_DELAY_MS = 1500;
const DEFAULT_MAX_POLLS = 10;

let lastRequestStartedAt = 0;

export type ReportParameterValue = string | number | boolean | null;

export type ReportRequestRecord = {
  endpoint: string;
  method: 'GET' | 'POST';
  status: number;
  ok: boolean;
  durationMs: number;
  sizeBytes: number;
  contentType: string | null;
};

export type ReportParameterDefinition = {
  name: string;
  type: string;
  text: string;
  allowNull: boolean;
  allowBlank: boolean;
  isVisible: boolean;
  value: unknown;
  availableValues: Array<{ value: unknown; id?: unknown; label?: unknown }> | null;
};

export type ReportClientOptions = {
  baseUrl?: string;
  clientId?: string;
  requestDelayMs?: number;
  pollDelayMs?: number;
  maxPolls?: number;
};

export type ReportDocumentFormat = 'PDF' | 'CSV' | 'XLSX' | 'DOCX' | 'PPTX' | 'RTF' | 'IMAGE';

export type ReportDocumentHandle = {
  instanceId: string;
  documentId: string;
  format: ReportDocumentFormat;
};

export type ReportClient = {
  getParameters(report: string, parameterValues: Record<string, ReportParameterValue>): Promise<ReportParameterDefinition[]>;
  createInstance(report: string, parameterValues: Record<string, ReportParameterValue>): Promise<string>;
  createDocument(instanceId: string, format: ReportDocumentFormat): Promise<ReportDocumentHandle>;
  waitForDocument(instanceId: string, documentId: string): Promise<void>;
  fetchDocument(instanceId: string, documentId: string): Promise<{ buffer: Buffer; contentType: string | null }>;
  getClientId(): string | null;
  requestLog: ReportRequestRecord[];
};

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttledFetch(
  url: string,
  init: RequestInit,
  requestDelayMs: number,
): Promise<{ response: Response; buffer: Buffer; durationMs: number }> {
  const now = Date.now();
  const elapsed = now - lastRequestStartedAt;
  if (lastRequestStartedAt > 0 && elapsed < requestDelayMs) await sleep(requestDelayMs - elapsed);
  lastRequestStartedAt = Date.now();

  const startedAt = Date.now();
  const response = await fetch(url, init);
  const durationMs = Date.now() - startedAt;
  const buffer = Buffer.from(await response.arrayBuffer());
  return { response, buffer, durationMs };
}

export function createReportClient(config: YotConfig, options: ReportClientOptions = {}): ReportClient {
  const baseUrl = (options.baseUrl || REPORTS_BASE_URL).replace(/\/+$/, '');
  let clientId = options.clientId ?? null;
  const requestDelayMs = options.requestDelayMs ?? REQUEST_DELAY_MS;
  const pollDelayMs = options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;
  const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;
  const requestLog: ReportRequestRecord[] = [];

  async function ensureClientId(forceRefresh = false): Promise<string> {
    if (clientId && !forceRefresh) return clientId;
    const { response, buffer, durationMs } = await throttledFetch(`${baseUrl}/api/reports/clients`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }, requestDelayMs);
    requestLog.push({
      endpoint: '/clients',
      method: 'POST',
      status: response.status,
      ok: response.ok,
      durationMs,
      sizeBytes: buffer.byteLength,
      contentType: response.headers.get('content-type'),
    });
    const text = buffer.toString('utf8');
    if (!response.ok) throw new Error(`Report client creation failed: ${response.status} ${text.slice(0, 400)}`);
    const data = JSON.parse(text) as { clientId?: string };
    if (!data.clientId) throw new Error('Report client creation returned no clientId');
    clientId = String(data.clientId);
    return clientId;
  }

  async function requestJson<T = unknown>(endpoint: string, method: 'GET' | 'POST', body?: unknown, accept = 'application/json, text/plain, */*'): Promise<T> {
    const resolvedClientId = await ensureClientId();
    const url = `${baseUrl}/api/reports/clients/${resolvedClientId}${endpoint}`;
    const { response, buffer, durationMs } = await throttledFetch(url, {
      method,
      headers: {
        accept,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, requestDelayMs);
    requestLog.push({
      endpoint,
      method,
      status: response.status,
      ok: response.ok,
      durationMs,
      sizeBytes: buffer.byteLength,
      contentType: response.headers.get('content-type'),
    });
    const text = buffer.toString('utf8');
    if (response.status === 410) {
      clientId = null;
    }
    if (!response.ok) throw new Error(`Report request failed (${method} ${endpoint}): ${response.status} ${text.slice(0, 400)}`);
    return JSON.parse(text) as T;
  }

  async function getParameters(report: string, parameterValues: Record<string, ReportParameterValue>): Promise<ReportParameterDefinition[]> {
    return requestJson<ReportParameterDefinition[]>('/parameters', 'POST', { report, parameterValues });
  }

  async function createInstance(report: string, parameterValues: Record<string, ReportParameterValue>): Promise<string> {
    const data = await requestJson<{ instanceId: string }>('/instances', 'POST', { report, parameterValues });
    return String(data.instanceId);
  }

  async function createDocument(instanceId: string, format: ReportDocumentFormat): Promise<ReportDocumentHandle> {
    const data = await requestJson<{ documentId: string }>(`/instances/${instanceId}/documents`, 'POST', { format });
    return { instanceId, documentId: String(data.documentId), format };
  }

  async function waitForDocument(instanceId: string, documentId: string): Promise<void> {
    for (let attempt = 1; attempt <= maxPolls; attempt++) {
      const data = await requestJson<{ documentReady?: boolean }>(`/instances/${instanceId}/documents/${documentId}/info`, 'GET');
      if (data.documentReady === true) return;
      await sleep(pollDelayMs);
    }
    throw new Error(`Document ${documentId} did not become ready after ${maxPolls} polls`);
  }

  async function fetchDocument(instanceId: string, documentId: string): Promise<{ buffer: Buffer; contentType: string | null }> {
    const resolvedClientId = await ensureClientId();
    const endpoint = `/instances/${instanceId}/documents/${documentId}`;
    const url = `${baseUrl}/api/reports/clients/${resolvedClientId}${endpoint}`;
    const { response, buffer, durationMs } = await throttledFetch(url, {
      method: 'GET',
      headers: { accept: '*/*' },
    }, requestDelayMs);
    requestLog.push({
      endpoint,
      method: 'GET',
      status: response.status,
      ok: response.ok,
      durationMs,
      sizeBytes: buffer.byteLength,
      contentType: response.headers.get('content-type'),
    });
    if (response.status === 410) {
      clientId = null;
    }
    if (!response.ok) throw new Error(`Report document fetch failed (${documentId}): ${response.status}`);
    return { buffer, contentType: response.headers.get('content-type') };
  }

  function getClientId(): string | null {
    return clientId;
  }

  return {
    getParameters,
    createInstance,
    createDocument,
    waitForDocument,
    fetchDocument,
    getClientId,
    requestLog,
  };
}
