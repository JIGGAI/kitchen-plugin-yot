# YOT Public Holidays on Coverage Diagrams — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync YOT's public holidays into the plugin and surface a "CLOSED — <name>" indicator on both staff-coverage diagrams (suppressing coverage-gap warnings on those dates).

**Architecture:** Holidays sync into a new `public_holidays` table (mirroring the franchises fetch/parse/sync pattern). The `/coverage/slots` and `/coverage/history` responses are augmented at read time with a `holiday` field looked up by date, so editing holidays in YOT reflects without re-running the coverage cache. Both front-ends render a closed badge and skip gap warnings when `holiday` is set.

**Tech Stack:** TypeScript, better-sqlite3 + drizzle, esbuild, vitest; vanilla JS dashboard + React-in-IIFE plugin tab.

**Branch:** `feat/yot-public-holidays-coverage` (already checked out). PR `--base main` when done. Do NOT rebuild `dist/` / restart the gateway until the feature is complete, tested, and the deploy is explicitly approved (the live kitchen symlinks this working tree).

---

## File Structure

- Create `db/migrations/0017_public_holidays.sql` — table DDL.
- Modify `src/db/schema.ts` — add `publicHolidays` drizzle table + types.
- Create `src/coverage/parse-public-holidays-html.ts` — HTML → `{holidayId,name,date}[]`.
- Create `src/coverage/__tests__/parse-public-holidays-html.test.ts` + `fixtures/public-holidays-sample.html`.
- Modify `src/drivers/yot-mvc-client.ts` — add `fetchPublicHolidaysHtml`.
- Create `src/coverage/sync-holidays.ts` — `syncPublicHolidays`, `holidaysByDate`, `listPublicHolidays`.
- Create `src/coverage/__tests__/sync-holidays.test.ts`.
- Modify `src/api/handler.ts` — `/public-holidays/sync`, `/public-holidays` routes; fold `holiday` into `/coverage/slots` + `/coverage/history`.
- Create `src/api/__tests__/coverage-holiday.test.ts`.
- Modify `~/Sites/hmx-dashboard/public/assets/staff-coverage.js` — closed badge + suppress (single-day + 10-day).
- Modify `src/tabs/coverage.tsx` — closed badge + suppress (single-day).
- Modify `~/.openclaw/scripts/yot-coverage-sync.sh` — call `/public-holidays/sync` once per run.

---

## Task 1: Schema + migration

**Files:**
- Create: `db/migrations/0017_public_holidays.sql`
- Modify: `src/db/schema.ts` (after the `franchises` table, ~line 65-75)

- [ ] **Step 1: Write the migration**

`db/migrations/0017_public_holidays.sql`:
```sql
-- Public holidays pulled from YOT's MVC web app (/Staff/PublicHolidays/List).
-- Global per team (YOT's holiday list is not per-location). Used to badge
-- store-closed days on the staff-coverage diagrams and suppress gap warnings.
CREATE TABLE IF NOT EXISTS public_holidays (
  team_id     TEXT NOT NULL,
  holiday_id  TEXT NOT NULL,          -- YOT itemId
  name        TEXT NOT NULL,
  date        TEXT NOT NULL,          -- YYYY-MM-DD
  synced_at   TEXT NOT NULL,
  PRIMARY KEY (team_id, holiday_id)
);
CREATE INDEX IF NOT EXISTS idx_public_holidays_team_date
  ON public_holidays (team_id, date);
```

- [ ] **Step 2: Add the drizzle table to schema.ts**

In `src/db/schema.ts`, after the `franchises` table definition add:
```typescript
export const publicHolidays = sqliteTable('public_holidays', {
  teamId: text('team_id').notNull(),
  holidayId: text('holiday_id').notNull(),
  name: text('name').notNull(),
  date: text('date').notNull(),       // YYYY-MM-DD
  syncedAt: text('synced_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.teamId, t.holidayId] }),
}));

export type PublicHoliday = typeof publicHolidays.$inferSelect;
export type NewPublicHoliday = typeof publicHolidays.$inferInsert;
```

