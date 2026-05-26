// Thin wrapper around the YOT MVC web app at app.youreontime.com.
//
// Unlike the REST API at api2.youreontime.com, this surface uses forms-auth
// session cookies — there's no APIKey header. The cookie is captured from a
// logged-in browser session and stored as `mvcCookie` in YotConfig. When YOT
// expires the session, the driver throws a `MvcAuthExpiredError` and the
// operator refreshes the cookie via config.

import type { YotConfig } from '../types';

const DEFAULT_BASE_URL = 'https://app.youreontime.com';

// YOT gates several endpoints on a real browser User-Agent (the default Node
// fetch UA gets bounced). Shared across login + session-probe requests.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// A page that always renders the global "welcome menu" chrome when the session
// is authenticated. Used purely as a cheap auth probe.
const SESSION_PROBE_PATH = '/Staff/PublicHolidays/Index';

/**
 * Decide whether an MVC page's HTML reflects a genuinely authenticated session.
 *
 * YOT does NOT redirect expired AJAX requests to /Account/Login — it returns
 * HTTP 200 with empty lists and a "zombie" welcome menu: the staff profile
 * image points at `ProfilePic/0` and the name is blank. A live session binds
 * the logged-in staff's numeric id (e.g. `ProfilePic/34422`). The login page
 * has no welcome menu at all. All three cases collapse to: a profile id > 0.
 */
export function isMvcSessionLive(html: string): boolean {
  const match = html.match(/\/Administration\/Staff\/ProfilePic\/(\d+)/);
  if (!match) return false;
  return Number(match[1]) > 0;
}

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

export class MvcLoginRejectedError extends Error {
  constructor(public detail: string) {
    super(`YOT MVC login rejected the credentials: ${detail}`);
    this.name = 'MvcLoginRejectedError';
  }
}

/**
 * POST credentials to /Account/Login and return a cookie-header string built
 * from the Set-Cookie response headers. Throws MvcLoginRejectedError when the
 * server bounces us back to the login page (typical for bad UserName / Password
 * / Organisation).
 */
