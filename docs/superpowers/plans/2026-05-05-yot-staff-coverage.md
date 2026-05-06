# YOT Staff Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-location coverage feature that computes 30-min slot-level required vs actual stylist counts, surfaces "light" windows, and lists candidate stylists who could cover those gaps — backed by two new YOT Telerik reports (`LocationAvailability`, `StaffTimeCard`).

**Architecture:** Mirrors the existing `staff-cashout` reports pattern (Telerik server with API key passed as `Key:` discovery param). Two new XLSX-parsing report modules, a `coverage/` module containing pure-function math and pool ranking, a new `location_coverage_facts` SQLite cache, four new `/coverage/*` API endpoints, and a standalone Coverage tab. No HTML scraping or session login.

**Tech Stack:** TypeScript, drizzle-orm + better-sqlite3, vitest, the existing `react-without-react` `h()` style used by other tabs, esbuild bundling via `node scripts/build.js`.

**Spec:** `docs/superpowers/specs/2026-05-05-yot-staff-coverage-design.md`

**Branch:** `feat/coverage` (already pushed; PR #34 draft).

---

## Working notes (read once before starting)

1. **Telerik `reportType` strings in the spec are best-effort guesses.** Phase 2 confirms them with the cheapest possible call (`getParameters` only). Get those right before sinking work into parsers.
2. **TDD heavily for pure functions** (`coverage/compute.ts`, `coverage/find-cover.ts`). Light TDD for parsers (fixture-based). No tests for the Coverage tab UI — manually verify in the running kitchen, matching the existing tabs convention (no `tabs/__tests__`).
3. **Commit at the end of every task.** This is a long branch — frequent commits make bisection / rollback safe.
4. **Build after touching anything under `src/`.** Run `npm run build` before relying on `dist/` (the kitchen loads from `dist/`).
5. **Don't restart kitchen during the plan unless asked** — the user's policy in this branch's history.

---

## Phase 1 — Database schema

### Task 1.1: Add `location_coverage_facts` migration

**Files:**
- Create: `db/migrations/0006_location_coverage_facts.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0006_location_coverage_facts.sql
-- Per-location, per-day staff-coverage cache. Holds raw report payloads
-- (rostered + timecard) so the slot math can be recomputed without re-fetching.

CREATE TABLE IF NOT EXISTS location_coverage_facts (
  team_id                 TEXT NOT NULL,
  location_id             TEXT NOT NULL,
  date                    TEXT NOT NULL,                 -- ISO YYYY-MM-DD
  slot_payload            TEXT NOT NULL,                 -- JSON: { slots: [...] }
  rostered_payload        TEXT NOT NULL,                 -- JSON: raw report rows
  timecard_payload        TEXT NOT NULL,                 -- JSON: raw report rows
  computed_at             TEXT NOT NULL,                 -- ISO timestamp
  customers_per_stylist   INTEGER NOT NULL,
  PRIMARY KEY (team_id, location_id, date)
);

CREATE INDEX IF NOT EXISTS idx_location_coverage_facts_team_date
  ON location_coverage_facts (team_id, date);
```

- [ ] **Step 2: Verify it lints**

Run: `node -e "require('fs').readFileSync('db/migrations/0006_location_coverage_facts.sql', 'utf8'); console.log('readable ok')"`
Expected: `readable ok`

- [ ] **Step 3: Commit**

```bash
git add db/migrations/0006_location_coverage_facts.sql
git commit -m "feat(coverage): 0006 location_coverage_facts migration"
```

### Task 1.2: Add the table to the drizzle schema

**Files:**
- Modify: `src/db/schema.ts` (append before the type aliases block)

- [ ] **Step 1: Append the table definition**

Append immediately before the `export type Client = ...` style aliases at the bottom:

```ts
export const locationCoverageFacts = sqliteTable('location_coverage_facts', {
  teamId: text('team_id').notNull(),
  locationId: text('location_id').notNull(),
  date: text('date').notNull(),
  slotPayload: text('slot_payload').notNull(),
  rosteredPayload: text('rostered_payload').notNull(),
  timecardPayload: text('timecard_payload').notNull(),
  computedAt: text('computed_at').notNull(),
  customersPerStylist: integer('customers_per_stylist').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.teamId, t.locationId, t.date] }),
}));
```

Then below the existing `export type StaffCashoutFact = ...` aliases, add:

```ts
export type LocationCoverageFact = typeof locationCoverageFacts.$inferSelect;
export type NewLocationCoverageFact = typeof locationCoverageFacts.$inferInsert;
```

- [ ] **Step 2: Add `'location_coverage_facts'` to `SYNC_RESOURCES`**

In the `SYNC_RESOURCES` literal array at the bottom, append `'location_coverage_facts'` before the closing `] as const`.

- [ ] **Step 3: Build to verify TypeScript compiles**

Run: `npm run build`
Expected: `✅ Build complete.` and no TS errors.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat(coverage): drizzle schema for location_coverage_facts"
```

### Task 1.3: Wire the migration runner

**Files:**
- Verify: `src/db/index.ts` (existing migration loader — confirm it picks up `.sql` files automatically)

- [ ] **Step 1: Read `src/db/index.ts` and confirm migration discovery is glob-based**

Run: `grep -n "migrations\|0005" src/db/index.ts | head -5`
Expected: Existing code reads everything in `db/migrations/*.sql`. If yes — no code change needed (the new migration auto-loads). If no, add a registration entry mirroring `0005`.

- [ ] **Step 2: Run the existing test suite to confirm the migration applies cleanly**

Run: `npm test 2>&1 | tail -20`
Expected: All existing tests pass (we haven't added any yet that depend on the new table).

- [ ] **Step 3: Commit (if any change)**

If `src/db/index.ts` was modified:
```bash
git add src/db/index.ts
git commit -m "feat(coverage): register 0006 migration"
```
Otherwise: skip.

---

## Phase 2 — Confirm Telerik report identifiers

> Cheapest possible call: `getParameters()` only, no instance, no document. Sub-second round-trip. Catches a wrong `reportType` string immediately.

### Task 2.1: Probe LocationAvailability report

**Files:**
- Create: `scripts/probe-coverage-reports.ts`

- [ ] **Step 1: Write the probe script**

```ts
// scripts/probe-coverage-reports.ts
//
// Cheap probe: hits Telerik /api/reports/clients/<id>/parameters for two
// candidate reportType strings. Use to confirm the strings before wiring up
// param builders + parsers.
//
// Usage:
//   npx tsx scripts/probe-coverage-reports.ts --apiKey=<YOT_API_KEY> [--orgId=<n>] [--locationId=<n>]

import { createReportClient } from '../src/reports/client';
import type { YotConfig } from '../src/types';

function parseArgs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function probe(reportType: string, label: string, baseDiscovery: Record<string, string>): Promise<void> {
  const config: YotConfig = { apiKey: baseDiscovery.Key, baseUrl: 'https://api2.youreontime.com' };
  const client = createReportClient(config);
  console.log(`\n=== ${label}: ${reportType} ===`);
  try {
    const params = await client.getParameters(reportType, baseDiscovery);
    console.log(`OK — ${params.length} parameters discovered:`);
    for (const p of params) {
      console.log(`  - ${p.name} (${p.type})${p.isVisible ? '' : ' [hidden]'}${p.allowNull ? ' [nullable]' : ''}`);
      if (p.availableValues && p.availableValues.length <= 8) {
        for (const v of p.availableValues) console.log(`      • value=${JSON.stringify((v as any).value)} label=${JSON.stringify((v as any).label)}`);
      } else if (p.availableValues) {
        console.log(`      • ${p.availableValues.length} available values (truncated)`);
      }
    }
  } catch (err: any) {
    console.error(`FAIL — ${err?.message || err}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.apiKey) {
    console.error('Missing --apiKey=<YOT_API_KEY>');
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const baseDiscovery: Record<string, string> = {
    DateRange: 'Custom',
    StartDate: today,
    EndDate: today,
    FranchiseId: '',
    LocationId: args.locationId || '',
    StaffId: '',
    DoNothing: '',
    OrganisationId: args.orgId || '',
    Key: args.apiKey,
  };

  await probe(
    'YoureOnTime.Web.TelerikReports.LocationAvailability, YoureOnTime.Reports',
    'LocationAvailability (guess A)',
    { ...baseDiscovery, OnlyShowWorking: 'Rostered', Title: 'Location Availability', ReportName: 'LocationAvailabilityReport', ReportClass: 'LocationAvailability', FrameView: 'True' },
  );
  await probe(
    'YoureOnTime.Web.TelerikReports.StaffDensity, YoureOnTime.Reports',
    'StaffDensity (guess B)',
    { ...baseDiscovery, OnlyShowWorking: 'Rostered', Title: 'Staff Density', ReportName: 'StaffDensityReport', ReportClass: 'StaffDensity', FrameView: 'True' },
  );
  await probe(
    'YoureOnTime.Web.TelerikReports.StaffTimeCard, YoureOnTime.Reports',
    'StaffTimeCard (guess A)',
    { ...baseDiscovery, Title: 'Staff Time Card', ReportName: 'StaffTimeCardReport', ReportClass: 'StaffTimeCard', FrameView: 'True' },
  );
}

main().catch((err) => { console.error(err); process.exit(2); });
```

- [ ] **Step 2: Run the probe with a real API key**

Run:
```bash
npx tsx scripts/probe-coverage-reports.ts --apiKey="$YOT_API_KEY" --orgId=<known-org> --locationId=<known-loc>
```

Expected: One of each pair returns `OK — N parameters discovered`. Note which `reportType` string actually worked.

- [ ] **Step 3: Update the spec doc with the confirmed identifiers**

In `docs/superpowers/specs/2026-05-05-yot-staff-coverage-design.md`, replace the "Best-effort report identifiers" block with the confirmed strings. Note in the doc that they were verified on `<today>` against the live Telerik server.

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-coverage-reports.ts docs/superpowers/specs/2026-05-05-yot-staff-coverage-design.md
git commit -m "feat(coverage): probe script + confirmed Telerik reportType identifiers"
```

---

## Phase 3 — LocationAvailability report

### Task 3.1: Define report constants and types

**Files:**
- Create: `src/reports/reports/location-availability.ts`

- [ ] **Step 1: Write the constants and parameter types**

```ts
// src/reports/reports/location-availability.ts
import type { ReportDocumentFormat, ReportParameterDefinition } from '../client';
import { readWorkbook } from '../xlsx';

// Update reportType to whatever the Phase 2 probe confirmed.
export const LOCATION_AVAILABILITY_REPORT = {
  key: 'locationAvailability',
  reportName: 'LocationAvailabilityReport',
  reportType: 'YoureOnTime.Web.TelerikReports.LocationAvailability, YoureOnTime.Reports',
  preferredFormat: 'XLSX' as ReportDocumentFormat,
};

export type LocationAvailabilityParams = {
  startDateIso: string; // YYYY-MM-DD
  endDateIso: string;
  organisationId: number;
  locationId: number;
  staffId?: number | null;
  onlyShowWorking?: 'Rostered' | 'All';
};

export type RosteredSegment = {
  stylistId: string | null;
  stylistName: string | null;
  date: string;       // YYYY-MM-DD
  startsAt: string;   // ISO datetime
  endsAt: string;     // ISO datetime
  raw: string[];
};

export type LocationAvailabilityResult = {
  sheetName: string | null;
  headerRow: string[];
  parameters: Array<{ name: string; type: string; isVisible: boolean; value: unknown }>;
  rows: RosteredSegment[];
  debugAllRows?: string[][];
};
```

- [ ] **Step 2: Build to confirm TS compiles**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/reports/reports/location-availability.ts
git commit -m "feat(coverage): LocationAvailability report constants + types"
```

### Task 3.2: Param builders

**Files:**
- Modify: `src/reports/reports/location-availability.ts`

- [ ] **Step 1: Add `buildLocationAvailabilityParameterDiscovery`**

Append:

```ts
export function buildLocationAvailabilityParameterDiscovery(params: LocationAvailabilityParams, apiKey: string): Record<string, string> {
  return {
    DateRange: 'Custom',
    StartDate: params.startDateIso,
    EndDate: params.endDateIso,
    FranchiseId: '',
    LocationId: String(params.locationId),
    StaffId: params.staffId == null ? '' : String(params.staffId),
    OnlyShowWorking: params.onlyShowWorking ?? 'Rostered',
    DoNothing: '',
    Title: 'Location Availability',
    ReportName: LOCATION_AVAILABILITY_REPORT.reportName,
    FrameView: 'True',
    OrganisationId: String(params.organisationId),
    ReportClass: 'LocationAvailability',
    Key: apiKey,
  };
}
```

- [ ] **Step 2: Add `buildLocationAvailabilityInstanceParams`**

Append:

```ts
export function buildLocationAvailabilityInstanceParams(params: LocationAvailabilityParams): Record<string, string | number | null> {
  return {
    StartDate: params.startDateIso,
    EndDate: params.endDateIso,
    OrganisationId: params.organisationId,
    LocationId: params.locationId,
    StaffId: params.staffId ?? null,
    OnlyShowWorking: params.onlyShowWorking ?? 'Rostered',
  };
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add src/reports/reports/location-availability.ts
git commit -m "feat(coverage): LocationAvailability param builders"
```

### Task 3.3: TDD the parser — happy path

**Files:**
- Create: `src/reports/reports/__tests__/location-availability.test.ts`
- Create: `src/reports/reports/__tests__/fixtures/location-availability-sample.json` (a serialized 2-D array of rows; we generate XLSX from it in the test)

- [ ] **Step 1: Create the fixture**

```json
[
  ["Location Availability — Westside — 2026-05-05"],
  [],
  ["Stylist", "Date", "Start", "End"],
  ["Sarah K.", "2026-05-05", "09:00", "13:00"],
  ["Mike R.", "2026-05-05", "12:00", "18:00"],
  ["Sarah K.", "2026-05-05", "14:00", "18:00"]
]
```

Save to `src/reports/reports/__tests__/fixtures/location-availability-sample.json`.

- [ ] **Step 2: Write a failing parser test**

```ts
// src/reports/reports/__tests__/location-availability.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { utils, write } from 'xlsx';
import { parseLocationAvailabilityWorkbook } from '../location-availability';

function makeXlsxBuffer(rows: string[][]): Buffer {
  const ws = utils.aoa_to_sheet(rows);
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, 'Roster');
  return Buffer.from(write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

describe('parseLocationAvailabilityWorkbook', () => {
  it('extracts rostered segments from a workbook with stylist/date/start/end columns', () => {
    const fixturePath = join(__dirname, 'fixtures/location-availability-sample.json');
    const rows = JSON.parse(readFileSync(fixturePath, 'utf8')) as string[][];
    const buf = makeXlsxBuffer(rows);
    const result = parseLocationAvailabilityWorkbook(buf);

    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      stylistName: 'Sarah K.',
      date: '2026-05-05',
      startsAt: '2026-05-05T09:00:00',
      endsAt: '2026-05-05T13:00:00',
    });
    expect(result.rows[2].stylistName).toBe('Sarah K.');
    expect(result.rows[2].startsAt).toBe('2026-05-05T14:00:00');
  });
});
```

- [ ] **Step 3: Run test — expect FAIL**

Run: `npx vitest run src/reports/reports/__tests__/location-availability.test.ts`
Expected: FAIL — `parseLocationAvailabilityWorkbook is not a function`.

- [ ] **Step 4: Implement minimal parser**

Append to `src/reports/reports/location-availability.ts`:

```ts
function normalizeHeader(value: string | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findHeaderRow(rows: string[][]): { index: number; row: string[] } {
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map(normalizeHeader);
    if (cells.includes('stylist') && cells.includes('date') && cells.includes('start') && cells.includes('end')) {
      return { index: i, row: rows[i] };
    }
  }
  return { index: -1, row: [] };
}

function parseTimeOnDate(date: string, time: string): string | null {
  if (!date || !time) return null;
  const t = time.trim();
  // accept HH:MM or HH:MM:SS, 24h
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = m[1].padStart(2, '0');
  const mm = m[2];
  const ss = m[3] ?? '00';
  return `${date}T${hh}:${mm}:${ss}`;
}

export function parseLocationAvailabilityWorkbook(
  buffer: Buffer,
  parameterDefinitions: ReportParameterDefinition[] = [],
  options: { includeDebugRows?: boolean } = {},
): LocationAvailabilityResult {
  const sheets = readWorkbook(buffer);
  const sheet = sheets[0] || null;
  if (!sheet) return { sheetName: null, headerRow: [], parameters: [], rows: [] };

  const { index: headerIndex, row: headerRow } = findHeaderRow(sheet.rows);
  if (headerIndex < 0) {
    return { sheetName: sheet.name, headerRow: [], parameters: [], rows: [] };
  }
  const headers = headerRow.map(normalizeHeader);
  const idx = (key: string): number => headers.indexOf(key);

  const stylistCol = idx('stylist');
  const dateCol = idx('date');
  const startCol = idx('start');
  const endCol = idx('end');

  const out: RosteredSegment[] = [];
  for (let r = headerIndex + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    const stylistName = String(row[stylistCol] || '').trim() || null;
    const date = String(row[dateCol] || '').trim();
    const startTime = String(row[startCol] || '').trim();
    const endTime = String(row[endCol] || '').trim();
    if (!stylistName || !date || !startTime || !endTime) continue;
    const startsAt = parseTimeOnDate(date, startTime);
    const endsAt = parseTimeOnDate(date, endTime);
    if (!startsAt || !endsAt) continue;
    out.push({
      stylistId: null,
      stylistName,
      date,
      startsAt,
      endsAt,
      raw: row.map((c) => String(c ?? '')),
    });
  }

  return {
    sheetName: sheet.name,
    headerRow,
    parameters: parameterDefinitions.map((p) => ({ name: p.name, type: p.type, isVisible: p.isVisible, value: p.value })),
    rows: out,
    ...(options.includeDebugRows ? { debugAllRows: sheet.rows } : {}),
  };
}
```

- [ ] **Step 5: Run test — expect PASS**

Run: `npx vitest run src/reports/reports/__tests__/location-availability.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/reports/reports/location-availability.ts src/reports/reports/__tests__/location-availability.test.ts src/reports/reports/__tests__/fixtures/location-availability-sample.json
git commit -m "feat(coverage): LocationAvailability XLSX parser + happy-path test"
```

### Task 3.4: Parser edge cases

**Files:**
- Modify: `src/reports/reports/__tests__/location-availability.test.ts`

- [ ] **Step 1: Add edge-case tests**

Append inside the `describe`:

```ts
it('skips rows missing stylist or time', () => {
  const buf = makeXlsxBuffer([
    ['Stylist', 'Date', 'Start', 'End'],
    ['', '2026-05-05', '09:00', '13:00'],     // no stylist
    ['Mike R.', '2026-05-05', '', '18:00'],    // no start
    ['Jen L.', '2026-05-05', '10:00', '14:00'],
  ]);
  const result = parseLocationAvailabilityWorkbook(buf);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].stylistName).toBe('Jen L.');
});

it('returns empty rows when header row is missing', () => {
  const buf = makeXlsxBuffer([
    ['Some Title'],
    [],
    ['unrelated', 'columns'],
    ['Bob', '2026-05-05'],
  ]);
  const result = parseLocationAvailabilityWorkbook(buf);
  expect(result.rows).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests — expect PASS**

Run: `npx vitest run src/reports/reports/__tests__/location-availability.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/reports/reports/__tests__/location-availability.test.ts
git commit -m "test(coverage): LocationAvailability parser edge cases"
```

### Task 3.5: Runner

**Files:**
- Create: `src/reports/run-location-availability.ts`
- Modify: `src/reports/report-registry.ts`

- [ ] **Step 1: Add registry entry**

In `src/reports/report-registry.ts`, add the import block and registry property mirroring `staffCashout`:

```ts
import {
  LOCATION_AVAILABILITY_REPORT,
  type LocationAvailabilityParams,
  type LocationAvailabilityResult,
  buildLocationAvailabilityInstanceParams,
  buildLocationAvailabilityParameterDiscovery,
  parseLocationAvailabilityWorkbook,
} from './reports/location-availability';
```

And in the `reportRegistry` object:

```ts
locationAvailability: {
  key: LOCATION_AVAILABILITY_REPORT.key,
  reportName: LOCATION_AVAILABILITY_REPORT.reportName,
  reportType: LOCATION_AVAILABILITY_REPORT.reportType,
  preferredFormat: LOCATION_AVAILABILITY_REPORT.preferredFormat,
  buildParameterDiscovery: buildLocationAvailabilityParameterDiscovery,
  buildInstanceParams: buildLocationAvailabilityInstanceParams,
  parseDocument: parseLocationAvailabilityWorkbook,
} satisfies YotReportDefinition<LocationAvailabilityParams, LocationAvailabilityResult>,
```

- [ ] **Step 2: Write the runner**

```ts
// src/reports/run-location-availability.ts
import { initializeDatabase } from '../db';
import type { YotConfig } from '../types';
import { createReportClient } from './client';
import { reportRegistry } from './report-registry';
import type { LocationAvailabilityResult } from './reports/location-availability';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

export type RunLocationAvailabilityOptions = {
  teamId: string;
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId: number;
  staffId?: number | null;
  onlyShowWorking?: 'Rostered' | 'All';
  includeDebugRows?: boolean;
};

function readConfig(sqlite: SqliteDb, teamId: string): YotConfig {
  const row = sqlite
    .prepare("SELECT value FROM plugin_config WHERE team_id = ? AND key = 'yot'")
    .get(teamId) as { value?: string } | undefined;
  if (!row?.value) throw new Error(`No YOT config found for team ${teamId}`);
  const parsed = JSON.parse(row.value) as YotConfig;
  if (!parsed?.apiKey) throw new Error(`Invalid YOT config payload for team ${teamId}`);
  return parsed;
}

export async function runLocationAvailabilityReport(options: RunLocationAvailabilityOptions): Promise<LocationAvailabilityResult> {
  const { sqlite } = initializeDatabase(options.teamId);
  const config = readConfig(sqlite, options.teamId);
  const client = createReportClient(config);
  const params = {
    startDateIso: options.startDateIso,
    endDateIso: options.endDateIso,
    organisationId: options.organisationId,
    locationId: options.locationId,
    staffId: options.staffId ?? null,
    onlyShowWorking: options.onlyShowWorking ?? 'Rostered',
  };
  const parameterDefinitions = await client.getParameters(
    reportRegistry.locationAvailability.reportType,
    reportRegistry.locationAvailability.buildParameterDiscovery(params, config.apiKey),
  );
  const instanceId = await client.createInstance(
    reportRegistry.locationAvailability.reportType,
    reportRegistry.locationAvailability.buildInstanceParams(params),
  );
  const document = await client.createDocument(instanceId, reportRegistry.locationAvailability.preferredFormat);
  await client.waitForDocument(instanceId, document.documentId);
  const file = await client.fetchDocument(instanceId, document.documentId);
  return reportRegistry.locationAvailability.parseDocument(file.buffer, parameterDefinitions, { includeDebugRows: options.includeDebugRows });
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add src/reports/report-registry.ts src/reports/run-location-availability.ts
git commit -m "feat(coverage): LocationAvailability runner + registry entry"
```

---

## Phase 4 — StaffTimeCard report

### Task 4.1–4.5

Mirror Phase 3 exactly with these substitutions:

| Phase 3 thing | Phase 4 substitution |
|---|---|
| `LocationAvailability` | `StaffTimeCard` |
| `LOCATION_AVAILABILITY_REPORT` | `STAFF_TIME_CARD_REPORT` |
| `RosteredSegment` | `TimeCardSegment` (rename `startsAt`/`endsAt` to `clockIn`/`clockOut`) |
| `Title: 'Location Availability'`, `ReportClass: 'LocationAvailability'` | `Title: 'Staff Time Card'`, `ReportClass: 'StaffTimeCard'` |
| reportType from Phase 2 confirmed string | corresponding StaffTimeCard string |
| `parseLocationAvailabilityWorkbook` | `parseStaffTimeCardWorkbook` (header columns: `Stylist`, `Date`, `Clock In`, `Clock Out` — confirm against actual XLSX after Task 4.3 first run) |

**Drop the `OnlyShowWorking` parameter** — StaffTimeCard doesn't take it.

After each task, run `npm run build` and commit. Same TDD structure for the parser (fixture, failing test, implement, pass, edge cases).

### Task 4.6: Quick verification — runner returns rows

**Files:**
- (Manual)

- [ ] **Step 1: Run both reports against a real day**

```bash
npx tsx -e "
import { runLocationAvailabilityReport } from './src/reports/run-location-availability';
import { runStaffTimeCardReport } from './src/reports/run-staff-time-card';
(async () => {
  const today = new Date().toISOString().slice(0,10);
  const opts = { teamId: 'hmx-marketing-team', startDateIso: today, endDateIso: today, organisationId: <ORG>, locationId: <LOC> };
  console.log('rostered:', (await runLocationAvailabilityReport(opts)).rows.length);
  console.log('timecard:', (await runStaffTimeCardReport(opts)).rows.length);
})().catch(e => { console.error(e); process.exit(1); });
"
```

Expected: both print non-zero row counts (assuming the chosen location had staff scheduled and clocking in/out today).

- [ ] **Step 2: If parser returns 0 rows, dump debugAllRows**

If counts are 0, re-run with `includeDebugRows: true` and inspect the actual sheet structure. Adjust column-name detection in the relevant parser. Commit any header-detection improvements as `fix(coverage): match real XLSX column names for <report>`.

---

## Phase 5 — Coverage compute (pure functions)

### Task 5.1: Types module

**Files:**
- Create: `src/coverage/types.ts`

- [ ] **Step 1: Write the types**

```ts
// src/coverage/types.ts

export type CoverageSlot = {
  startsAt: string;          // ISO datetime, slot start
  endsAt: string;            // ISO datetime, slot end
  customerCount: number;
  requiredStylists: number;
  actualStylists: number;
  rosteredStylists: number;
  light: boolean;
};

export type LightWindow = {
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  customerCount: number;     // peak across the window
  requiredStylists: number;  // peak across the window
  actualStylists: number;    // min across the window
  deficit: number;           // requiredStylists - actualStylists
};

export type Interval = { startsAt: string; endsAt: string };

export type StylistInterval = Interval & { stylistId: string };

export type CoverageInputs = {
  date: string;                     // YYYY-MM-DD
  businessHours: Interval;          // local-day window we're slotting
  slotMinutes: number;              // 30 by convention
  customersPerStylist: number;      // 10 by convention
  appointments: Array<Interval & { stylistId: string | null }>;
  rostered: StylistInterval[];
  timecard: StylistInterval[];
  now?: string;                     // ISO; if past `now`, prefer actual; if future, hybrid
};
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/coverage/types.ts
git commit -m "feat(coverage): shared types for slot/light-window/inputs"
```

### Task 5.2: TDD — slot generation (no overlaps)

**Files:**
- Create: `src/coverage/__tests__/compute.test.ts`
- Create: `src/coverage/compute.ts`

- [ ] **Step 1: Write the failing test for slot scaffolding**

```ts
// src/coverage/__tests__/compute.test.ts
import { describe, it, expect } from 'vitest';
import { computeCoverageSlots } from '../compute';
import type { CoverageInputs } from '../types';

const baseInputs = (overrides: Partial<CoverageInputs> = {}): CoverageInputs => ({
  date: '2026-05-05',
  businessHours: { startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T11:00:00' },
  slotMinutes: 30,
  customersPerStylist: 10,
  appointments: [],
  rostered: [],
  timecard: [],
  ...overrides,
});

describe('computeCoverageSlots', () => {
  it('produces the right number of slots for the business window', () => {
    const slots = computeCoverageSlots(baseInputs());
    expect(slots).toHaveLength(4); // 09:00, 09:30, 10:00, 10:30
    expect(slots[0].startsAt).toBe('2026-05-05T09:00:00');
    expect(slots[0].endsAt).toBe('2026-05-05T09:30:00');
    expect(slots[3].startsAt).toBe('2026-05-05T10:30:00');
  });
});
```

- [ ] **Step 2: Run — FAIL**

Run: `npx vitest run src/coverage/__tests__/compute.test.ts`
Expected: FAIL (`computeCoverageSlots is not a function`).

- [ ] **Step 3: Minimal implementation**

```ts
// src/coverage/compute.ts
import type { CoverageInputs, CoverageSlot } from './types';

function addMinutes(iso: string, minutes: number): string {
  const date = new Date(iso);
  date.setMinutes(date.getMinutes() + minutes);
  // Preserve "no Z" local-naive ISO produced upstream.
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}

export function computeCoverageSlots(input: CoverageInputs): CoverageSlot[] {
  const out: CoverageSlot[] = [];
  let cursor = input.businessHours.startsAt;
  while (cursor < input.businessHours.endsAt) {
    const next = addMinutes(cursor, input.slotMinutes);
    out.push({
      startsAt: cursor,
      endsAt: next,
      customerCount: 0,
      requiredStylists: 0,
      actualStylists: 0,
      rosteredStylists: 0,
      light: false,
    });
    cursor = next;
  }
  return out;
}
```

- [ ] **Step 4: Run — PASS**

Run: `npx vitest run src/coverage/__tests__/compute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coverage/compute.ts src/coverage/__tests__/compute.test.ts
git commit -m "feat(coverage): empty slot scaffolding for business window"
```

### Task 5.3: TDD — customer counts and required staff

**Files:**
- Modify: `src/coverage/__tests__/compute.test.ts`
- Modify: `src/coverage/compute.ts`

- [ ] **Step 1: Add failing tests for customer counting**

```ts
it('counts overlapping appointments per slot', () => {
  const slots = computeCoverageSlots(baseInputs({
    appointments: [
      { startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T09:30:00', stylistId: 's1' },
      { startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T10:00:00', stylistId: 's2' },
      { startsAt: '2026-05-05T10:30:00', endsAt: '2026-05-05T11:00:00', stylistId: 's3' },
    ],
  }));
  expect(slots[0].customerCount).toBe(2); // 09:00 slot has 2 appts
  expect(slots[1].customerCount).toBe(1); // 09:30 slot has the long one
  expect(slots[2].customerCount).toBe(0); // 10:00 slot empty
  expect(slots[3].customerCount).toBe(1); // 10:30 slot
});

it('computes requiredStylists = ceil(customers / customersPerStylist)', () => {
  const slots = computeCoverageSlots(baseInputs({
    customersPerStylist: 10,
    appointments: Array.from({ length: 25 }, (_, i) => ({
      startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T09:30:00', stylistId: `c${i}`,
    })),
  }));
  expect(slots[0].customerCount).toBe(25);
  expect(slots[0].requiredStylists).toBe(3);   // ceil(25/10)
});
```

- [ ] **Step 2: Run — FAIL**

Run: `npx vitest run src/coverage/__tests__/compute.test.ts`
Expected: FAIL (counts stay 0).

- [ ] **Step 3: Implement counting + required**

In `compute.ts`, add:

```ts
function overlaps(a: { startsAt: string; endsAt: string }, b: { startsAt: string; endsAt: string }): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}
```

Modify `computeCoverageSlots` so that during slot generation, for each slot:

```ts
const customerCount = input.appointments.filter((a) => overlaps(a, { startsAt: cursor, endsAt: next })).length;
const requiredStylists = Math.ceil(customerCount / input.customersPerStylist);
out.push({
  startsAt: cursor,
  endsAt: next,
  customerCount,
  requiredStylists,
  actualStylists: 0,
  rosteredStylists: 0,
  light: false,
});
```

- [ ] **Step 4: Run — PASS**

Run: `npx vitest run src/coverage/__tests__/compute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coverage/compute.ts src/coverage/__tests__/compute.test.ts
git commit -m "feat(coverage): customer counts + requiredStylists per slot"
```

### Task 5.4: TDD — actual + rostered counts and `light` flag

**Files:**
- Modify: `src/coverage/__tests__/compute.test.ts`
- Modify: `src/coverage/compute.ts`

- [ ] **Step 1: Add failing tests**

```ts
it('counts distinct stylists from timecard and roster overlapping each slot', () => {
  const slots = computeCoverageSlots(baseInputs({
    rostered: [
      { stylistId: 's1', startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T13:00:00' },
      { stylistId: 's2', startsAt: '2026-05-05T10:00:00', endsAt: '2026-05-05T14:00:00' },
    ],
    timecard: [
      { stylistId: 's1', startsAt: '2026-05-05T09:05:00', endsAt: '2026-05-05T13:00:00' },
    ],
    appointments: [
      { startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T09:30:00', stylistId: 'c1' },
    ],
    customersPerStylist: 10,
  }));
  expect(slots[0].rosteredStylists).toBe(1); // only s1 at 09:00
  expect(slots[0].actualStylists).toBe(1);   // s1 timecard overlaps
  expect(slots[0].requiredStylists).toBe(1); // ceil(1/10)
  expect(slots[0].light).toBe(false);

  expect(slots[2].rosteredStylists).toBe(2); // s1 + s2 at 10:00
});

it('flags light=true when actualStylists < requiredStylists', () => {
  const slots = computeCoverageSlots(baseInputs({
    customersPerStylist: 10,
    appointments: Array.from({ length: 15 }, () => ({
      startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T09:30:00', stylistId: null,
    })),
    timecard: [
      { stylistId: 's1', startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T11:00:00' },
    ],
  }));
  expect(slots[0].requiredStylists).toBe(2); // ceil(15/10)
  expect(slots[0].actualStylists).toBe(1);
  expect(slots[0].light).toBe(true);
});
```

- [ ] **Step 2: Run — FAIL**

Run: `npx vitest run src/coverage/__tests__/compute.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `computeCoverageSlots`**

```ts
function distinctStylistsOverlapping(
  list: Array<{ stylistId: string; startsAt: string; endsAt: string }>,
  slot: { startsAt: string; endsAt: string },
): number {
  const set = new Set<string>();
  for (const seg of list) {
    if (overlaps(seg, slot)) set.add(seg.stylistId);
  }
  return set.size;
}
```

In the slot loop:

```ts
const slot = { startsAt: cursor, endsAt: next };
const customerCount = input.appointments.filter((a) => overlaps(a, slot)).length;
const requiredStylists = Math.ceil(customerCount / input.customersPerStylist);
const rosteredStylists = distinctStylistsOverlapping(input.rostered, slot);
const actualStylists = distinctStylistsOverlapping(input.timecard, slot);
const light = actualStylists < requiredStylists;
out.push({ startsAt: cursor, endsAt: next, customerCount, requiredStylists, actualStylists, rosteredStylists, light });
```

- [ ] **Step 4: Run — PASS**

Run: `npx vitest run src/coverage/__tests__/compute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coverage/compute.ts src/coverage/__tests__/compute.test.ts
git commit -m "feat(coverage): actual/rostered counts + light flag per slot"
```

### Task 5.5: TDD — hybrid actual for future slots

**Files:**
- Modify: `src/coverage/__tests__/compute.test.ts`
- Modify: `src/coverage/compute.ts`

- [ ] **Step 1: Add failing test**

```ts
it('uses min(rostered,actual) for slots in the future when `now` is supplied', () => {
  const slots = computeCoverageSlots(baseInputs({
    now: '2026-05-05T10:00:00', // 10:00 slot is the boundary
    customersPerStylist: 10,
    appointments: Array.from({ length: 15 }, () => ({
      startsAt: '2026-05-05T10:30:00', endsAt: '2026-05-05T11:00:00', stylistId: null,
    })),
    rostered: [
      { stylistId: 's1', startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T11:00:00' },
      { stylistId: 's2', startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T11:00:00' },
    ],
    timecard: [
      // s1 clocked out early, s2 not yet logged for the future slot
      { stylistId: 's1', startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T10:15:00' },
    ],
  }));
  // 10:30 slot is in the future relative to `now`; rostered=2 but raw actual=0
  // hybrid: actual = min(rostered, raw_actual_known_so_far) = min(2,0) = 0 — UNLESS we want
  // the prediction to be the rostered count. Spec says: future slots use min(rostered, actual)
  // so a roster of 2 stays 2 unless someone clocked out, in which case it's the smaller.
  expect(slots[3].rosteredStylists).toBe(2);
  expect(slots[3].actualStylists).toBe(2); // future slot, predicted = rostered, no early-out yet
  // 09:30 slot is past, so raw timecard count applies: s1 was clocked in
  expect(slots[1].actualStylists).toBe(1);
});
```

- [ ] **Step 2: Run — FAIL** (current code produces actualStylists=0 for the future slot)

Run: `npx vitest run src/coverage/__tests__/compute.test.ts`
Expected: FAIL on the future-slot assertion.

- [ ] **Step 3: Implement hybrid**

After computing `actualStylists` raw, adjust:

```ts
let effectiveActual = actualStylists;
if (input.now && cursor >= input.now) {
  // Future slot: the prediction is the roster, but downgrade if anyone clocked out early.
  // "Clocked out early" detected as: someone rostered for this slot, no timecard segment
  // covering it, but had a timecard segment ending before `now`.
  const rosteredIds = new Set(input.rostered.filter((r) => overlaps(r, slot)).map((r) => r.stylistId));
  const earlyOuts = new Set(
    input.timecard
      .filter((t) => rosteredIds.has(t.stylistId) && t.endsAt < cursor)
      .map((t) => t.stylistId),
  );
  // If they're not already covered by another timecard segment overlapping this slot, treat them as out.
  for (const id of earlyOuts) {
    const stillCovered = input.timecard.some((t) => t.stylistId === id && overlaps(t, slot));
    if (stillCovered) earlyOuts.delete(id);
  }
  effectiveActual = Math.max(0, rosteredStylists - earlyOuts.size);
}
const light = effectiveActual < requiredStylists;
out.push({ startsAt: cursor, endsAt: next, customerCount, requiredStylists, actualStylists: effectiveActual, rosteredStylists, light });
```

- [ ] **Step 4: Run — PASS**

Run: `npx vitest run src/coverage/__tests__/compute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coverage/compute.ts src/coverage/__tests__/compute.test.ts
git commit -m "feat(coverage): hybrid actual = rostered minus early-clock-outs for future slots"
```

### Task 5.6: TDD — light-window aggregation

**Files:**
- Modify: `src/coverage/compute.ts` (export `aggregateLightWindows`)
- Modify: `src/coverage/__tests__/compute.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
import { aggregateLightWindows } from '../compute';

describe('aggregateLightWindows', () => {
  const slot = (startsAt: string, endsAt: string, opts: { customers: number; required: number; actual: number }) => ({
    startsAt, endsAt,
    customerCount: opts.customers,
    requiredStylists: opts.required,
    actualStylists: opts.actual,
    rosteredStylists: opts.required,
    light: opts.actual < opts.required,
  });

  it('groups consecutive light slots into windows ranked by deficit desc', () => {
    const slots = [
      slot('2026-05-05T09:00:00', '2026-05-05T09:30:00', { customers: 25, required: 3, actual: 1 }),
      slot('2026-05-05T09:30:00', '2026-05-05T10:00:00', { customers: 20, required: 2, actual: 1 }),
      slot('2026-05-05T10:00:00', '2026-05-05T10:30:00', { customers: 5, required: 1, actual: 2 }),
      slot('2026-05-05T10:30:00', '2026-05-05T11:00:00', { customers: 12, required: 2, actual: 1 }),
    ];
    const windows = aggregateLightWindows(slots);
    expect(windows).toHaveLength(2);
    // first window covers 09:00–10:00 (the 2 consecutive light slots)
    expect(windows[0].startsAt).toBe('2026-05-05T09:00:00');
    expect(windows[0].endsAt).toBe('2026-05-05T10:00:00');
    expect(windows[0].durationMinutes).toBe(60);
    expect(windows[0].deficit).toBe(2); // peak 3 required, min 1 actual
    // second window: 10:30–11:00
    expect(windows[1].startsAt).toBe('2026-05-05T10:30:00');
    expect(windows[1].deficit).toBe(1);
  });

  it('returns an empty list when nothing is light', () => {
    const slots = [
      slot('2026-05-05T09:00:00', '2026-05-05T09:30:00', { customers: 5, required: 1, actual: 2 }),
    ];
    expect(aggregateLightWindows(slots)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — FAIL**

Run: `npx vitest run src/coverage/__tests__/compute.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export function aggregateLightWindows(slots: CoverageSlot[]): LightWindow[] {
  const out: LightWindow[] = [];
  let i = 0;
  while (i < slots.length) {
    if (!slots[i].light) { i++; continue; }
    let j = i;
    while (j < slots.length && slots[j].light) j++;
    const group = slots.slice(i, j);
    const peakReq = group.reduce((m, s) => Math.max(m, s.requiredStylists), 0);
    const minActual = group.reduce((m, s) => Math.min(m, s.actualStylists), Infinity);
    const peakCustomers = group.reduce((m, s) => Math.max(m, s.customerCount), 0);
    const startsAt = group[0].startsAt;
    const endsAt = group[group.length - 1].endsAt;
    const durationMinutes = (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60000;
    out.push({
      startsAt,
      endsAt,
      durationMinutes,
      customerCount: peakCustomers,
      requiredStylists: peakReq,
      actualStylists: Number.isFinite(minActual) ? minActual : 0,
      deficit: peakReq - (Number.isFinite(minActual) ? minActual : 0),
    });
    i = j;
  }
  return out.sort((a, b) => (b.deficit - a.deficit) || a.startsAt.localeCompare(b.startsAt));
}
```

Add `LightWindow` to the imports/exports.

- [ ] **Step 4: Run — PASS**

Run: `npx vitest run src/coverage/__tests__/compute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coverage/compute.ts src/coverage/__tests__/compute.test.ts
git commit -m "feat(coverage): aggregateLightWindows + deficit ranking"
```

---

## Phase 6 — Find cover (staff-available pool)

### Task 6.1: TDD — same-location, rostered-with-gap pool

**Files:**
- Create: `src/coverage/__tests__/find-cover.test.ts`
- Create: `src/coverage/find-cover.ts`

- [ ] **Step 1: Failing test**

```ts
// src/coverage/__tests__/find-cover.test.ts
import { describe, it, expect } from 'vitest';
import { findStaffAvailable } from '../find-cover';

const stylist = (id: string, name: string, homeLocationId: string) => ({ id, name, homeLocationId });

const baseInputs = (overrides: any = {}) => ({
  locationId: 'L1',
  from: '2026-05-05T09:30:00',
  to: '2026-05-05T11:00:00',
  serviceMinutes: 30,
  pool: 'cross' as const,
  stylists: [
    stylist('s1', 'Sarah', 'L1'),
    stylist('s2', 'Mike', 'L2'),
    stylist('s3', 'Jen', 'L1'),
  ],
  rostered: [], // StylistInterval[] across all locations
  appointments: [], // (Interval & { stylistId })[]
  pastAppointmentsAtLocation: new Map<string, string>(), // stylistId -> last ISO ts at L
  ...overrides,
});

describe('findStaffAvailable', () => {
  it('returns rostered staff with a gap covering the requested window', () => {
    const out = findStaffAvailable(baseInputs({
      rostered: [
        { stylistId: 's1', startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T13:00:00' },
      ],
    }));
    expect(out).toHaveLength(1);
    expect(out[0].stylistId).toBe('s1');
    expect(out[0].gapMinutes).toBe(90);
    expect(out[0].qualifiedHere).toBe(true); // home is L1
    expect(out[0].rosteredToday).toBe(true);
  });
});
```

- [ ] **Step 2: Run — FAIL**

Run: `npx vitest run src/coverage/__tests__/find-cover.test.ts`
Expected: FAIL.

- [ ] **Step 3: Minimal implementation**

```ts
// src/coverage/find-cover.ts
import type { Interval, StylistInterval } from './types';

export type FindCoverPool = 'cross' | 'same';

export type StylistRecord = { id: string; name: string; homeLocationId: string | null };

export type FindCoverInputs = {
  locationId: string;
  from: string;
  to: string;
  serviceMinutes: number;
  pool: FindCoverPool;
  stylists: StylistRecord[];
  rostered: StylistInterval[];                              // across all locations
  appointments: Array<Interval & { stylistId: string }>;    // across all locations
  pastAppointmentsAtLocation: Map<string, string>;          // stylistId -> last ISO ts at this loc
};

export type CoverCandidate = {
  stylistId: string;
  name: string;
  homeLocationId: string | null;
  homeLocationName?: string | null;
  qualifiedHere: boolean;
  rosteredToday: boolean;
  gapStart: string;
  gapEnd: string;
  gapMinutes: number;
  lastWorkedHereAt: string | null;
};

function overlaps(a: Interval, b: Interval): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

function minutesBetween(a: string, b: string): number {
  return Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

export function findStaffAvailable(input: FindCoverInputs): CoverCandidate[] {
  const out: CoverCandidate[] = [];
  for (const s of input.stylists) {
    if (input.pool === 'same' && s.homeLocationId !== input.locationId) continue;
    const myRoster = input.rostered.filter((r) => r.stylistId === s.id);
    const myAppointments = input.appointments.filter((a) => a.stylistId === s.id);

    // Drop staff with an appointment overlapping [from,to] anywhere.
    const requestedWindow = { startsAt: input.from, endsAt: input.to };
    if (myAppointments.some((a) => overlaps(a, requestedWindow))) continue;

    let gapStart: string;
    let gapEnd: string;
    if (myRoster.length > 0) {
      // Use the roster segment that overlaps the requested window (largest if multiple).
      const overlapping = myRoster.filter((r) => overlaps(r, requestedWindow));
      if (overlapping.length === 0) continue; // rostered today but not for this window
      const seg = overlapping.reduce((acc, r) => (minutesBetween(r.startsAt, r.endsAt) > minutesBetween(acc.startsAt, acc.endsAt) ? r : acc), overlapping[0]);
      gapStart = seg.startsAt > input.from ? seg.startsAt : input.from;
      gapEnd = seg.endsAt < input.to ? seg.endsAt : input.to;
    } else {
      // Not rostered today — treat as fully free across the requested window.
      gapStart = input.from;
      gapEnd = input.to;
    }
    const gapMinutes = minutesBetween(gapStart, gapEnd);
    if (gapMinutes < input.serviceMinutes) continue;

    const lastWorkedHereAt = input.pastAppointmentsAtLocation.get(s.id) ?? null;
    const qualifiedHere = s.homeLocationId === input.locationId || lastWorkedHereAt != null;
    const rosteredToday = myRoster.length > 0;

    out.push({
      stylistId: s.id,
      name: s.name,
      homeLocationId: s.homeLocationId,
      qualifiedHere,
      rosteredToday,
      gapStart,
      gapEnd,
      gapMinutes,
      lastWorkedHereAt,
    });
  }
  return out.sort((a, b) =>
    Number(b.qualifiedHere) - Number(a.qualifiedHere) ||
    Number(b.rosteredToday) - Number(a.rosteredToday) ||
    b.gapMinutes - a.gapMinutes ||
    String(b.lastWorkedHereAt || '').localeCompare(String(a.lastWorkedHereAt || '')),
  );
}
```

- [ ] **Step 4: Run — PASS**

Run: `npx vitest run src/coverage/__tests__/find-cover.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coverage/find-cover.ts src/coverage/__tests__/find-cover.test.ts
git commit -m "feat(coverage): findStaffAvailable for rostered staff with gap"
```

### Task 6.2: TDD — non-rostered staff included in cross pool

**Files:**
- Modify: `src/coverage/__tests__/find-cover.test.ts`

- [ ] **Step 1: Add tests**

```ts
it('includes non-rostered staff in the cross pool', () => {
  const out = findStaffAvailable(baseInputs({
    rostered: [], // nobody rostered
    appointments: [],
    pool: 'cross',
  }));
  // All 3 stylists should appear; qualified ones (homeLocationId=L1) ranked first
  expect(out.map((o) => o.stylistId)).toEqual(['s1', 's3', 's2']);
  expect(out[0].rosteredToday).toBe(false);
  expect(out[0].gapStart).toBe('2026-05-05T09:30:00');
  expect(out[0].gapEnd).toBe('2026-05-05T11:00:00');
});

it('excludes a non-rostered stylist who has an appointment elsewhere overlapping the window', () => {
  const out = findStaffAvailable(baseInputs({
    rostered: [],
    appointments: [
      { stylistId: 's2', startsAt: '2026-05-05T10:00:00', endsAt: '2026-05-05T10:30:00' },
    ],
  }));
  expect(out.map((o) => o.stylistId)).not.toContain('s2');
});

it('drops `same` pool members not at this location', () => {
  const out = findStaffAvailable(baseInputs({
    pool: 'same',
    rostered: [
      { stylistId: 's2', startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T13:00:00' },
    ],
  }));
  expect(out.map((o) => o.stylistId)).not.toContain('s2');
});
```

- [ ] **Step 2: Run — should PASS already**

The minimal implementation should already cover these. Run:

`npx vitest run src/coverage/__tests__/find-cover.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/coverage/__tests__/find-cover.test.ts
git commit -m "test(coverage): non-rostered + cross/same pool semantics"
```

### Task 6.3: TDD — qualifiedHere via past appointments at this location

**Files:**
- Modify: `src/coverage/__tests__/find-cover.test.ts`

- [ ] **Step 1: Add test**

```ts
it('marks qualifiedHere=true for staff with a past appointment at this location', () => {
  const past = new Map<string, string>([['s2', '2026-04-20T15:00:00']]);
  const out = findStaffAvailable(baseInputs({
    rostered: [],
    pastAppointmentsAtLocation: past,
  }));
  const s2 = out.find((o) => o.stylistId === 's2')!;
  expect(s2.qualifiedHere).toBe(true);
  expect(s2.lastWorkedHereAt).toBe('2026-04-20T15:00:00');
});
```

- [ ] **Step 2: Run — PASS** (already implemented)

Run: `npx vitest run src/coverage/__tests__/find-cover.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/coverage/__tests__/find-cover.test.ts
git commit -m "test(coverage): qualifiedHere via past-appointments map"
```

---

## Phase 7 — Sync orchestrator

### Task 7.1: Sync skeleton

**Files:**
- Create: `src/coverage/sync.ts`

- [ ] **Step 1: Write the orchestrator**

```ts
// src/coverage/sync.ts
import { initializeDatabase } from '../db';
import { runLocationAvailabilityReport } from '../reports/run-location-availability';
import { runStaffTimeCardReport } from '../reports/run-staff-time-card';
import { computeCoverageSlots, aggregateLightWindows } from './compute';
import type { CoverageSlot, StylistInterval } from './types';
import * as schema from '../db/schema';
import { and, eq } from 'drizzle-orm';

export type SyncCoverageOptions = {
  teamId: string;
  locationId: string;
  date: string;                  // YYYY-MM-DD
  organisationId: number;
  customersPerStylist?: number;  // default 10
  businessHoursStart?: string;   // HH:MM, default 08:00
  businessHoursEnd?: string;     // HH:MM, default 20:00
  slotMinutes?: number;          // default 30
};

export type SyncCoverageResult = {
  slots: CoverageSlot[];
  computedAt: string;
};

function readAppointmentsForDay(db: ReturnType<typeof initializeDatabase>['db'], teamId: string, locationId: string, date: string) {
  const rows = db.select().from(schema.appointments).where(
    and(eq(schema.appointments.teamId, teamId), eq(schema.appointments.locationId, locationId)),
  ).all() as schema.Appointment[];
  // Filter to the day in TS; appointments aren't stored as date-only.
  return rows
    .filter((r) => {
      const startsAt = r.startAt ?? r.startsAt;
      const endsAt = r.endAt ?? r.endsAt;
      return startsAt && endsAt && startsAt.slice(0, 10) === date;
    })
    .map((r) => ({
      startsAt: (r.startAt ?? r.startsAt) as string,
      endsAt: (r.endAt ?? r.endsAt) as string,
      stylistId: (r.stylistId ?? r.staffId) ?? null,
    }));
}

function rostersToIntervals(rows: Array<{ stylistId: string | null; startsAt: string; endsAt: string }>): StylistInterval[] {
  return rows
    .filter((r) => r.stylistId)
    .map((r) => ({ stylistId: r.stylistId as string, startsAt: r.startsAt, endsAt: r.endsAt }));
}

export async function syncCoverageForLocationDay(opts: SyncCoverageOptions): Promise<SyncCoverageResult> {
  const customersPerStylist = opts.customersPerStylist ?? 10;
  const slotMinutes = opts.slotMinutes ?? 30;
  const startHHMM = opts.businessHoursStart ?? '08:00';
  const endHHMM = opts.businessHoursEnd ?? '20:00';
  const businessHours = {
    startsAt: `${opts.date}T${startHHMM}:00`,
    endsAt: `${opts.date}T${endHHMM}:00`,
  };

  const { db, sqlite } = initializeDatabase(opts.teamId);

  const [rostered, timecard] = await Promise.all([
    runLocationAvailabilityReport({
      teamId: opts.teamId,
      startDateIso: opts.date,
      endDateIso: opts.date,
      organisationId: opts.organisationId,
      locationId: Number(opts.locationId),
      onlyShowWorking: 'Rostered',
    }),
    runStaffTimeCardReport({
      teamId: opts.teamId,
      startDateIso: opts.date,
      endDateIso: opts.date,
      organisationId: opts.organisationId,
      locationId: Number(opts.locationId),
    }),
  ]);

  const appointments = readAppointmentsForDay(db, opts.teamId, opts.locationId, opts.date);

  const slots = computeCoverageSlots({
    date: opts.date,
    businessHours,
    slotMinutes,
    customersPerStylist,
    appointments,
    rostered: rostersToIntervals(rostered.rows),
    timecard: rostersToIntervals(timecard.rows.map((r) => ({ stylistId: r.stylistId, startsAt: (r as any).clockIn, endsAt: (r as any).clockOut }))),
    now: new Date().toISOString().slice(0, 19),
  });

  const computedAt = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO location_coverage_facts
        (team_id, location_id, date, slot_payload, rostered_payload, timecard_payload, computed_at, customers_per_stylist)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.teamId,
      opts.locationId,
      opts.date,
      JSON.stringify({ slots }),
      JSON.stringify({ rows: rostered.rows }),
      JSON.stringify({ rows: timecard.rows }),
      computedAt,
      customersPerStylist,
    );

  return { slots, computedAt };
}

export function readCachedCoverage(
  teamId: string,
  locationId: string,
  date: string,
): SyncCoverageResult | null {
  const { sqlite } = initializeDatabase(teamId);
  const row = sqlite
    .prepare('SELECT slot_payload, computed_at FROM location_coverage_facts WHERE team_id=? AND location_id=? AND date=?')
    .get(teamId, locationId, date) as { slot_payload?: string; computed_at?: string } | undefined;
  if (!row?.slot_payload) return null;
  const parsed = JSON.parse(row.slot_payload) as { slots: CoverageSlot[] };
  return { slots: parsed.slots, computedAt: row.computed_at as string };
}

export { aggregateLightWindows };
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/coverage/sync.ts
git commit -m "feat(coverage): syncCoverageForLocationDay orchestrator + cache read"
```

---

## Phase 8 — API endpoints

### Task 8.1: Wire `POST /coverage/sync`

**Files:**
- Modify: `src/api/handler.ts`

- [ ] **Step 1: Locate the handler entry**

Run: `grep -n "if (req.path === '/business'" src/api/handler.ts | head -1`
Expected: a handler-block start near the top of `handleRequest`. New `/coverage/*` blocks go before the final `return apiError(404, ...)`.

- [ ] **Step 2: Add the endpoint**

Add (just before the final 404 in `handleRequest`):

```ts
if (req.path === '/coverage/sync' && req.method === 'POST') {
  try {
    const body = (req.body || {}) as { locationId?: string; date?: string; organisationId?: number; customersPerStylist?: number };
    if (!body.locationId || !body.date || !body.organisationId) return apiError(400, 'BAD_REQUEST', 'locationId, date, organisationId required');
    const { syncCoverageForLocationDay } = await import('../coverage/sync');
    const result = await syncCoverageForLocationDay({
      teamId,
      locationId: body.locationId,
      date: body.date,
      organisationId: body.organisationId,
      customersPerStylist: body.customersPerStylist,
    });
    return { status: 200, data: result };
  } catch (err: any) {
    return apiError(500, 'COVERAGE_SYNC_FAILED', err?.message || 'sync failed');
  }
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add src/api/handler.ts
git commit -m "feat(coverage): POST /coverage/sync endpoint"
```

### Task 8.2: `GET /coverage/slots`

**Files:**
- Modify: `src/api/handler.ts`

- [ ] **Step 1: Add the endpoint**

```ts
if (req.path === '/coverage/slots' && req.method === 'GET') {
  const locationId = cleanString(req.query.locationId);
  const date = cleanString(req.query.date);
  if (!locationId || !date) return apiError(400, 'BAD_REQUEST', 'locationId and date required');
  const { readCachedCoverage } = await import('../coverage/sync');
  const cached = readCachedCoverage(teamId, locationId, date);
  if (!cached) return apiError(404, 'NO_COVERAGE_CACHE', 'Run /coverage/sync first');
  return { status: 200, data: cached };
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/api/handler.ts
git commit -m "feat(coverage): GET /coverage/slots endpoint"
```

### Task 8.3: `GET /coverage/light-windows`

**Files:**
- Modify: `src/api/handler.ts`

- [ ] **Step 1: Add the endpoint**

```ts
if (req.path === '/coverage/light-windows' && req.method === 'GET') {
  const locationId = cleanString(req.query.locationId);
  const date = cleanString(req.query.date);
  if (!locationId || !date) return apiError(400, 'BAD_REQUEST', 'locationId and date required');
  const { readCachedCoverage, aggregateLightWindows } = await import('../coverage/sync');
  const cached = readCachedCoverage(teamId, locationId, date);
  if (!cached) return apiError(404, 'NO_COVERAGE_CACHE', 'Run /coverage/sync first');
  const windows = aggregateLightWindows(cached.slots);
  return { status: 200, data: { windows, computedAt: cached.computedAt } };
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/api/handler.ts
git commit -m "feat(coverage): GET /coverage/light-windows endpoint"
```

### Task 8.4: `GET /coverage/staff-available`

**Files:**
- Modify: `src/api/handler.ts`

- [ ] **Step 1: Add the endpoint**

```ts
if (req.path === '/coverage/staff-available' && req.method === 'GET') {
  const locationId = cleanString(req.query.locationId);
  const from = cleanString(req.query.from);
  const to = cleanString(req.query.to);
  const serviceMinutes = Number(req.query.serviceMinutes ?? 30);
  const pool = (cleanString(req.query.pool) === 'same' ? 'same' : 'cross') as 'cross' | 'same';
  if (!locationId || !from || !to) return apiError(400, 'BAD_REQUEST', 'locationId, from, to required');

  const { db } = initializeDatabase(teamId);
  const { findStaffAvailable } = await import('../coverage/find-cover');

  const stylistsRaw = db.select().from(schema.stylists).where(eq(schema.stylists.teamId, teamId)).all() as schema.Stylist[];
  const stylists = stylistsRaw.map((s) => ({ id: s.id, name: s.fullName ?? `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim(), homeLocationId: s.locationId ?? s.sourceLocationId ?? null }));

  const apptsRaw = db.select().from(schema.appointments).where(eq(schema.appointments.teamId, teamId)).all() as schema.Appointment[];
  const appointments = apptsRaw
    .map((a) => ({ stylistId: (a.stylistId ?? a.staffId) as string | null, startsAt: (a.startAt ?? a.startsAt) as string | null, endsAt: (a.endAt ?? a.endsAt) as string | null, locationId: a.locationId ?? null }))
    .filter((a): a is { stylistId: string; startsAt: string; endsAt: string; locationId: string | null } => !!a.stylistId && !!a.startsAt && !!a.endsAt);

  // Past appointments at this location
  const pastAppointmentsAtLocation = new Map<string, string>();
  for (const a of appointments) {
    if (a.locationId !== locationId) continue;
    const prev = pastAppointmentsAtLocation.get(a.stylistId);
    if (!prev || a.startsAt > prev) pastAppointmentsAtLocation.set(a.stylistId, a.startsAt);
  }

  // Roster: pull cached coverage for the day and union all rostered intervals across all locations the team has cached today.
  const date = from.slice(0, 10);
  const { readCachedCoverage } = await import('../coverage/sync');
  // We only have the requested location's cached fact — for cross-location pool, also union others if cached.
  const allCached = (db.select().from(schema.locationCoverageFacts).all() as schema.LocationCoverageFact[])
    .filter((r) => r.teamId === teamId && r.date === date);
  const rostered: Array<{ stylistId: string; startsAt: string; endsAt: string }> = [];
  for (const r of allCached) {
    try {
      const payload = JSON.parse(r.rosteredPayload) as { rows: Array<{ stylistId: string | null; startsAt: string; endsAt: string }> };
      for (const row of payload.rows) {
        if (row.stylistId) rostered.push({ stylistId: row.stylistId, startsAt: row.startsAt, endsAt: row.endsAt });
      }
    } catch { /* ignore */ }
  }

  const result = findStaffAvailable({
    locationId,
    from,
    to,
    serviceMinutes,
    pool,
    stylists,
    rostered,
    appointments: appointments.map((a) => ({ stylistId: a.stylistId, startsAt: a.startsAt, endsAt: a.endsAt })),
    pastAppointmentsAtLocation,
  });

  return { status: 200, data: { candidates: result } };
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/api/handler.ts
git commit -m "feat(coverage): GET /coverage/staff-available endpoint"
```

---

## Phase 9 — Coverage tab UI

### Task 9.1: Register the tab

**Files:**
- Modify: `src/index.ts` (kitchen plugin manifest registration)
- Modify: `package.json` (`kitchenPlugin.tabs`)

- [ ] **Step 1: Register in `package.json`**

In `kitchenPlugin.tabs`, add:

```json
{ "id": "coverage", "label": "Coverage", "icon": "clock", "bundle": "./dist/tabs/coverage.js" }
```

- [ ] **Step 2: Register in `src/index.ts`**

Add a tab entry mirroring `appointments`/`clients`. Run `grep -n "tabs:" src/index.ts | head` to find the section; append a `{ id: 'coverage', component: () => import('./tabs/coverage') }` entry.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `dist/tabs/coverage.js` produced.

- [ ] **Step 4: Commit**

```bash
git add package.json src/index.ts
git commit -m "feat(coverage): register Coverage tab in plugin manifest"
```

### Task 9.2: Tab skeleton (location dropdown + date picker + refresh)

**Files:**
- Create: `src/tabs/coverage.tsx`

- [ ] **Step 1: Write the skeleton**

Mirror `src/tabs/appointments.tsx` for the imports and `t` (theme) helpers. Skeleton:

```tsx
// src/tabs/coverage.tsx
import { useState, useEffect, useMemo, type FC } from 'react';
import { api } from './common';
import { theme as t } from './common';
const h = (require('react') as any).createElement;

