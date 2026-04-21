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
  // Auth header is literally "APIKey" (case-sensitive). The Swagger spec has no
  // securityDefinitions — empirically, x-api-key and Bearer both return
  // HTTP 500 "Invalid API Key".
  return fetch(url, {
    ...init,
    headers: {
      'accept': 'application/json',
      'APIKey': config.apiKey,
      ...(init.headers || {}),
    },
  });
}

/**
 * Validate the stored API key by hitting an authenticated endpoint.
 *
 * /1/api/ping is a public no-auth endpoint that returns 200 regardless, so
 * we probe /1/api/business instead — it requires a valid APIKey and returns
 * the account's basic metadata on success.
 */
export async function ping(config: YotConfig): Promise<{ ok: boolean; status?: number; error?: string; business?: string }> {
  try {
    const res = await yotFetch(config, '/business');
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => null) as { name?: string } | null;
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

export async function fetchLocations(config: YotConfig): Promise<unknown[]> {
  const res = await yotFetch(config, '/locations');
  if (!res.ok) throw new Error(`YOT /locations failed: ${res.status}`);
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch a single page of clients. Returns the raw array from YOT.
 * Field shape per live probe: { id, privateId, givenName, surname, emailAddress,
 * mobilePhone, homePhone, businessPhone, active, country, ... } with nulls common.
 */
export async function fetchClients(
  config: YotConfig,
  opts: { locationId?: number; page?: number; search?: string } = {},
): Promise<any[]> {
  const params = new URLSearchParams();
  if (opts.locationId !== undefined) params.set('locationId', String(opts.locationId));
  if (opts.page !== undefined) params.set('page', String(opts.page));
  if (opts.search) params.set('search', opts.search);
  const qs = params.toString();
  const res = await yotFetch(config, `/clients${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(`YOT /clients failed: ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (Array.isArray(data)) return data;
  if (Array.isArray((data as any).clients)) return (data as any).clients;
  if (Array.isArray((data as any).data)) return (data as any).data;
  return [];
}