export async function loginToMvc(config: YotConfig): Promise<string> {
  if (!config.mvcUserName || !config.mvcPassword || !config.mvcOrganisation) {
    throw new MvcLoginRejectedError('mvcUserName, mvcPassword, and mvcOrganisation must all be set');
  }
  const baseUrl = resolveBaseUrl(config);
  // YOT gates /Account/Login on User-Agent: the default Node fetch UA gets
  // bounced to /home/error with no Set-Cookie. Sending a real browser UA +
  // Origin + Referer makes the redirect resolve to /Appointment/Home and
  // carry the auth cookies. Verified empirically 2026-05-11.
  const res = await fetch(`${baseUrl}/Account/Login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': BROWSER_UA,
      origin: baseUrl,
      referer: `${baseUrl}/Account/Login`,
    },
    body: new URLSearchParams({
      UserName: config.mvcUserName,
      Password: config.mvcPassword,
      Organisation: config.mvcOrganisation,
      ReturnUrl: '/Appointment/Home',
    }).toString(),
  });

  // Successful login is a 302 redirect to /Diary or similar. A 200 means the
  // login page re-rendered (with an error banner) — treat as rejection.
  if (res.status !== 302 && res.status !== 303) {
    const body = await res.text();
    const lower = body.toLowerCase();
    const hint = lower.includes('login-form') ? 'login page returned (credentials rejected)' : `unexpected status ${res.status}`;
    throw new MvcLoginRejectedError(hint);
  }

  // Collect Set-Cookie headers (Node 18.13+ exposes getSetCookie; fall back to single).
  const getSetCookie = (res.headers as any).getSetCookie?.bind(res.headers);
  const setCookieList: string[] = getSetCookie ? getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
  if (setCookieList.length === 0) throw new MvcLoginRejectedError('login redirect carried no Set-Cookie');

  const pairs: string[] = [];
  for (const sc of setCookieList) {
    const firstSemi = sc.indexOf(';');
    const nameValue = (firstSemi > 0 ? sc.slice(0, firstSemi) : sc).trim();
    if (nameValue && nameValue.includes('=')) pairs.push(nameValue);
  }
  // YOT also expects YOT-Language/LocationId etc. for the AJAX endpoint to
  // behave like the browser. Carry those over from the existing cookie if present.
  if (config.mvcCookie) {
    const existingPairs = config.mvcCookie.split(';').map((s) => s.trim()).filter(Boolean);
    const newKeys = new Set(pairs.map((p) => p.split('=', 1)[0]));
    for (const ep of existingPairs) {
      const key = ep.split('=', 1)[0];
      // Only carry over things we didn't get fresh; skip auth cookies that login replaced.
      if (!newKeys.has(key) && !key.startsWith('.AspNetCore')) pairs.push(ep);
    }
  }
  return pairs.join('; ');
}

/**
 * GET a normal authenticated page and report whether the session is live.
 * Unlike mvcFetch, this never throws on expiry — it resolves to a boolean so
 * withAutoLogin can decide whether an empty result was real or a dead cookie.
 */
export async function defaultVerifyMvcSession(config: YotConfig): Promise<boolean> {
  if (!config.mvcCookie || !config.mvcCookie.trim()) return false;
  const res = await fetch(`${resolveBaseUrl(config)}${SESSION_PROBE_PATH}`, {
    headers: { accept: 'text/html', cookie: config.mvcCookie, 'user-agent': BROWSER_UA },
    redirect: 'manual',
  });
  if (res.status !== 200) return false;
  return isMvcSessionLive(await res.text());
}

export interface WithAutoLoginOptions<T> {
  /**
   * Flags an op result that looks empty. When it does, the session is probed
   * (YOT returns 200 + empty list for an expired cookie instead of redirecting
   * to login), and a dead session is treated as auth expiry.
   */
  looksEmpty?: (result: T) => boolean;
  /** Probe whether the session is authenticated. Injectable for tests. */
  verifySession?: (config: YotConfig) => Promise<boolean>;
  /** Login implementation. Injectable for tests; defaults to loginToMvc. */
  login?: (config: YotConfig) => Promise<string>;
}

/**
 * Wrap `op` so that auth expiry triggers a login (when credentials are
 * configured), persists the new cookie via `persistCookie`, then retries `op`
 * once with the refreshed config.
 *
 * Expiry is detected two ways: a thrown MvcAuthExpiredError/MvcAuthMissingError,
 * OR — when `options.looksEmpty` is supplied — an empty result whose session
 * fails a verification probe (the "zombie session" case YOT doesn't redirect).
 */
export async function withAutoLogin<T>(
  config: YotConfig,
  persistCookie: (cookie: string) => Promise<void> | void,
  op: (config: YotConfig) => Promise<T>,
  options: WithAutoLoginOptions<T> = {},
): Promise<T> {
  const verifySession = options.verifySession ?? defaultVerifyMvcSession;
  const login = options.login ?? loginToMvc;

  const attempt = async (cfg: YotConfig, allowVerify: boolean): Promise<T> => {
    const result = await op(cfg);
    if (allowVerify && options.looksEmpty?.(result) && !(await verifySession(cfg))) {
      throw new MvcAuthExpiredError(200);
    }
    return result;
  };

  try {
    return await attempt(config, true);
  } catch (err) {
    const isAuthErr = err instanceof MvcAuthExpiredError || err instanceof MvcAuthMissingError;
    const canLogin = !!(config.mvcUserName && config.mvcPassword && config.mvcOrganisation);
    if (!isAuthErr || !canLogin) throw err;

    const fresh = await login(config);
    await persistCookie(fresh);
    // Don't re-verify on the retry: a still-empty result is genuine emptiness,
    // and re-probing a fresh-but-empty session would loop.
    return attempt({ ...config, mvcCookie: fresh }, false);
  }
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

/**
 * Fetch the franchise list page from /Administration/Franchises/List.
 * Returns the raw HTML fragment (a `<ul class="list_view">` with one `<li>`
 * per franchise), which the caller passes to parseFranchisesHtml.
 *
 * Pagination: YOT's listView uses ?PageIndex=N. We fetch all pages by
 * stopping when an empty list comes back. In practice HMX has 7 franchises
 * which fits on a single page.
 */
export async function fetchFranchisesHtml(config: YotConfig): Promise<string> {
  const baseUrl = resolveBaseUrl(config);
  const pages: string[] = [];
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    const res = await mvcFetch(config, `/Administration/Franchises/List?PageIndex=${pageIndex}`, {
      method: 'POST',
      headers: {
        origin: baseUrl,
        referer: `${baseUrl}/Administration/Franchises/Index`,
      },
      body: '',
    });
    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 240);
      throw new Error(`YOT MVC franchises fetch failed: HTTP ${res.status} ${snippet}`);
    }
    const html = await res.text();
    pages.push(html);
    if (!/itemId=/i.test(html)) break;
    if (!/hasNextPage:\s*true/i.test(html)) break;
  }
  return pages.join('\n');
}

export { parseFranchisesHtml } from '../coverage/parse-franchises-html';
export type { FranchiseEntry } from '../coverage/parse-franchises-html';

/**
 * Fetch the public-holidays list page from /Staff/PublicHolidays/List.
 * Returns the joined HTML of all pages (one <li itemId> per holiday). The
 * `?PageIndex=N` query param is REQUIRED — without it the endpoint returns the
 * empty "no items" shell. Mirrors fetchFranchisesHtml's pagination.
 */
export async function fetchPublicHolidaysHtml(config: YotConfig): Promise<string> {
  const baseUrl = resolveBaseUrl(config);
  const pages: string[] = [];
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    const res = await mvcFetch(config, `/Staff/PublicHolidays/List?PageIndex=${pageIndex}`, {
      method: 'POST',
      headers: {
        origin: baseUrl,
        referer: `${baseUrl}/Staff/PublicHolidays/Index`,
      },
      body: '',
    });
    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 240);
      throw new Error(`YOT MVC public-holidays fetch failed: HTTP ${res.status} ${snippet}`);
    }
    const html = await res.text();
    pages.push(html);
    if (!/itemId=/i.test(html)) break;
    if (!/hasNextPage:\s*true/i.test(html)) break;
  }
  return pages.join('\n');
}
