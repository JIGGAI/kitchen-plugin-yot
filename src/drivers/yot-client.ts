// Thin wrapper around the You're On Time REST API.
// Auth + endpoints confirmed 2026-04-21 against a real Hair Mechanix key.

import type { YotConfig } from '../types';

const DEFAULT_BASE_URL = 'https://api2.youreontime.com';
const API_PREFIX = '/1/api';

function resolveBaseUrl(config: YotConfig): string {
  return String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

async function yotFetch(config: YotConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const rel = path.startsWith('/') ? path : '/' + path;
  const prefixed = rel.startsWith(API_PREFIX) ? rel : `${API_PREFIX}${rel}`;
  const url = `${resolveBaseUrl(config)}${prefixed}`;
  return fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      APIKey: config.apiKey,
      ...(init.headers || {}),
    },
  });
}

export async function ping(config: YotConfig): Promise<{ ok: boolean; status?: number; error?: string; business?: string }> {
  try {
    const res = await yotFetch(config, '/business');
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => null)) as { name?: string } | null;
    return { ok: true, status: res.status, business: data?.name };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

export async function fetchBusiness(config: YotConfig): Promise<unknown> {
  const res = await yotFetch(config, '/business');
  if (!res.ok) throw new Error(`YOT /business failed: ${res.status}`);
  return res.json();
}

export async function fetchLocations(config: YotConfig): Promise<Record<string, any>[]> {
  const res = await yotFetch(config, '/locations');
  if (!res.ok) throw new Error(`YOT /locations failed: ${res.status}`);
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? (data as Record<string, any>[]) : [];
}

export async function fetchClients(
  config: YotConfig,
  opts: { locationId?: number; page?: number; search?: string } = {},
): Promise<Record<string, any>[]> {
  const params = new URLSearchParams();
  if (opts.locationId !== undefined) params.set('locationId', String(opts.locationId));
  if (opts.page !== undefined) params.set('page', String(opts.page));
  if (opts.search) params.set('search', opts.search);
  const qs = params.toString();
  const res = await yotFetch(config, `/clients${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(`YOT /clients failed: ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (Array.isArray(data)) return data as Record<string, any>[];
  if (Array.isArray((data as any).clients)) return (data as any).clients as Record<string, any>[];
  if (Array.isArray((data as any).data)) return (data as any).data as Record<string, any>[];
  return [];
}

export async function fetchLocationServices(config: YotConfig, locationId: number): Promise<Record<string, any>[]> {
  const res = await yotFetch(config, `/${locationId}/services`);
  if (!res.ok) throw new Error(`YOT /${locationId}/services failed: ${res.status}`);
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? (data as Record<string, any>[]) : [];
}

export async function fetchLocationStaff(config: YotConfig, locationId: number, opts: { services?: boolean } = {}): Promise<Record<string, any>[]> {
  const params = new URLSearchParams();
  params.set('services', String(opts.services ?? true));
  const res = await yotFetch(config, `/${locationId}/staff?${params.toString()}`);
  if (!res.ok) throw new Error(`YOT /${locationId}/staff failed: ${res.status}`);
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? (data as Record<string, any>[]) : [];
}

export async function characterizeClientPaging(
  config: YotConfig,
  opts: { locationId?: number; maxPages?: number } = {},
): Promise<{
  pagesChecked: number;
  nonEmptyPages: number;
  firstEmptyPage: number | null;
  rowCounts: number[];
  uniqueClientIds: number;
  duplicateIds: number;
  totalRowsSeen: number;
}> {
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 25, 200));
  const rowCounts: number[] = [];
  const ids = new Set<string>();
  let duplicateIds = 0;
  let nonEmptyPages = 0;
  let firstEmptyPage: number | null = null;

  for (let page = 1; page <= maxPages; page++) {
    const rows = await fetchClients(config, { page, locationId: opts.locationId });
    rowCounts.push(rows.length);
    if (rows.length === 0) {
      firstEmptyPage = page;
      break;
    }
    nonEmptyPages++;
    for (const row of rows) {
      const id = row?.id ?? row?.privateId;
      if (id == null) continue;
      const key = String(id);
      if (ids.has(key)) duplicateIds++;
      ids.add(key);
    }
  }

  return {
    pagesChecked: rowCounts.length,
    nonEmptyPages,
    firstEmptyPage,
    rowCounts,
    uniqueClientIds: ids.size,
    duplicateIds,
    totalRowsSeen: rowCounts.reduce((sum, n) => sum + n, 0),
  };
}