- [ ] **Step 3: Verify the migration applies**

Run: `cd ~/kitchen-plugin-yot && npx tsx -e "import('./src/db').then(m => { m.initializeDatabase('hmx-marketing-team'); console.log('ok'); })"`
Expected: prints `ok`; then
Run: `sqlite3 ~/.openclaw/kitchen/plugins/yot/yot-hmx-marketing-team.db ".schema public_holidays"`
Expected: shows the `public_holidays` table + index.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0017_public_holidays.sql src/db/schema.ts
git commit -m "feat(holidays): public_holidays table + migration"
```

---

## Task 2: Parser

**Files:**
- Create: `src/coverage/parse-public-holidays-html.ts`
- Test: `src/coverage/__tests__/parse-public-holidays-html.test.ts`
- Fixture: `src/coverage/__tests__/fixtures/public-holidays-sample.html`

- [ ] **Step 1: Create the fixture** (real shape from `/Staff/PublicHolidays/List?PageIndex=0`)

`src/coverage/__tests__/fixtures/public-holidays-sample.html`:
```html
<ul class="list_view">
  <li itemId="16831"><span class='header'>Memorial Day</span><span class='detail'>05/25/2026</span></li>
  <li itemId="16832"><span class='header'>Independence Day</span><span class='detail'>07/04/2026</span></li>
  <li itemId="16836"><span class='header'>New Year&#x27;s Day</span><span class='detail'>01/01/2027</span></li>
  <li itemId="17020"><span class='header'>Independance Day weekend</span><span class='detail'>7/05/2026</span></li>
</ul>
```

- [ ] **Step 2: Write the failing test**

`src/coverage/__tests__/parse-public-holidays-html.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePublicHolidaysHtml } from '../parse-public-holidays-html';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/public-holidays-sample.html'), 'utf8');