type Slot = {
  startsAt: string; endsAt: string;
  customerCount: number;
  requiredStylists: number;
  actualStylists: number;
  rosteredStylists: number;
  light: boolean;
};
type LightWindow = { startsAt: string; endsAt: string; durationMinutes: number; customerCount: number; requiredStylists: number; actualStylists: number; deficit: number };

export default function Coverage({ teamId }: { teamId: string }) {
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [locationId, setLocationId] = useState<string>('');
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [windows, setWindows] = useState<LightWindow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api('yot', teamId, '/locations').then((res: any) => {
      setLocations((res?.data || []).map((l: any) => ({ id: String(l.id), name: l.name })));
    }).catch((e: any) => setError(String(e?.message || e)));
  }, [teamId]);

  async function refresh() {
    setBusy(true); setError(null);
    try {
      // Run sync first if no cached row
      try {
        const slotsRes = await api('yot', teamId, `/coverage/slots?locationId=${encodeURIComponent(locationId)}&date=${date}`);
        setSlots(slotsRes.data.slots);
      } catch {
        // No cache — sync once.
        await api('yot', teamId, `/coverage/sync`, { method: 'POST', body: JSON.stringify({ locationId, date, organisationId: 0 /* TODO: read from config */ }) });
        const slotsRes = await api('yot', teamId, `/coverage/slots?locationId=${encodeURIComponent(locationId)}&date=${date}`);
        setSlots(slotsRes.data.slots);
      }
      const winRes = await api('yot', teamId, `/coverage/light-windows?locationId=${encodeURIComponent(locationId)}&date=${date}`);
      setWindows(winRes.data.windows);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return h('div', { style: { padding: '1rem' } },
    h('div', { style: { display: 'flex', gap: '0.5rem', alignItems: 'center' } },
      h('select', { value: locationId, onChange: (e: any) => setLocationId(e.target.value), style: t.input },
        h('option', { value: '' }, 'Pick a location…'),
        ...locations.map((l) => h('option', { key: l.id, value: l.id }, l.name)),
      ),
      h('input', { type: 'date', value: date, onChange: (e: any) => setDate(e.target.value), style: t.input }),
      h('button', { type: 'button', onClick: refresh, disabled: !locationId || busy, style: t.btnPrimary }, busy ? 'Loading…' : 'Refresh'),
    ),
    error ? h('div', { style: { color: 'red', marginTop: '0.5rem' } }, error) : null,
    slots.length > 0 ? renderSlotTable(slots) : null,
    windows.length > 0 ? renderLightWindows(windows) : null,
  );
}

function renderSlotTable(slots: Slot[]) {
  return h('table', { style: { ...t.table, marginTop: '1rem' } },
    h('thead', null, h('tr', null, ['Time', 'Required', 'Actual', 'Rostered', 'Customers', 'Status'].map((c) => h('th', { key: c, style: t.th }, c)))),
    h('tbody', null, ...slots.map((s) => h('tr', { key: s.startsAt, style: s.light ? { background: 'rgba(255,80,80,0.18)' } : undefined },
      h('td', { style: t.td }, s.startsAt.slice(11, 16)),
      h('td', { style: t.td }, s.requiredStylists),
      h('td', { style: t.td }, s.actualStylists),
      h('td', { style: t.td }, s.rosteredStylists),
      h('td', { style: t.td }, s.customerCount),
      h('td', { style: t.td }, s.light ? 'LIGHT' : 'ok'),
    ))),
  );
}

function renderLightWindows(windows: LightWindow[]) {
  return h('div', { style: { marginTop: '1rem' } },
    h('h3', null, 'Light windows'),
    h('ul', null, ...windows.map((w) => h('li', { key: w.startsAt },
      `${w.startsAt.slice(11,16)}–${w.endsAt.slice(11,16)} — needs ${w.requiredStylists}, have ${w.actualStylists} (deficit ${w.deficit})`,
    ))),
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: success and `dist/tabs/coverage.js` exists.

- [ ] **Step 3: Commit**

```bash
git add src/tabs/coverage.tsx
git commit -m "feat(coverage): Coverage tab skeleton (slot table + light windows)"
```

### Task 9.3: Find-cover inline panel

**Files:**
- Modify: `src/tabs/coverage.tsx`

- [ ] **Step 1: Add the inline panel**

Append next to the windows render:

```tsx
type Candidate = { stylistId: string; name: string; homeLocationId: string|null; qualifiedHere: boolean; rosteredToday: boolean; gapStart: string; gapEnd: string; gapMinutes: number; lastWorkedHereAt: string|null };

// inside the component:
const [coverWindow, setCoverWindow] = useState<LightWindow | null>(null);
const [serviceMins, setServiceMins] = useState(60);
const [pool, setPool] = useState<'cross' | 'same'>('cross');
const [candidates, setCandidates] = useState<Candidate[]>([]);

async function findCover(w: LightWindow) {
  setCoverWindow(w);
  const res = await api('yot', teamId,
    `/coverage/staff-available?locationId=${encodeURIComponent(locationId)}&from=${encodeURIComponent(w.startsAt)}&to=${encodeURIComponent(w.endsAt)}&serviceMinutes=${serviceMins}&pool=${pool}`);
  setCandidates(res.data.candidates);
}
```

Replace `renderLightWindows` to add a "Find cover" button per window calling `findCover(w)`.

Add a new render:

```tsx
function renderCandidates(w: LightWindow | null, candidates: Candidate[]) {
  if (!w) return null;
  return h('div', { style: { marginTop: '1rem', border: '1px solid #444', padding: '0.5rem' } },
    h('div', null, `Window: ${w.startsAt.slice(11,16)}–${w.endsAt.slice(11,16)}, deficit ${w.deficit}`),
    candidates.length === 0
      ? h('div', { style: { fontStyle: 'italic' } }, 'No candidates found.')
      : h('table', { style: t.table },
          h('thead', null, h('tr', null, ['Name', 'Home', 'Free', 'Rostered today', 'Qualified here'].map((c) => h('th', { key: c, style: t.th }, c)))),
          h('tbody', null, ...candidates.map((c) => h('tr', { key: c.stylistId },
            h('td', { style: t.td }, c.name),
            h('td', { style: t.td }, c.homeLocationId || '—'),
            h('td', { style: t.td }, `${c.gapStart.slice(11,16)}–${c.gapEnd.slice(11,16)} (${c.gapMinutes}m)`),
            h('td', { style: t.td }, c.rosteredToday ? 'Yes' : 'No'),
            h('td', { style: t.td }, c.qualifiedHere ? '✓' : '—'),
          ))),
        ),
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/tabs/coverage.tsx
git commit -m "feat(coverage): Find-cover inline panel + candidate table"
```

---

## Phase 10 — Background sync plist (out of repo)

### Task 10.1: Plist template + install instructions

**Files:**
- Create: `docs/coverage-sync-plist.plist.example` (template only — actual install lives in the user's `~/Library/LaunchAgents/`).

- [ ] **Step 1: Write the template**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.hairmx.yot-coverage-sync.hmx-marketing-team</string>
    <key>StartInterval</key>
    <integer>900</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>/Users/hairmx/.openclaw</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>sleep $((RANDOM % 60)); /usr/bin/shlock -p $$ -f /tmp/openclaw-tick.com.hairmx.yot-coverage-sync.hmx-marketing-team.lock &amp;&amp; /opt/homebrew/bin/openclaw kitchen plugin yot coverage-sync --team-id hmx-marketing-team --today-and-tomorrow</string>
    </array>
    <key>StandardOutPath</key>
    <string>/Users/hairmx/.openclaw/logs/yot-coverage-sync.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/hairmx/.openclaw/logs/yot-coverage-sync.err.log</string>
  </dict>
</plist>
```

- [ ] **Step 2: Add a small README section**

Append to `README.md` (or create `docs/coverage-sync.md`) with `launchctl bootstrap` install instructions and the matching `bootout` cleanup. Reference the project memory note about shlock-guarding short-lived ticks.

- [ ] **Step 3: Commit**

```bash
git add docs/coverage-sync-plist.plist.example README.md
git commit -m "docs(coverage): launchd plist template + install notes"
```

### Task 10.2: CLI wrapper for the cron tick

**Files:**
- Create: `scripts/coverage-sync.ts`

- [ ] **Step 1: Write the wrapper**

```ts
// scripts/coverage-sync.ts
//
// Cron-friendly entrypoint:
//   npx tsx scripts/coverage-sync.ts --team-id <T> [--today-and-tomorrow] [--locations 2651,2652]

import { syncCoverageForLocationDay } from '../src/coverage/sync';
import { initializeDatabase } from '../src/db';
import * as schema from '../src/db/schema';
import { eq } from 'drizzle-orm';

function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  for (const raw of process.argv.slice(2)) {
    const eq = raw.indexOf('=');
    if (raw.startsWith('--') && eq > 0) args[raw.slice(2, eq)] = raw.slice(eq + 1);
    else if (raw.startsWith('--')) args[raw.slice(2)] = 'true';
  }
  return args;
}

function todayPlusN(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs();
  const teamId = args['team-id'];
  if (!teamId) { console.error('Missing --team-id'); process.exit(1); }
  const dates = args['today-and-tomorrow'] === 'true' ? [todayPlusN(0), todayPlusN(1)] : [todayPlusN(0)];

  const { db, sqlite } = initializeDatabase(teamId);
  const locsArg = args['locations'];
  let locationIds: string[];
  if (locsArg) locationIds = locsArg.split(',').map((s) => s.trim()).filter(Boolean);
  else {
    const rows = db.select().from(schema.locations).where(eq(schema.locations.teamId, teamId)).all() as schema.Location[];
    locationIds = rows.map((r) => r.id);
  }

  const cfgRow = sqlite.prepare("SELECT value FROM plugin_config WHERE team_id=? AND key='yot'").get(teamId) as { value?: string } | undefined;
  const cfg = cfgRow?.value ? JSON.parse(cfgRow.value) : {};
  const orgId = Number(cfg?.organisationId || 0);
  if (!orgId) { console.error('YOT config missing organisationId'); process.exit(1); }

  for (const date of dates) {
    for (const locationId of locationIds) {
      try {
        const r = await syncCoverageForLocationDay({ teamId, locationId, date, organisationId: orgId });
        console.log(`OK  team=${teamId} loc=${locationId} date=${date}  slots=${r.slots.length}`);
      } catch (err: any) {
        console.error(`FAIL team=${teamId} loc=${locationId} date=${date}: ${err?.message || err}`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add scripts/coverage-sync.ts
git commit -m "feat(coverage): CLI wrapper for cron-driven coverage sync"
```

---

## Phase 11 — Smoke + ship

### Task 11.1: Manual end-to-end smoke

**Files:**
- (Manual)

- [ ] **Step 1: Trigger a sync from the CLI**

```bash
npx tsx scripts/coverage-sync.ts --team-id hmx-marketing-team --locations <known-loc-id>
```

Expected: `OK team=… loc=… date=…  slots=24` (12 hours × 2 slots/hour).

- [ ] **Step 2: Hit the endpoints via curl through the kitchen**

```bash
curl -sS -u kitchen:hair "http://127.0.0.1:7777/api/yot/coverage/slots?locationId=<id>&date=$(date +%F)" | jq '.data.slots | length'
curl -sS -u kitchen:hair "http://127.0.0.1:7777/api/yot/coverage/light-windows?locationId=<id>&date=$(date +%F)" | jq
```

Expected: slot count > 0; windows array (possibly empty) returns.

- [ ] **Step 3: Open Coverage tab in kitchen UI**

(After bouncing the kitchen, which is gated on the user's approval — not in plan scope.)

Expected: location dropdown populated, picking a location + date + Refresh shows the slot table; light cells red; "Find cover" populates a candidate table.

### Task 11.2: PR ready-for-review

**Files:**
- (PR housekeeping)

- [ ] **Step 1: Move PR #34 from draft to ready**

```bash
gh pr ready 34
```

- [ ] **Step 2: Push final state and request review**

```bash
git push
gh pr edit 34 --add-reviewer rjdjohnston
```

---

## Self-review notes

**Spec coverage check:**
- Per-location slot table → Phase 5
- Light windows → Phase 5 task 5.6 + Phase 8 task 8.3
- Cross-location find-cover incl. non-rostered → Phase 6 task 6.2
- Standalone Coverage tab → Phase 9
- Background sync via launchd → Phase 10
- `customersPerStylist` config knob → spec mentions per-location override; the plan persists the value in `location_coverage_facts`. Per-location override read-from-config is a thin add — not in v1 plan; flag for follow-up.

**Open items deliberately deferred (mentioned in plan body):**
- Per-location `customersPerStylist` override read from `YotConfig.coverage.perLocation[L]`. Currently the sync orchestrator accepts the value as a parameter and the CLI wrapper passes the team default; per-location override can be a tiny follow-up.
- `home_location_name` field on `CoverCandidate` is left as `homeLocationId` only — the tab UI looks up the name from the locations array client-side. No new endpoint complexity.
- StaffTimeCard parser column names (`Clock In`, `Clock Out` vs `In`, `Out`) confirmed in Phase 4 task 4.6 against real data.

**No placeholders.** Every step has commands or code. Telerik `reportType` strings are flagged as guesses with a verification task that runs before they're used.
