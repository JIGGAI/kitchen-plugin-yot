// Thin wrapper around the You're On Time REST API.
// The real endpoint catalog still needs to be confirmed against the Swagger spec
// (https://api2.youreontime.com/index.html); for now we expose ping + a stubbed
// clients fetch so the rest of the plugin can wire through.

import type { YotConfig } from '../types';

const DEFAULT_BASE_URL = 'https://api2.youreontime.com';
const API_PREFIX = '/1/api';

function resolveBaseUrl(config: YotConfig): string {
  return String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

async function yotFetch(config: YotConfig, path: string, init: RequestInit = {}): Promise<Response> {
  // Endpoints in the OpenAPI spec are rooted at /1/api — always apply that
  // prefix unless the caller already includes it.
  const rel = path.startsWith('/') ? path : '/' + path;
  const prefixed = rel.startsWith(API_PREFIX) ? rel : `${API_PREFIX}${rel}`;
  const url = `${resolveBaseUrl(config)}${prefixed}`;
  // Auth header shape is not declared in the OpenAPI spec (no securityDefinitions).
  // Bitbucket example auth flow: POST /1/api/auth/quicklogin → /1/api/auth/quickloginauth
  // to obtain a token. Using x-api-key as a placeholder until we confirm the
  // header name against a real key; swap here once verified.
  return fetch(url, {
    ...init,
    headers: {
      'accept': 'application/json',
      'x-api-key': config.apiKey,
      ...(init.headers || {}),
    },
  });
}

export async function ping(config: YotConfig): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await yotFetch(config, '/ping');
    return { ok: res.ok, status: res.status };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * Placeholder — real shape TBD. Returns a raw array from YOT.
 * Swap the implementation once the Swagger client list endpoint is verified.
 */
export async function fetchClients(
  config: YotConfig,
  opts: { locationId?: number; page?: number; search?: string } = {},
): Promise<any[]> {
  // OpenAPI: GET /1/api/clients?locationId&page&search
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