describe('parsePublicHolidaysHtml', () => {
  it('extracts id, name, and ISO date for each holiday', () => {
    const out = parsePublicHolidaysHtml(FIXTURE);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ holidayId: '16831', name: 'Memorial Day', date: '2026-05-25' });
    expect(out[1]).toEqual({ holidayId: '16832', name: 'Independence Day', date: '2026-07-04' });
  });

  it('decodes HTML entities in names', () => {
    const out = parsePublicHolidaysHtml(FIXTURE);
    expect(out[2].name).toBe("New Year's Day");
  });

  it('normalizes non-zero-padded MM/DD/YYYY to YYYY-MM-DD', () => {
    const out = parsePublicHolidaysHtml(FIXTURE);
    expect(out[3].date).toBe('2026-07-05');
  });

  it('returns [] for unrecognized markup', () => {
    expect(parsePublicHolidaysHtml('<div>no items</div>')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/coverage/__tests__/parse-public-holidays-html.test.ts`
Expected: FAIL — cannot find module `../parse-public-holidays-html`.

- [ ] **Step 4: Write the parser**

`src/coverage/parse-public-holidays-html.ts`:
```typescript
// Parser for the YOT MVC /Staff/PublicHolidays/List HTML response.
//
//   <li itemId="16831">
//     <span class='header'>Memorial Day</span>
//     <span class='detail'>05/25/2026</span>
//   </li>
//
// 'header' is the holiday name, 'detail' is the date as MM/DD/YYYY (sometimes
// non-zero-padded). We normalize the date to YYYY-MM-DD.

export type PublicHolidayEntry = {
  holidayId: string;
  name: string;
  date: string; // YYYY-MM-DD
};

const LI_RE = /<li\s+itemId=["'](\d+)["'][\s\S]*?<\/li>/gi;
const HEADER_RE = /<span\s+class=['"]header['"][^>]*>([\s\S]*?)<\/span>/i;
const DETAIL_RE = /<span\s+class=['"]detail['"][^>]*>([\s\S]*?)<\/span>/i;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]*>/g, '')).trim();
}

/** MM/DD/YYYY (zero-padded or not) → YYYY-MM-DD. Returns '' if unparseable. */
function toIsoDate(mdy: string): string {
  const m = mdy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  const mm = m[1].padStart(2, '0');
  const dd = m[2].padStart(2, '0');
  return `${m[3]}-${mm}-${dd}`;
}

export function parsePublicHolidaysHtml(html: string): PublicHolidayEntry[] {
  const out: PublicHolidayEntry[] = [];
  for (const match of html.matchAll(LI_RE)) {
    const block = match[0];
    const holidayId = match[1];
    const headerMatch = block.match(HEADER_RE);
    const detailMatch = block.match(DETAIL_RE);
    if (!headerMatch || !detailMatch) continue;
    const name = stripTags(headerMatch[1]);
    const date = toIsoDate(stripTags(detailMatch[1]));
    if (!name || !date) continue;
    out.push({ holidayId, name, date });
  }
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/coverage/__tests__/parse-public-holidays-html.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/coverage/parse-public-holidays-html.ts src/coverage/__tests__/parse-public-holidays-html.test.ts src/coverage/__tests__/fixtures/public-holidays-sample.html
git commit -m "feat(holidays): parse public-holidays list HTML"
```

---

## Task 3: Driver fetch

**Files:**
- Modify: `src/drivers/yot-mvc-client.ts` (add after `fetchFranchisesHtml`, near the franchises exports)

- [ ] **Step 1: Add the fetch function**

In `src/drivers/yot-mvc-client.ts`, after `fetchFranchisesHtml`:
```typescript
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/drivers/yot-mvc-client.ts
git commit -m "feat(holidays): fetchPublicHolidaysHtml driver"
```

---

## Task 4: Sync + lookup

**Files:**
- Create: `src/coverage/sync-holidays.ts`
- Test: `src/coverage/__tests__/sync-holidays.test.ts`

- [ ] **Step 1: Write the failing test** (covers `holidaysByDate` + replace semantics, using a real temp DB)

`src/coverage/__tests__/sync-holidays.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { holidaysByDate, replaceHolidays } from '../sync-holidays';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE public_holidays (
    team_id TEXT NOT NULL, holiday_id TEXT NOT NULL, name TEXT NOT NULL,
    date TEXT NOT NULL, synced_at TEXT NOT NULL, PRIMARY KEY (team_id, holiday_id));`);
  return db;
}

describe('replaceHolidays', () => {
  it('replaces the team rows wholesale (removed-in-YOT holidays disappear)', () => {
    const db = makeDb();
    replaceHolidays(db, 'T', [
      { holidayId: '1', name: 'A', date: '2026-05-25' },
      { holidayId: '2', name: 'B', date: '2026-07-04' },
    ]);
    replaceHolidays(db, 'T', [{ holidayId: '1', name: 'A', date: '2026-05-25' }]);
    const rows = db.prepare('SELECT holiday_id FROM public_holidays WHERE team_id=?').all('T');
    expect(rows.map((r: any) => r.holiday_id)).toEqual(['1']);
  });

  it('does not touch other teams', () => {
    const db = makeDb();
    replaceHolidays(db, 'T1', [{ holidayId: '1', name: 'A', date: '2026-05-25' }]);
    replaceHolidays(db, 'T2', [{ holidayId: '9', name: 'Z', date: '2026-12-25' }]);
    replaceHolidays(db, 'T1', []);
    expect(db.prepare('SELECT COUNT(*) c FROM public_holidays WHERE team_id=?').get('T2')).toEqual({ c: 1 });
  });
});

describe('holidaysByDate', () => {
  it('maps only matching dates to names', () => {
    const db = makeDb();
    replaceHolidays(db, 'T', [
      { holidayId: '1', name: 'Memorial Day', date: '2026-05-25' },
      { holidayId: '2', name: 'Independence Day', date: '2026-07-04' },
    ]);
    const map = holidaysByDate(db, 'T', ['2026-05-25', '2026-05-26', '2026-07-04']);
    expect(map.get('2026-05-25')).toBe('Memorial Day');
    expect(map.get('2026-07-04')).toBe('Independence Day');
    expect(map.has('2026-05-26')).toBe(false);
  });

  it('returns an empty map for no dates', () => {
    const db = makeDb();
    expect(holidaysByDate(db, 'T', []).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/coverage/__tests__/sync-holidays.test.ts`
Expected: FAIL — cannot find module `../sync-holidays`.

- [ ] **Step 3: Write the module**

`src/coverage/sync-holidays.ts`:
```typescript
// Sync public holidays from the YOT MVC /Staff/PublicHolidays/List page into
// the local SQLite `public_holidays` table, and helpers to read them back.
// YOT is the source of truth; we never write holidays back to YOT.

import { initializeDatabase } from '../db';
import type { YotConfig } from '../types';
import {
  fetchPublicHolidaysHtml, withAutoLogin,
} from '../drivers/yot-mvc-client';
import { parsePublicHolidaysHtml, type PublicHolidayEntry } from './parse-public-holidays-html';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

export type SyncHolidaysResult = { syncedAt: string; count: number };

function readConfig(sqlite: SqliteDb, teamId: string): YotConfig {
  const row = sqlite
    .prepare("SELECT value FROM plugin_config WHERE team_id = ? AND key = 'yot'")
    .get(teamId) as { value?: string } | undefined;
  if (!row?.value) throw new Error(`No YOT config found for team ${teamId}`);
  const parsed = JSON.parse(row.value) as YotConfig;
  if (!parsed?.apiKey) throw new Error(`Invalid YOT config payload for team ${teamId}`);
  return parsed;
}

function persistMvcCookie(sqlite: SqliteDb, teamId: string, cookie: string): void {
  sqlite
    .prepare("UPDATE plugin_config SET value = json_set(value, '$.mvcCookie', ?) WHERE team_id = ? AND key = 'yot'")
    .run(cookie, teamId);
}

/** Replace all of a team's holiday rows with `entries` in a single transaction. */
export function replaceHolidays(sqlite: SqliteDb, teamId: string, entries: PublicHolidayEntry[]): string {
  const syncedAt = new Date().toISOString();
  const del = sqlite.prepare('DELETE FROM public_holidays WHERE team_id = ?');
  const ins = sqlite.prepare(
    'INSERT INTO public_holidays (team_id, holiday_id, name, date, synced_at) VALUES (?, ?, ?, ?, ?)',
  );
  const tx = sqlite.transaction((rows: PublicHolidayEntry[]) => {
    del.run(teamId);
    for (const r of rows) ins.run(teamId, r.holidayId, r.name, r.date, syncedAt);
  });
  tx(entries);
  return syncedAt;
}

/** date (YYYY-MM-DD) → holiday name, for the subset of `dates` that are holidays. */
export function holidaysByDate(sqlite: SqliteDb, teamId: string, dates: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (dates.length === 0) return out;
  const placeholders = dates.map(() => '?').join(',');
  const rows = sqlite
    .prepare(`SELECT date, name FROM public_holidays WHERE team_id = ? AND date IN (${placeholders})`)
    .all(teamId, ...dates) as Array<{ date: string; name: string }>;
  for (const r of rows) out.set(r.date, r.name);
  return out;
}

export type PublicHolidayRow = { holidayId: string; name: string; date: string };

export function listPublicHolidays(teamId: string, from?: string, to?: string): PublicHolidayRow[] {
  const { sqlite } = initializeDatabase(teamId);
  let sql = 'SELECT holiday_id AS holidayId, name, date FROM public_holidays WHERE team_id = ?';
  const args: string[] = [teamId];
  if (from) { sql += ' AND date >= ?'; args.push(from); }
  if (to) { sql += ' AND date <= ?'; args.push(to); }
  sql += ' ORDER BY date';
  return sqlite.prepare(sql).all(...args) as PublicHolidayRow[];
}

export async function syncPublicHolidays(opts: { teamId: string }): Promise<SyncHolidaysResult> {
  const { teamId } = opts;
  const { sqlite } = initializeDatabase(teamId);
  const config = readConfig(sqlite, teamId);
  const html = await withAutoLogin(
    config,
    (cookie) => persistMvcCookie(sqlite, teamId, cookie),
    (cfg) => fetchPublicHolidaysHtml(cfg),
    { looksEmpty: (h) => !/itemId=/i.test(h) },
  );
  const entries = parsePublicHolidaysHtml(html);
  const syncedAt = replaceHolidays(sqlite, teamId, entries);
  return { syncedAt, count: entries.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/coverage/__tests__/sync-holidays.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/coverage/sync-holidays.ts src/coverage/__tests__/sync-holidays.test.ts
git commit -m "feat(holidays): syncPublicHolidays + holidaysByDate + listPublicHolidays"
```

---

## Task 5: API routes

**Files:**
- Modify: `src/api/handler.ts` (add near the `/franchises/sync` + `/franchises` routes, ~line 4079-4096)

- [ ] **Step 1: Add the routes**

In `src/api/handler.ts`, immediately after the `/franchises` GET route block:
```typescript
  if (req.path === '/public-holidays/sync' && req.method === 'POST') {
    try {
      const { syncPublicHolidays } = await import('../coverage/sync-holidays');
      const result = await syncPublicHolidays({ teamId });
      return { status: 200, data: result };
    } catch (err: any) {
      const msg = err?.message || 'Public holidays sync failed';
      if (err?.name === 'MvcAuthMissingError') return apiError(412, 'MVC_AUTH_MISSING', msg);
      if (err?.name === 'MvcAuthExpiredError') return apiError(401, 'MVC_AUTH_EXPIRED', msg);
      return apiError(500, 'PUBLIC_HOLIDAYS_SYNC_FAILED', msg);
    }
  }

  if (req.path === '/public-holidays' && req.method === 'GET') {
    const { listPublicHolidays } = await import('../coverage/sync-holidays');
    const from = cleanString(req.query.from) || undefined;
    const to = cleanString(req.query.to) || undefined;
    return { status: 200, data: { holidays: listPublicHolidays(teamId, from, to) } };
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/api/handler.ts
git commit -m "feat(holidays): /public-holidays sync + list routes"
```

---

## Task 6: Fold `holiday` into coverage responses

**Files:**
- Modify: `src/api/handler.ts` — `/coverage/slots` route (~3656-3663) and `/coverage/history` cell build (~3858-3892)
- Test: `src/api/__tests__/coverage-holiday.test.ts`

- [ ] **Step 1: Write the failing test** (unit-tests the date-fold helper)

`src/api/__tests__/coverage-holiday.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { attachHolidayToCells } from '../coverage-holiday';

describe('attachHolidayToCells', () => {
  const holidays = new Map<string, string>([['2026-05-25', 'Memorial Day']]);

  it('marks a holiday cell closed with the holiday name and suppresses warnings', () => {
    const cell = { date: '2026-05-25', stylists: 3, appts: 5, required: 4, lightHours: 6, underCover: true, closed: false, hasRoster: true };
    const out = attachHolidayToCells([cell], holidays)[0];
    expect(out.closed).toBe(true);
    expect(out.holiday).toEqual({ name: 'Memorial Day' });
    expect(out.underCover).toBe(false);
    expect(out.lightHours).toBe(0);
  });

  it('leaves non-holiday cells unchanged with holiday=null', () => {
    const cell = { date: '2026-05-26', stylists: 3, appts: 5, required: 4, lightHours: 6, underCover: true, closed: false, hasRoster: true };
    const out = attachHolidayToCells([cell], holidays)[0];
    expect(out.holiday).toBeNull();
    expect(out.closed).toBe(false);
    expect(out.underCover).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/api/__tests__/coverage-holiday.test.ts`
Expected: FAIL — cannot find module `../coverage-holiday`.

- [ ] **Step 3: Write the helper**

`src/api/coverage-holiday.ts`:
```typescript
// Shared overlay: given coverage history cells and a date→holidayName map,
// mark holiday dates closed (with the name) and zero out gap warnings.

export type HistoryCell = {
  date: string;
  stylists: number;
  appts: number;
  required: number;
  lightHours: number;
  underCover: boolean;
  closed: boolean;
  hasRoster: boolean;
  holiday?: { name: string } | null;
};

export function attachHolidayToCells<T extends HistoryCell>(
  cells: T[],
  holidays: Map<string, string>,
): T[] {
  return cells.map((c) => {
    const name = holidays.get(c.date);
    if (!name) return { ...c, holiday: null };
    return { ...c, holiday: { name }, closed: true, underCover: false, lightHours: 0 };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/api/__tests__/coverage-holiday.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the helper into `/coverage/history`**

In `src/api/handler.ts` `/coverage/history`, replace the per-location `return { locationId, days: out };` (~line 3893) so the days are run through the overlay. After the `const data = Array.from(locationIds).map(...)` block is built but before the inactive-row `filtered`, add the holiday fold. First, near the top of the route (after `const { db, sqlite } = initializeDatabase(teamId);`) load holidays for the window:
```typescript
    const { holidaysByDate } = await import('../coverage/sync-holidays');
    const { attachHolidayToCells } = await import('./coverage-holiday');
```
Then change the location map's return to apply the overlay. Replace:
```typescript
      return { locationId, days: out };
```
with:
```typescript
      return { locationId, days: attachHolidayToCells(out, holidaysByDate(sqlite, teamId, days)) };
```
(`days` is the already-enumerated array of YYYY-MM-DD strings in scope; `holidaysByDate` is cheap and indexed, fine to call per location.)

- [ ] **Step 6: Wire `holiday` into `/coverage/slots`**

In `src/api/handler.ts` `/coverage/slots` route, replace:
```typescript
    const cached = readCachedCoverage(teamId, locationId, date);
    if (!cached) return apiError(404, 'NO_COVERAGE_CACHE', 'Run /coverage/sync first');
    return { status: 200, data: cached };
```
with:
```typescript
    const cached = readCachedCoverage(teamId, locationId, date);
    if (!cached) return apiError(404, 'NO_COVERAGE_CACHE', 'Run /coverage/sync first');
    const { holidaysByDate } = await import('../coverage/sync-holidays');
    const { sqlite: covSqlite } = initializeDatabase(teamId);
    const holidayName = holidaysByDate(covSqlite, teamId, [date]).get(date) ?? null;
    return { status: 200, data: { ...cached, holiday: holidayName ? { name: holidayName } : null } };
```

- [ ] **Step 7: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/api/handler.ts src/api/coverage-holiday.ts src/api/__tests__/coverage-holiday.test.ts
git commit -m "feat(holidays): fold holiday field into /coverage/slots + /coverage/history"
```

---

## Task 7: Dashboard UI (10-day table + single-day)

**Files:**
- Modify: `~/Sites/hmx-dashboard/public/assets/staff-coverage.js`

The dashboard is a feature-branch + PR repo (see memory) — do this on a dashboard branch and open a separate dashboard PR. (Plugin PR and dashboard PR are independent.)

- [ ] **Step 1: 10-day table — render CLOSED badge for holiday cells**

In `renderHistory`'s cell builder (the `if (!cell || cell.closed)` branch, ~line 742), replace:
```javascript
      if (!cell || cell.closed) {
        return `<td class="coverage-cell-missing coverage-history-cell" data-label="${dayLabel}" title="Closed">—</td>`;
      }
```
with:
```javascript
      if (cell && cell.holiday) {
        const hname = escapeHtml(cell.holiday.name);
        return `<td class="coverage-cell-holiday coverage-history-cell" data-label="${dayLabel}" title="Closed — ${hname}"><span class="coverage-cell-covered-label">CLOSED</span><span class="coverage-cell-appts">${hname}</span></td>`;
      }
      if (!cell || cell.closed) {
        return `<td class="coverage-cell-missing coverage-history-cell" data-label="${dayLabel}" title="Closed">—</td>`;
      }
```

- [ ] **Step 2: Single-day heatmap — suppress + badge when payload.holiday set**

In `shapeRow` (~line 197 where `closed`/`closedByDow` are read into the row), add `holiday`:
```javascript
    holiday: payload?.holiday || null,
```
Then in the single-day row renderer (the function that emits the per-location heatmap row, around line 420-430 where the `-${short}` cells are built), guard at the top of the row body: if `row.holiday`, render a single `CLOSED — <name>` banner cell instead of the slot cells and return early. Locate the row-render function and add, as its first statement after computing the label:
```javascript
    if (row.holiday) {
      return `<tr><td class="coverage-loc-col">${escapeHtml(row.locationName)}</td><td class="coverage-cell-holiday" colspan="99" title="Closed — ${escapeHtml(row.holiday.name)}">CLOSED — ${escapeHtml(row.holiday.name)}</td></tr>`;
    }
```

- [ ] **Step 3: Keep holiday rows visible**

In `isRowInactive` (~line 220-230), add at the top:
```javascript
  if (row.holiday) return false; // holiday = closed today, but keep the row visible
```

- [ ] **Step 4: Add minimal CSS**

In the dashboard's coverage stylesheet (search `coverage-cell-covered-label` to find the file), add:
```css
.coverage-cell-holiday { background: #2b2540; color: #d8c8ff; text-align: center; font-weight: 600; }
```

- [ ] **Step 5: Verify against live dashboard**

Reload `staff-coverage.html`. Set the date to **2026-05-25** (Memorial Day). Expected: every location row shows `CLOSED — Memorial Day` in the single-day view, and the 5/25 column in the 10-day table shows `CLOSED / Memorial Day` with no short-hours warning. Other days unchanged.

- [ ] **Step 6: Commit (dashboard repo)**

```bash
cd ~/Sites/hmx-dashboard
git add public/assets/staff-coverage.js public/assets/*.css
git commit -m "feat(coverage): show CLOSED — <holiday> on staff-coverage diagrams"
```

---

## Task 8: Plugin coverage tab UI

**Files:**
- Modify: `src/tabs/coverage.tsx`

- [ ] **Step 1: Read `holiday` from the slots response**

In `loadOne` (where `slotsRes` is shaped into a `LocationRow`, ~line 147-160), add `holiday: slotsRes?.holiday || null` to the returned row object, and add `holiday?: { name: string } | null` to the `LocationRow` type (~line 25-32).

- [ ] **Step 2: Render CLOSED badge + suppress for holiday rows**

In the location-row render (where each row's slot cells are emitted), add as the first check in the row body:
```tsx
        if (row.holiday) {
          return R.createElement('tr', { key: row.locationId },
            R.createElement('td', { className: 'cov-loc' }, row.locationName),
            R.createElement('td', { className: 'cov-holiday', colSpan: 99, title: `Closed — ${row.holiday.name}` }, `CLOSED — ${row.holiday.name}`),
          );
        }
```
(Match the file's actual React-element style; it uses `R.createElement` aliased as `R`. If the file uses JSX, use `<tr>…</tr>` instead.)

- [ ] **Step 3: Keep holiday rows visible**

In `isRowInactive` (~line 113), add at the top: `if (row.holiday) return false;`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/tabs/coverage.tsx
git commit -m "feat(holidays): CLOSED badge on plugin coverage tab"
```

---

## Task 9: Populate + nightly cron

**Files:**
- Modify: `~/.openclaw/scripts/yot-coverage-sync.sh`

- [ ] **Step 1: Add a holidays sync to the nightly script**

In `~/.openclaw/scripts/yot-coverage-sync.sh`, after the locations loop (before the final `echo "[$(ts)] yot-coverage-sync done ..."`), add:
```bash
# Holidays change rarely; refresh once per run so the coverage diagrams' CLOSED
# badges stay current. Non-fatal on failure.
if /usr/bin/curl -fsS -u "$KITCHEN_AUTH" --max-time 60 \
     -X POST "$KITCHEN_BASE/api/plugins/yot/public-holidays/sync?team=$TEAM_ID" \
     -H 'content-type: application/json' >/dev/null 2>>"$LOG_DIR/yot-coverage-sync.curl.err"; then
  echo "[$(ts)] public-holidays sync ok"
else
  echo "[$(ts)] WARN public-holidays sync failed" >&2
fi
```

- [ ] **Step 2: Populate now (after the plugin is deployed — see deploy note below)**

Run: `curl -fsS -u kitchen:hair -X POST "http://127.0.0.1:7777/api/plugins/yot/public-holidays/sync?team=hmx-marketing-team"`
Expected: `{"syncedAt":"...","count":17}` (≈17 holidays).
Verify: `sqlite3 ~/.openclaw/kitchen/plugins/yot/yot-hmx-marketing-team.db "SELECT date,name FROM public_holidays WHERE team_id='hmx-marketing-team' ORDER BY date LIMIT 5;"`

> **Deploy note:** Steps that hit the live kitchen (`/public-holidays/sync`, and the UI verification in Tasks 7/8) require the new plugin code to be running. After the plugin PR merges, deploy with `npm run build` in `~/kitchen-plugin-yot` + `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway` (the kitchen symlinks this working tree; ~2.5 min cold-start). Get explicit approval before restarting — it bounces all of OpenClaw.

---

## Task 10: Final verification + PR

- [ ] **Step 1: Full test suite + typecheck**

Run: `cd ~/kitchen-plugin-yot && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all tests pass (existing + new parser/sync/coverage-holiday).

- [ ] **Step 2: Push + open the plugin PR**

```bash
git push -u origin feat/yot-public-holidays-coverage
gh pr create --base main --title "feat(yot): public holidays → CLOSED on staff-coverage diagrams" \
  --body "Implements docs/superpowers/specs/2026-05-25-yot-public-holidays-coverage-design.md. Syncs YOT public holidays into public_holidays; folds a holiday field into /coverage/slots + /coverage/history; both diagrams show CLOSED — <name> and suppress gap warnings on holiday dates. Dashboard UI ships in a separate dashboard PR."
```

- [ ] **Step 3: Open the dashboard PR** (separate repo)

```bash
cd ~/Sites/hmx-dashboard && git push -u origin <dashboard-branch>
gh pr create --base main --title "feat(coverage): CLOSED — <holiday> on staff-coverage diagrams" --body "Consumes the new holiday field from /api/yot/coverage/*."
```

---

## Notes for the implementer

- **DRY:** `attachHolidayToCells` is the single source of the "holiday ⇒ closed + suppress" rule; both response paths use the same `holidaysByDate` lookup.
- **YAGNI:** no per-location overrides, no holiday editing UI, no half-day support (per the spec's out-of-scope).
- **Do not rebuild `dist/` or restart the gateway** until the plugin PR is merged and deploy is approved — the live kitchen runs this working tree's `dist/`.
- The `holiday` field is computed at read time, so a `/public-holidays/sync` takes effect immediately without re-running `/coverage/sync`.
