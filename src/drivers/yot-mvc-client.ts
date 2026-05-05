// Thin wrapper around the YOT MVC web app at app.youreontime.com.
//
// Unlike the REST API at api2.youreontime.com, this surface uses forms-auth
// session cookies — there's no APIKey header. The cookie is captured from a
// logged-in browser session and stored as `mvcCookie` in YotConfig. When YOT
// expires the session, the driver throws a `MvcAuthExpiredError` and the
// operator refreshes the cookie via config.

import type { YotConfig } from '../types';

const DEFAULT_BASE_URL = 'https://app.youreontime.com';

export class MvcAuthMissingError extends Error {
  constructor() {
    super('YotConfig.mvcCookie is empty. Capture a Cookie header from a logged-in YOT session and store it in config.');
    this.name = 'MvcAuthMissingError';
  }
}

export class MvcAuthExpiredError extends Error {
  status: number;
  constructor(status: number) {
    super(`YOT MVC session rejected the cookie (HTTP ${status}). Refresh mvcCookie from a fresh logged-in browser session.`);
    this.name = 'MvcAuthExpiredError';
    this.status = status;
  }
}

function resolveBaseUrl(config: YotConfig): string {
  return String(config.mvcBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function requireCookie(config: YotConfig): string {
  if (!config.mvcCookie || !config.mvcCookie.trim()) throw new MvcAuthMissingError();
  return config.mvcCookie;
}

/**
 * Format a Date or ISO YYYY-MM-DD string as MM/DD/YYYY (the format YOT's
 * MVC layer expects in form bodies).
 */
export function formatMvcDate(input: string | Date): string {
  const date = typeof input === 'string' ? new Date(`${input}T00:00:00`) : input;
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

async function mvcFetch(config: YotConfig, path: string, init: RequestInit & { formBody?: Record<string, string> } = {}): Promise<Response> {
  const cookie = requireCookie(config);
  const url = `${resolveBaseUrl(config)}${path.startsWith('/') ? path : '/' + path}`;
  const headers: Record<string, string> = {
    accept: '*/*',
    'cache-control': 'no-cache',
    cookie,
    'x-requested-with': 'XMLHttpRequest',
    ...((init.headers as Record<string, string>) || {}),
  };
  let body: string | undefined;
  if (init.formBody) {
    headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    body = new URLSearchParams(init.formBody).toString();
  } else if (init.body !== undefined) {
    body = String(init.body);
  }
  const res = await fetch(url, { ...init, headers, body });
  // YOT redirects to /Account/Login when the session expires; the AJAX endpoint
  // returns a 200 with login HTML. We treat both as auth-expired.
  if (res.status === 302 || res.status === 401) throw new MvcAuthExpiredError(res.status);
  if (res.status === 200) {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/html') && (res.url.includes('/Account/Login') || res.headers.get('x-redirect-url')?.includes('/Account/Login'))) {
      throw new MvcAuthExpiredError(res.status);
    }
  }
  return res;
}

/**
 * Fetch the rostered-staff week view for one location starting on the given
 * date. Returns the raw HTML fragment (a `<table class="grid">` chunk), which
 * the caller passes to `parseRosterHtml`.
 *
 * @param weekStartDate ISO YYYY-MM-DD; YOT returns Sun..Sat from that date.
 */
export async function fetchLocationRosterHtml(
  config: YotConfig,
  locationId: number | string,
  weekStartDate: string,
): Promise<string> {
  const baseUrl = resolveBaseUrl(config);
  const res = await mvcFetch(config, '/Administration/LocationAvailability/list', {
    method: 'POST',
    headers: {
      origin: baseUrl,
      referer: `${baseUrl}/Administration/LocationAvailability/Index`,
    },
    formBody: {
      LocationId: String(locationId),
      StartDate: formatMvcDate(weekStartDate),
      OnlyShowWorking: 'Rostered',
      StaffId: '',
    },
  });
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 240);
    throw new Error(`YOT MVC roster fetch failed: HTTP ${res.status} ${snippet}`);
  }
  return res.text();
}

/**
 * Same as fetchLocationRosterHtml but yields each (stylist, day) entry as a
 * RosterEntry. Convenience wrapper combining the driver and the parser.
 */
export { parseRosterHtml as parseRosterFromHtml, scheduledOnly } from '../coverage/parse-roster-html';
export type { RosterEntry, RosterStatus } from '../coverage/parse-roster-html';
