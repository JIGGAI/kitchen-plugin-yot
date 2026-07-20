# HMX GROUP Disbursements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second nightly Branch disbursement CSV + distribution group for HAIR MX GROUP (4 Florida locations, 32 staff, no loans or garnishments) by parameterizing the existing CORP scripts, without changing CORP behavior.

**Architecture:** A `DisbursementGroupConfig` registry keyed by group id, selected with `--group=corp|hmx-group` (default `corp`). All group-varying values — roster tab, spreadsheet targets, BRANCH MASTER row geometry, recipients, filename prefix, and garnishment/loan feature flags — live in that config. The ~1,500 lines of matching, transaction-id encoding, and idempotency logic stay single-sourced. The two groups run as separate nightly launchd jobs so execution is isolated even though code is shared.

**Tech Stack:** TypeScript run via `npx tsx`, vitest for unit tests, Google Sheets via a service account (`src/sheets/google-sheets.ts`), Gmail via `src/mail/google-mailer.ts`, launchd for scheduling.

## Global Constraints

- **CORP behavior must not change** — same filenames (`branch-deposits-<date>.csv`, `disbursements-<date>.csv`), same recipients (To `Miranda.hmx.corp@hairmx.net`, CC `info@hairmx.com`), same spreadsheets, same schedule, same email subject shape `HMX Disbursements <date> — N deposits, $X`.
- **HMX GROUP has garnishments and loans disabled.** Its payout equals the YOT bank-to-bank amount; it must never read or write the garnishments spreadsheet.
- **HMX GROUP recipients:** To `Miranda.hmx.corp@hairmx.net`, CC `rjdjohnston@gmail.com`. Recipient lists are arrays so addresses can be added later with a one-line edit.
- **HMX GROUP file prefix is `hmxgroup-`**, e.g. `hmxgroup-branch-deposits-2026-07-20.csv`.
- **Cross-roster collisions are excluded and reported, never aborted.** A stylist whose staff id or normalized location appears on both rosters is dropped from the CSV in both groups' runs and surfaced in diagnostics + the watchdog email. Never abort a run over a collision — that would stop payroll for everyone else.
- **The `CSV MASTER` → `CORP CSV MASTER` constant change must land and be dry-run verified before RJ deletes the stale `CSV MASTER` tab.** The old tab is still what production reads today.
- **Unrostered YOT locations stay silently skipped** (Clearwater, Jacksonville, Mandarin, Palm Harbor, Grand Blanc, Rochester, Washington PA).
- Tests live beside their source in `__tests__/` directories and run with `npx vitest run`.

## Known IDs and values

| Thing | Value |
|---|---|
| Branch Daily Totals spreadsheet (holds both roster tabs) | `1jIFWOMmvMVbGULUbDpEqV2e6CsXy_DzhBrCorV9H-EA` |
| Branch DISPURSEMENTS spreadsheet (CORP CSV mirror) | `1Z9Ey0oaKAH1J4gy0JlL-m3HjLvy4PKbBYFno3dYjbH8` |
| **HMX GROUP Branch Daily Totals (new)** | `1LsYEOuwjxmiCrbuTmAgD5-PTXxNL2gjCmKWaHhqxToc` |
| Garnishments spreadsheet (CORP only) | `1pvwN3h0X9ZsdhpH024zue9DlE4NaZiuzTia5NMoEn6c` |
| Service account (already shared on all of the above) | `hmx-scripts@hairmx-openclaw.iam.gserviceaccount.com` |
| HMX GROUP locations | Middleburg Fl, Treaty Oaks St. Aug. FL., World of Golf Fl., Yulee Rt. 200 FL |

## File Structure

**Create:**
- `src/disbursements/normalize.ts` — `normalizeText`, `normalizeLocation` (moved out of the export script so the collision guard uses identical normalization).
- `src/disbursements/__tests__/normalize.test.ts`
- `src/disbursements/group-config.ts` — `DisbursementGroupConfig` type, `GROUP_CONFIGS`, `resolveGroupConfig`, `otherGroupConfigs`.
- `src/disbursements/__tests__/group-config.test.ts`
- `src/disbursements/roster-collisions.ts` — `findRosterCollisions`.
- `src/disbursements/__tests__/roster-collisions.test.ts`
- `scripts/setup-hmx-group-sheet.ts` — one-off idempotent builder for the new spreadsheet's two template tabs.

**Modify:**
- `scripts/export-branch-deposits.ts` — group config wiring, feature flags, collision exclusion, diagnostics fields.
- `scripts/branch-deposit-watchdog.ts` — `--group` flag, per-group paths/roster/subject.
- `scripts/combine-weekend-deposits.ts` — `--group` flag, per-group paths/recipients.

**Create (outside the repo):**
- `~/Library/LaunchAgents/com.hairmx.branch-deposit-export-hmxgroup.plist`
- `~/Library/LaunchAgents/com.hairmx.branch-deposit-watchdog-hmxgroup.plist`
- `~/Library/LaunchAgents/com.hairmx.weekend-deposit-combine-hmxgroup.plist`

---

## Task 1: Build the HMX GROUP spreadsheet templates

**Files:**
- Create: `scripts/setup-hmx-group-sheet.ts`

**Interfaces:**
- Produces: two tabs on spreadsheet `1LsYEOuwjxmiCrbuTmAgD5-PTXxNL2gjCmKWaHhqxToc` — `BRANCH MASTER` (4 locations, rows 4–7, TOTAL row 10) and `CSV BLANK MASTER` (header only). Task 3's config depends on these tab names and row numbers.

The spreadsheet already exists and is shared with the service account. It currently contains one empty default tab named `Sheet6`.

- [ ] **Step 1: Write the setup script**

Create `scripts/setup-hmx-group-sheet.ts`:

```ts
// One-off, idempotent builder for the HMX GROUP Branch Daily Totals
// spreadsheet. Creates the two template tabs the nightly export needs:
//   BRANCH MASTER    — per-day tab template: two side-by-side tables
//                      (BRANCH at A-C, YOT at E-G) keyed by location.
//                      HMX GROUP has 4 locations, so they occupy rows 4-7
//                      and the TOTAL row is 10 (CORP uses 4-18 / 21).
//   CSV BLANK MASTER — header-only tab supplying the CSV mirror column
//                      layout, matching CORP's Branch upload format.
// Safe to re-run: existing tabs are left alone, values are rewritten.
import { addTab, deleteTab, listTabs, updateValues } from '../src/sheets/google-sheets';

const SHEET_ID = '1LsYEOuwjxmiCrbuTmAgD5-PTXxNL2gjCmKWaHhqxToc';
const BRANCH_MASTER_TAB = 'BRANCH MASTER';
const CSV_BLANK_TAB = 'CSV BLANK MASTER';
const LOCATIONS = [
  'Middleburg Fl',
  'Treaty Oaks St. Aug. FL.',
  'World of Golf Fl.',
  'Yulee Rt. 200 FL',
];
const FIRST_ROW = 4;
const TOTAL_ROW = 10;

async function ensureTab(title: string): Promise<void> {
  const tabs = await listTabs(SHEET_ID);
  if (tabs.some((t) => t.title === title)) {
    console.log(`tab '${title}' already exists`);
    return;
  }
  await addTab(SHEET_ID, title);
  console.log(`created tab '${title}'`);
}

async function main(): Promise<void> {
  await ensureTab(BRANCH_MASTER_TAB);
  await ensureTab(CSV_BLANK_TAB);

  const lastRow = FIRST_ROW + LOCATIONS.length - 1;
  const grid: (string | number)[][] = [];
  grid.push(['DATE', '', '', '', '', '', '']);
  grid.push(['LOCATION', 'BRANCH', 'NOTES', '', 'LOCATION', 'YOT', 'NOTES']);
  grid.push(['', '', '', '', '', '', '']);
  for (const loc of LOCATIONS) {
    grid.push([loc, '', '', '', loc, '', '']);
  }
  while (grid.length < TOTAL_ROW - 1) grid.push(['', '', '', '', '', '', '']);
  grid.push(['', 'TOTAL', `=sum(B${FIRST_ROW}:B${lastRow})`, '', '', 'TOTAL', `=SUM(F${FIRST_ROW}:F${lastRow})`]);
  await updateValues(SHEET_ID, `'${BRANCH_MASTER_TAB}'!A1:G${TOTAL_ROW}`, grid);
  console.log(`wrote ${BRANCH_MASTER_TAB}: ${LOCATIONS.length} locations rows ${FIRST_ROW}-${lastRow}, TOTAL row ${TOTAL_ROW}`);

  await updateValues(SHEET_ID, `'${CSV_BLANK_TAB}'!A1:H1`, [[
    'ID', 'First Name', 'Last Name', 'Type', 'Amount', 'Transaction ID', 'Location', 'Disbursement Date (YYYY-MM-DD)',
  ]]);
  console.log(`wrote ${CSV_BLANK_TAB} header`);

  // Drop the default empty tab Google created with the spreadsheet, but only
  // once both real tabs exist (a spreadsheet must always keep >= 1 tab).
  const after = await listTabs(SHEET_ID);
  const stray = after.find((t) => /^Sheet\d+$/.test(t.title));
  if (stray && after.length > 2) {
    await deleteTab(SHEET_ID, stray.sheetId);
    console.log(`deleted default tab '${stray.title}'`);
  }

  for (const t of await listTabs(SHEET_ID)) console.log('final tab:', JSON.stringify(t.title));
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it**

Run: `cd ~/kitchen-plugin-yot && npx tsx scripts/setup-hmx-group-sheet.ts`

Expected output includes `created tab 'BRANCH MASTER'`, `created tab 'CSV BLANK MASTER'`, `wrote BRANCH MASTER: 4 locations rows 4-7, TOTAL row 10`, `deleted default tab 'Sheet6'`, and two `final tab:` lines.

- [ ] **Step 3: Verify the result reads back correctly**

Run:

```bash
cd ~/kitchen-plugin-yot && npx tsx -e "
import { getValues } from './src/sheets/google-sheets';
getValues('1LsYEOuwjxmiCrbuTmAgD5-PTXxNL2gjCmKWaHhqxToc', \"'BRANCH MASTER'!A1:G10\", 'FORMULA')
  .then(v => v.forEach((r,i) => console.log(i+1, JSON.stringify(r))));
"
```

Expected: row 2 is the header pair, rows 4–7 carry the four FL locations in columns A and E, and row 10 has `TOTAL` with `=sum(B4:B7)` and `=SUM(F4:F7)`.

- [ ] **Step 4: Commit**

```bash
git add scripts/setup-hmx-group-sheet.ts
git commit -m "feat(disbursements): setup script for HMX GROUP sheet templates"
```

---

## Task 2: Extract shared normalization

**Files:**
- Create: `src/disbursements/normalize.ts`
- Test: `src/disbursements/__tests__/normalize.test.ts`
- Modify: `scripts/export-branch-deposits.ts` (remove the two local functions, import them instead)

**Interfaces:**
- Produces: `normalizeText(value: string | null | undefined): string` and `normalizeLocation(value: string | null | undefined): string`. Task 4's collision guard and Task 5's export both import these — they must be the same implementation or the guard's location comparison would disagree with the export's.

This is a pure refactor: identical behavior, moved so two callers share one copy.

- [ ] **Step 1: Write the failing test**

Create `src/disbursements/__tests__/normalize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeLocation, normalizeText } from '../normalize';

describe('normalizeText', () => {
  it('strips punctuation, collapses whitespace, lowercases', () => {
    expect(normalizeText("  O'Brien-Smith,  Jr. ")).toBe('obrien-smith jr');
  });

  it('returns empty string for null/undefined', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
  });
});

describe('normalizeLocation', () => {
  it('drops state suffixes so YOT and roster spellings agree', () => {
    expect(normalizeLocation('World of Golf FL.')).toBe('world of golf');
    expect(normalizeLocation('World of Golf Fl.')).toBe('world of golf');
    expect(normalizeLocation('Yulee Rt. 200 FL.')).toBe('yulee rt 200');
    expect(normalizeLocation('Yulee Rt. 200 FL')).toBe('yulee rt 200');
  });

  it('treats trailing-space and state-suffix variants of a shop as one', () => {
    expect(normalizeLocation('Waterford ')).toBe(normalizeLocation('Waterford'));
    expect(normalizeLocation('Morgantown WV')).toBe(normalizeLocation('Morgantown'));
  });

  it('makes same-named shops in different states collide (guarded in Task 4)', () => {
    expect(normalizeLocation('Monroe')).toBe(normalizeLocation('Monroe FL'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/kitchen-plugin-yot && npx vitest run src/disbursements/__tests__/normalize.test.ts`
Expected: FAIL — cannot resolve `../normalize`.

- [ ] **Step 3: Create the module**

Create `src/disbursements/normalize.ts`, copying the two functions verbatim from `scripts/export-branch-deposits.ts` (currently lines 286–303):

```ts
// Shared text/location normalization for the disbursement pipeline.
// Extracted from export-branch-deposits.ts so the cross-roster collision
// guard compares locations exactly the way the export matches them — two
// copies that drift would let a colliding stylist through.

export function normalizeText(value: string | null | undefined): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[’']/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Drops state suffixes and township/stylist noise so "World of Golf FL." and
// "World of Golf Fl." are one shop. Note this also makes same-named shops in
// different states identical — see findRosterCollisions.
export function normalizeLocation(value: string | null | undefined): string {
  return normalizeText(value)
    .replace(/\bmi\b|\boh\b|\bpa\b|\bwv\b|\bfl\b/g, '')
    .replace(/\btownship\b|\btwp\b/g, '')
    .replace(/\bstylist\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/disbursements/__tests__/normalize.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Point the export script at the shared module**

In `scripts/export-branch-deposits.ts`, delete the local `normalizeText` and `normalizeLocation` function bodies (lines 286–303) and add to the existing import block near the top (beside `import * as sheetsApi from '../src/sheets/google-sheets';`):

```ts
import { normalizeLocation, normalizeText } from '../src/disbursements/normalize';
```

- [ ] **Step 6: Verify nothing else broke**

Run: `cd ~/kitchen-plugin-yot && npm run typecheck && npx vitest run`
Expected: typecheck clean; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/disbursements/normalize.ts src/disbursements/__tests__/normalize.test.ts scripts/export-branch-deposits.ts
git commit -m "refactor(disbursements): extract shared normalizeText/normalizeLocation"
```

---

## Task 3: Group configuration registry

**Files:**
- Create: `src/disbursements/group-config.ts`
- Test: `src/disbursements/__tests__/group-config.test.ts`

**Interfaces:**
- Produces: `DisbursementGroupId`, `DisbursementGroupConfig`, `GROUP_CONFIGS`, `resolveGroupConfig(id?: string): DisbursementGroupConfig`, `otherGroupConfigs(id: DisbursementGroupId): DisbursementGroupConfig[]`. Tasks 5, 6, 7 all consume these.

- [ ] **Step 1: Write the failing test**

Create `src/disbursements/__tests__/group-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GROUP_CONFIGS, otherGroupConfigs, resolveGroupConfig } from '../group-config';

describe('resolveGroupConfig', () => {
  it('defaults to corp when no id is given', () => {
    expect(resolveGroupConfig().id).toBe('corp');
    expect(resolveGroupConfig('').id).toBe('corp');
  });

  it('resolves hmx-group', () => {
    expect(resolveGroupConfig('hmx-group').id).toBe('hmx-group');
  });

  it('rejects an unknown group id', () => {
    expect(() => resolveGroupConfig('nope')).toThrow(/Unknown --group/);
  });
});

describe('corp config preserves existing production behavior', () => {
  const corp = GROUP_CONFIGS.corp;

  it('keeps historical filenames (no prefix)', () => {
    expect(corp.filePrefix).toBe('');
  });

  it('reads the renamed roster tab', () => {
    expect(corp.rosterTab).toBe('CORP CSV MASTER');
  });

  it('keeps its recipients and subject prefix', () => {
    expect(corp.emailTo).toBe('Miranda.hmx.corp@hairmx.net');
    expect(corp.emailCc).toEqual(['info@hairmx.com']);
    expect(corp.emailSubjectPrefix).toBe('HMX');
  });

  it('keeps garnishments and loans enabled', () => {
    expect(corp.garnishmentsEnabled).toBe(true);
    expect(corp.loansEnabled).toBe(true);
  });

  it('keeps its BRANCH MASTER geometry', () => {
    expect([corp.branchMasterFirstLocationRow, corp.branchMasterLastLocationRow, corp.branchMasterTotalRow]).toEqual([4, 18, 21]);
  });
});

describe('hmx-group config', () => {
  const grp = GROUP_CONFIGS['hmx-group'];

  it('prefixes its output files', () => {
    expect(grp.filePrefix).toBe('hmxgroup-');
  });

  it('uses its own roster tab and its own spreadsheet for per-day tabs', () => {
    expect(grp.rosterTab).toBe('HAIR MX GROUP CSV MASTER');
    expect(grp.rosterSheetId).toBe(GROUP_CONFIGS.corp.rosterSheetId);
    expect(grp.dailyTotalsSheetId).toBe('1LsYEOuwjxmiCrbuTmAgD5-PTXxNL2gjCmKWaHhqxToc');
    expect(grp.dispursementsSheetId).toBe(grp.dailyTotalsSheetId);
  });

  it('disables garnishments and loans', () => {
    expect(grp.garnishmentsEnabled).toBe(false);
    expect(grp.loansEnabled).toBe(false);
  });

  it('emails Miranda with RJ copied', () => {
    expect(grp.emailTo).toBe('Miranda.hmx.corp@hairmx.net');
    expect(grp.emailCc).toEqual(['rjdjohnston@gmail.com']);
    expect(grp.emailSubjectPrefix).toBe('HMX GROUP');
  });

  it('uses 4-location BRANCH MASTER geometry', () => {
    expect([grp.branchMasterFirstLocationRow, grp.branchMasterLastLocationRow, grp.branchMasterTotalRow]).toEqual([4, 7, 10]);
  });
});

describe('otherGroupConfigs', () => {
  it('returns every group except the named one', () => {
    expect(otherGroupConfigs('corp').map((g) => g.id)).toEqual(['hmx-group']);
    expect(otherGroupConfigs('hmx-group').map((g) => g.id)).toEqual(['corp']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/disbursements/__tests__/group-config.test.ts`
Expected: FAIL — cannot resolve `../group-config`.

- [ ] **Step 3: Create the module**

Create `src/disbursements/group-config.ts`:

```ts
// Per-group configuration for the nightly Branch disbursement pipeline.
// Everything that differs between distribution groups lives here; the export,
// watchdog, and weekend-combine scripts stay single-sourced and take a
// --group flag. Adding a third group means adding one entry below.

export type DisbursementGroupId = 'corp' | 'hmx-group';

export type DisbursementGroupConfig = {
  id: DisbursementGroupId;
  /** Human label for logs. */
  label: string;
  /** Spreadsheet holding the roster tab. Both groups' rosters live on the
   *  Branch Daily Totals sheet, which is why this is separate from
   *  dailyTotalsSheetId. */
  rosterSheetId: string;
  /** Roster tab: staff id, first, last, location. Defines this group's
   *  in-scope locations. */
  rosterTab: string;
  /** Spreadsheet receiving the per-day BRANCH MASTER tabs, and holding the
   *  BRANCH MASTER template. */
  dailyTotalsSheetId: string;
  /** Spreadsheet receiving the per-day CSV mirror tabs. */
  dispursementsSheetId: string;
  /** Template tab supplying the CSV mirror header. */
  dispursementsTemplateTab: string;
  /** BRANCH MASTER template geometry, 1-based rows. */
  branchMasterFirstLocationRow: number;
  branchMasterLastLocationRow: number;
  branchMasterTotalRow: number;
  /** Prepended to every output filename. Empty for corp so its historical
   *  names — which the watchdog, weekend combine, and Miranda all rely on —
   *  are unchanged. */
  filePrefix: string;
  /** Email subject prefix: `<prefix> Disbursements <date> — …`. */
  emailSubjectPrefix: string;
  emailTo: string;
  /** Copied on the disbursements email. Add addresses here as the group grows. */
  emailCc: readonly string[];
  /** When false the export never reads or writes the garnishments
   *  spreadsheet and applies no withholding. */
  garnishmentsEnabled: boolean;
  loansEnabled: boolean;
};

const BRANCH_DAILY_TOTALS_SHEET_ID = '1jIFWOMmvMVbGULUbDpEqV2e6CsXy_DzhBrCorV9H-EA';
const CORP_DISPURSEMENTS_SHEET_ID = '1Z9Ey0oaKAH1J4gy0JlL-m3HjLvy4PKbBYFno3dYjbH8';
const HMX_GROUP_SHEET_ID = '1LsYEOuwjxmiCrbuTmAgD5-PTXxNL2gjCmKWaHhqxToc';

export const GROUP_CONFIGS: Record<DisbursementGroupId, DisbursementGroupConfig> = {
  corp: {
    id: 'corp',
    label: 'CORP',
    rosterSheetId: BRANCH_DAILY_TOTALS_SHEET_ID,
    rosterTab: 'CORP CSV MASTER',
    dailyTotalsSheetId: BRANCH_DAILY_TOTALS_SHEET_ID,
    dispursementsSheetId: CORP_DISPURSEMENTS_SHEET_ID,
    // Trailing space is intentional — that is the tab's real name.
    dispursementsTemplateTab: 'CSV BLANK MASTER ',
    branchMasterFirstLocationRow: 4,
    branchMasterLastLocationRow: 18,
    branchMasterTotalRow: 21,
    filePrefix: '',
    emailSubjectPrefix: 'HMX',
    emailTo: 'Miranda.hmx.corp@hairmx.net',
    emailCc: ['info@hairmx.com'],
    garnishmentsEnabled: true,
    loansEnabled: true,
  },
  'hmx-group': {
    id: 'hmx-group',
    label: 'HMX GROUP',
    rosterSheetId: BRANCH_DAILY_TOTALS_SHEET_ID,
    rosterTab: 'HAIR MX GROUP CSV MASTER',
    dailyTotalsSheetId: HMX_GROUP_SHEET_ID,
    dispursementsSheetId: HMX_GROUP_SHEET_ID,
    dispursementsTemplateTab: 'CSV BLANK MASTER',
    branchMasterFirstLocationRow: 4,
    branchMasterLastLocationRow: 7,
    branchMasterTotalRow: 10,
    filePrefix: 'hmxgroup-',
    emailSubjectPrefix: 'HMX GROUP',
    emailTo: 'Miranda.hmx.corp@hairmx.net',
    emailCc: ['rjdjohnston@gmail.com'],
    garnishmentsEnabled: false,
    loansEnabled: false,
  },
};

export function resolveGroupConfig(id?: string | null): DisbursementGroupConfig {
  const key = (id || 'corp') as DisbursementGroupId;
  const cfg = GROUP_CONFIGS[key];
  if (!cfg) {
    throw new Error(`Unknown --group value: ${id} (expected one of ${Object.keys(GROUP_CONFIGS).join(', ')})`);
  }
  return cfg;
}

export function otherGroupConfigs(id: DisbursementGroupId): DisbursementGroupConfig[] {
  return (Object.keys(GROUP_CONFIGS) as DisbursementGroupId[])
    .filter((k) => k !== id)
    .map((k) => GROUP_CONFIGS[k]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/disbursements/__tests__/group-config.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/disbursements/group-config.ts src/disbursements/__tests__/group-config.test.ts
git commit -m "feat(disbursements): per-group configuration registry"
```

---

## Task 4: Cross-roster collision guard

**Files:**
- Create: `src/disbursements/roster-collisions.ts`
- Test: `src/disbursements/__tests__/roster-collisions.test.ts`

**Interfaces:**
- Consumes: `normalizeLocation` from Task 2.
- Produces: `type RosterEntry = { staffId: string; firstName: string; lastName: string; location: string }`, `type RosterCollision = { kind: 'staff-id' | 'location'; value: string; detail: string }`, and `findRosterCollisions(own: RosterEntry[], other: RosterEntry[]): RosterCollision[]`. Task 5 uses the returned collisions to exclude rows and populate diagnostics.

- [ ] **Step 1: Write the failing test**

Create `src/disbursements/__tests__/roster-collisions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { findRosterCollisions, type RosterEntry } from '../roster-collisions';

const entry = (over: Partial<RosterEntry> = {}): RosterEntry => ({
  staffId: '1000', firstName: 'Ada', lastName: 'Lovelace', location: 'Auburn Hills', ...over,
});

describe('findRosterCollisions', () => {
  it('returns nothing for disjoint rosters', () => {
    const corp = [entry({ staffId: '1000', location: 'Auburn Hills' })];
    const grp = [entry({ staffId: '5409', location: 'Middleburg Fl' })];
    expect(findRosterCollisions(corp, grp)).toEqual([]);
  });

  it('flags a staff id present on both rosters', () => {
    const corp = [entry({ staffId: '7777', location: 'Troy' })];
    const grp = [entry({ staffId: '7777', location: 'Middleburg Fl' })];
    const out = findRosterCollisions(corp, grp);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('staff-id');
    expect(out[0].value).toBe('7777');
  });

  it('flags a location present on both rosters', () => {
    const corp = [entry({ staffId: '1', location: 'Monroe' })];
    const grp = [entry({ staffId: '2', location: 'Monroe FL' })];
    const out = findRosterCollisions(corp, grp);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('location');
    expect(out[0].value).toBe('monroe');
  });

  it('ignores case, padding and state suffixes when comparing', () => {
    const corp = [entry({ staffId: ' 8955 ', location: 'Waterford ' })];
    const grp = [entry({ staffId: '8955', location: 'Westland' })];
    const kinds = findRosterCollisions(corp, grp).map((c) => c.kind);
    expect(kinds).toEqual(['staff-id']);
  });

  it('reports each colliding value once even with several matching rows', () => {
    const corp = [entry({ staffId: '3', location: 'Troy' }), entry({ staffId: '4', location: 'Troy' })];
    const grp = [entry({ staffId: '5', location: 'Troy' })];
    expect(findRosterCollisions(corp, grp)).toHaveLength(1);
  });

  it('is symmetric — both groups see the same collision', () => {
    const corp = [entry({ staffId: '7777', location: 'Troy' })];
    const grp = [entry({ staffId: '7777', location: 'Middleburg Fl' })];
    expect(findRosterCollisions(corp, grp)).toHaveLength(1);
    expect(findRosterCollisions(grp, corp)).toHaveLength(1);
  });

  it('names both sides in the detail so the alert is actionable', () => {
    const corp = [entry({ staffId: '7777', firstName: 'Marcella', lastName: 'Belles', location: 'Troy' })];
    const grp = [entry({ staffId: '7777', firstName: 'Marcella', lastName: 'Belles', location: 'Middleburg Fl' })];
    expect(findRosterCollisions(corp, grp)[0].detail).toContain('Troy');
    expect(findRosterCollisions(corp, grp)[0].detail).toContain('Middleburg Fl');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/disbursements/__tests__/roster-collisions.test.ts`
Expected: FAIL — cannot resolve `../roster-collisions`.

- [ ] **Step 3: Create the module**

Create `src/disbursements/roster-collisions.ts`:

```ts
// Cross-roster safety check for the multi-group disbursement pipeline.
//
// The groups are partitioned by roster: each nightly run pays only the staff
// on its own roster tab. That is sound only while the rosters stay disjoint —
// a stylist listed on both would be paid twice on the same night, once per
// run. This finds those overlaps so the export can exclude and report them.
//
// Deliberately NOT an abort: failing the run would stop payment for every
// correctly-rostered stylist because of one bad row, and would let one
// group's roster mistake break the other group's payroll. Excluding just the
// ambiguous stylist pays everyone unambiguous, pays nobody twice, and routes
// the ambiguity to a human via diagnostics + the watchdog email.
import { normalizeLocation } from './normalize';

export type RosterEntry = {
  staffId: string;
  firstName: string;
  lastName: string;
  location: string;
};

export type RosterCollision = {
  kind: 'staff-id' | 'location';
  /** The normalized colliding value — staff id, or normalized location. */
  value: string;
  /** Human-readable explanation naming both sides, for the alert email. */
  detail: string;
};

function normalizeStaffId(value: string | null | undefined): string {
  return String(value || '').trim();
}

function describe(e: RosterEntry): string {
  return `${e.firstName} ${e.lastName} @ ${e.location}`.trim();
}

export function findRosterCollisions(own: RosterEntry[], other: RosterEntry[]): RosterCollision[] {
  const collisions: RosterCollision[] = [];

  const otherById = new Map<string, RosterEntry>();
  for (const e of other) {
    const id = normalizeStaffId(e.staffId);
    if (id) otherById.set(id, e);
  }
  const seenIds = new Set<string>();
  for (const e of own) {
    const id = normalizeStaffId(e.staffId);
    if (!id || seenIds.has(id)) continue;
    const hit = otherById.get(id);
    if (!hit) continue;
    seenIds.add(id);
    collisions.push({
      kind: 'staff-id',
      value: id,
      detail: `Staff id ${id} is on both rosters: ${describe(e)} and ${describe(hit)}.`,
    });
  }

  const otherByLocation = new Map<string, RosterEntry>();
  for (const e of other) {
    const loc = normalizeLocation(e.location);
    if (loc) otherByLocation.set(loc, e);
  }
  const seenLocations = new Set<string>();
  for (const e of own) {
    const loc = normalizeLocation(e.location);
    if (!loc || seenLocations.has(loc)) continue;
    const hit = otherByLocation.get(loc);
    if (!hit) continue;
    seenLocations.add(loc);
    collisions.push({
      kind: 'location',
      value: loc,
      detail: `Location "${e.location}" also appears on the other roster as "${hit.location}".`,
    });
  }

  return collisions;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/disbursements/__tests__/roster-collisions.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/disbursements/roster-collisions.ts src/disbursements/__tests__/roster-collisions.test.ts
git commit -m "feat(disbursements): cross-roster collision guard"
```

---

## Task 5: Wire `--group` into the export script

**Files:**
- Modify: `scripts/export-branch-deposits.ts`

**Interfaces:**
- Consumes: `resolveGroupConfig`, `otherGroupConfigs` (Task 3); `findRosterCollisions`, `RosterEntry` (Task 4); `normalizeLocation` (Task 2).
- Produces: `--group=<id>` CLI flag; diagnostics JSON gains `groupId: string` and `crossGroupCollisions: RosterCollision[]`, and its existing `sourceLabel` becomes the group's roster tab. Task 6's watchdog reads these.

This task carries the `CSV MASTER` → `CORP CSV MASTER` change, via the group config.

- [ ] **Step 1: Add the imports**

Near the existing `import * as sheetsApi …` line in `scripts/export-branch-deposits.ts`:

```ts
import { otherGroupConfigs, resolveGroupConfig, type DisbursementGroupConfig } from '../src/disbursements/group-config';
import { findRosterCollisions, type RosterCollision, type RosterEntry } from '../src/disbursements/roster-collisions';
```

- [ ] **Step 2: Add `group` to `Args` and `parseArgs`**

In the `Args` type (starts line 35) add:

```ts
  /** Which distribution group this run serves. Selects roster tab,
   *  spreadsheets, recipients, filenames, and garnishment/loan flags. */
  group: DisbursementGroupConfig;
```

In `parseArgs` (line 238), inside the returned object, add:

```ts
    group: resolveGroupConfig(map.get('group')),
```

Delete the now-unused `CSV_MASTER_TAB`, `BRANCH_MASTER_FIRST_LOCATION_ROW`, `BRANCH_MASTER_LAST_LOCATION_ROW`, `BRANCH_MASTER_TOTAL_ROW`, `DISPURSEMENTS_SHEET_ID`, `DISPURSEMENTS_TEMPLATE_TAB`, `DEFAULT_DISPURSEMENTS_RECIPIENT`, and `ADDITIONAL_DISPURSEMENTS_RECIPIENTS` constants (lines 211–231), replacing every reference with the corresponding `args.group.*` field. Keep `DEFAULT_SHEET_ID` and `DEFAULT_GARNISHMENTS_SHEET_ID` — they remain the `--sheetId` / `--garnishmentsSheetId` overrides' defaults.

- [ ] **Step 3: Read the roster and BRANCH MASTER template from the group config**

Replace the roster load (line 967) so it reads the group's tab from the group's roster spreadsheet, and make `loadCsvMasterRows` take the tab name:

```ts
  const masterRows = await loadCsvMasterRows(args.group.rosterSheetId, args.group.rosterTab, args.account);
```

Change `loadCsvMasterRows`'s signature (line 544) to `(sheetId: string, tabName: string, _account: string)` and its range to:

```ts
  const values = await sheetsApi.getValues(sheetId, `'${tabName}'!A1:G500`);
```

Change `loadBranchMasterTemplate` (line 791) to take the config's geometry, replacing the deleted constants:

```ts
async function loadBranchMasterTemplate(sheetId: string, cfg: DisbursementGroupConfig, _account: string): Promise<BranchMasterTemplate> {
  const values = await sheetsApi.getValues(sheetId, `'${BRANCH_MASTER_TAB}'!A1:G${cfg.branchMasterTotalRow}`);
```

and update its internal row loop to use `cfg.branchMasterFirstLocationRow` / `cfg.branchMasterLastLocationRow` / `cfg.branchMasterTotalRow` wherever the deleted constants appeared. Update its call site (line 1235) to `await loadBranchMasterTemplate(args.group.dailyTotalsSheetId, args.group, args.account);`.

- [ ] **Step 4: Gate garnishments and loans behind the feature flags**

Replace the two loader calls (lines 968–969):

```ts
  const garnishmentRules = args.group.garnishmentsEnabled
    ? await loadGarnishmentRules(args.garnishmentsSheetId, args.account)
    : new Map<string, GarnishmentRule>();
  const activeLoans = args.group.loansEnabled
    ? await loadActiveLoans(args.garnishmentsSheetId, args.account)
    : [];
  const existingLoanPayments = args.group.loansEnabled
    ? await loadExistingLoanPayments(args.garnishmentsSheetId, args.account)
    : [];
```

(The existing `loadExistingLoanPayments` call on line 970 is replaced by the third statement above; delete the original.)

Wrap the write-back block (lines 1218–1221) so a flags-off group never writes to the garnishments spreadsheet:

```ts
    if (args.group.garnishmentsEnabled) {
      await rewriteGarnishmentPayoutSheet(args.garnishmentsSheetId, args.account, rewrittenGarnishmentPayoutRows);
    }
    if (args.group.loansEnabled) {
      await rewriteLoanPaymentsSheet(args.garnishmentsSheetId, args.account, rewrittenLoanPayments);
      for (const [rowNumber, vals] of loanCellUpdates) {
        await updateLoanCellsForRow(args.garnishmentsSheetId, args.account, rowNumber, vals.totalPaid, vals.remainingBalance);
      }
    }
```

Preserve the existing loop variable names used at line 1221 when moving that loop inside the `if`.

- [ ] **Step 5: Exclude cross-roster collisions**

Immediately after `supportedLocations` is built (after line 981), add:

```ts
  // Cross-roster safety: a stylist on two groups' rosters would be paid by
  // both nightly runs. Exclude them here and surface them in diagnostics +
  // the watchdog email so a human resolves the ambiguity. Never abort — that
  // would stop payroll for everyone correctly rostered.
  const ownRoster: RosterEntry[] = masterRows.map((r) => ({
    staffId: r.staffId, firstName: r.firstName, lastName: r.lastName, location: r.location,
  }));
  const crossGroupCollisions: RosterCollision[] = [];
  for (const other of otherGroupConfigs(args.group.id)) {
    const otherRows = await loadCsvMasterRows(other.rosterSheetId, other.rosterTab, args.account);
    crossGroupCollisions.push(...findRosterCollisions(ownRoster, otherRows.map((r) => ({
      staffId: r.staffId, firstName: r.firstName, lastName: r.lastName, location: r.location,
    }))));
  }
  const collidingStaffIds = new Set(crossGroupCollisions.filter((c) => c.kind === 'staff-id').map((c) => c.value));
  const collidingLocations = new Set(crossGroupCollisions.filter((c) => c.kind === 'location').map((c) => c.value));
  for (const c of crossGroupCollisions) console.error(`[collision] ${c.detail}`);
```

Then, at the point where a matched YOT row becomes an export row, skip colliding staff. Immediately before the `exportRows.push(...)` call inside the main match loop, add:

```ts
    if (collidingStaffIds.has(String(master.staffId).trim()) || collidingLocations.has(normalizeLocation(master.location))) {
      continue;
    }
```

(Use the local variable already holding the matched master row at that point; it is named `master` in the match block. If it is named differently, use that name.)

- [ ] **Step 6: Route filenames, sheets, recipients, and subject through the config**

Replace the three output paths (lines 1396–1398):

```ts
  const csvPath = path.join(args.outputDir, `${args.group.filePrefix}branch-deposits-${args.date}.csv`);
  const diagnosticsPath = path.join(args.outputDir, `${args.group.filePrefix}branch-deposits-${args.date}.diagnostics.json`);
  const disbursementsPath = path.join(args.outputDir, `${args.group.filePrefix}disbursements-${args.date}.csv`);
```

Change `writeDispursementsDailyTab` (line 913) to accept `spreadsheetId` and `templateTab` parameters instead of reading the deleted module constants, and update its call site (line 1420) to pass `args.group.dispursementsSheetId` and `args.group.dispursementsTemplateTab`. Update the dry-run log on line 1417 to reference `args.group.dispursementsSheetId`.

Replace the subject (line 1468):

```ts
  const subject = `${args.group.emailSubjectPrefix} Disbursements ${args.date} — ${depositRows.length} deposits, $${totalAmount.toFixed(2)}`;
```

Replace the sourcing sentence in the email body (line 1478) so it names the group's roster tab:

```ts
Sourced from ${args.group.rosterTab} on the Branch Daily Totals sheet${args.group.garnishmentsEnabled || args.group.loansEnabled ? ', with garnishment + loan deductions already applied' : ''}. Auto-generated by the nightly Branch deposit export.${watchdogEmailSection}`;
```

Find where `recipient` and `sendTo` are computed (just above line 1468) and change them to use the config, keeping the existing `--test-recipient` override behavior intact:

```ts
  const recipient = args.testRecipient || args.group.emailTo;
  const sendTo: string | string[] = args.testRecipient ? recipient : [recipient, ...args.group.emailCc];
```

- [ ] **Step 7: Add the new diagnostics fields**

In the `MatchDiagnostics` type (line 158) add:

```ts
  groupId: string;
  crossGroupCollisions: RosterCollision[];
```

In the diagnostics `writeFileSync` object (line 1499) add, and change `sourceLabel`:

```ts
    groupId: args.group.id,
    crossGroupCollisions,
```

```ts
    sourceLabel: args.group.rosterTab,
```

- [ ] **Step 8: Typecheck and run the full suite**

Run: `cd ~/kitchen-plugin-yot && npm run typecheck && npx vitest run`
Expected: typecheck clean, all tests pass.

- [ ] **Step 9: Dry-run both groups against a recent date**

Run:

```bash
cd ~/kitchen-plugin-yot
export GOG_KEYRING_PASSWORD="$(cat ~/.openclaw/secrets/gog_keyring_password)"
npx tsx scripts/export-branch-deposits.ts --date=2026-07-18 --dry-run --skip-email --outputDir=/tmp/hmx-dryrun
npx tsx scripts/export-branch-deposits.ts --date=2026-07-18 --dry-run --skip-email --group=hmx-group --outputDir=/tmp/hmx-dryrun
ls -la /tmp/hmx-dryrun/
```

Expected: four files — `branch-deposits-2026-07-18.csv` + diagnostics, and `hmxgroup-branch-deposits-2026-07-18.csv` + diagnostics. No `[collision]` lines. **`--outputDir=/tmp/hmx-dryrun` is required** so the dry run cannot overwrite the real files in `~/hmx-reports` that the watchdog inspects.

- [ ] **Step 10: Verify the CORP dry-run output is unchanged**

Run:

```bash
cd ~/kitchen-plugin-yot
diff <(tail -n +1 /tmp/hmx-dryrun/branch-deposits-2026-07-18.csv) <(tail -n +1 ~/hmx-reports/branch-deposits-2026-07-18.csv) && echo "CORP CSV IDENTICAL"
```

Expected: `CORP CSV IDENTICAL`. This is the proof that the refactor plus the `CORP CSV MASTER` rename did not change CORP's output. If it differs, stop and investigate before continuing.

- [ ] **Step 11: Verify the HMX GROUP output matches its roster**

Run:

```bash
cd ~/kitchen-plugin-yot
cat /tmp/hmx-dryrun/hmxgroup-branch-deposits-2026-07-18.csv
npx tsx -e "
const d = require('/tmp/hmx-dryrun/hmxgroup-branch-deposits-2026-07-18.diagnostics.json');
console.log('group:', d.groupId, 'rows:', d.exportRowCount, 'collisions:', d.crossGroupCollisions.length);
console.log('garnishments:', d.garnishmentRuleCount, 'loans:', d.loanRuleCount);
"
```

Expected: every CSV row's location is one of the four FL locations; `group: hmx-group`; `collisions: 0`; `garnishments: 0`; `loans: 0`.

- [ ] **Step 12: Commit**

```bash
git add scripts/export-branch-deposits.ts
git commit -m "feat(disbursements): --group flag, feature flags, collision guard in export"
```

---

## Task 6: Wire `--group` into the watchdog

**Files:**
- Modify: `scripts/branch-deposit-watchdog.ts`

**Interfaces:**
- Consumes: `resolveGroupConfig` (Task 3); the `groupId` and `crossGroupCollisions` diagnostics fields (Task 5).

- [ ] **Step 1: Add the import and flag**

Add near the top of `scripts/branch-deposit-watchdog.ts`:

```ts
import { resolveGroupConfig, type DisbursementGroupConfig } from '../src/disbursements/group-config';
```

In its `parseArgs`, add `group: resolveGroupConfig(map.get('group'))` to the returned object and add the matching field to its args type.

- [ ] **Step 2: Make the file paths group-aware**

Replace lines 130–131:

```ts
  const csvPath = path.join(EXPORT_DIR, `${args.group.filePrefix}branch-deposits-${args.targetDate}.csv`);
  const diagPath = path.join(EXPORT_DIR, `${args.group.filePrefix}branch-deposits-${args.targetDate}.diagnostics.json`);
```

- [ ] **Step 3: Make the roster references and subject group-aware**

Replace the hard-coded `CSV MASTER` strings in the two alert-line builders (lines 205 and 211) with `${args.group.rosterTab}`, and add the group label to the subject (line 226):

```ts
  const subject = `[HMX] ${args.group.label} branch deposit watchdog ${args.targetDate} — ${summaryBits.join('; ')}`;
```

- [ ] **Step 4: Report cross-roster collisions**

After the existing `sections` are assembled and before `subject` is built, add:

```ts
  const collisions = (diag as any).crossGroupCollisions || [];
  if (collisions.length) {
    const lines = collisions.map((c: { detail: string }) => `- ${c.detail}`);
    sections.push(`Cross-roster collisions — these stylists were EXCLUDED from tonight's CSV to avoid double payment. Resolve by removing them from the wrong roster tab, then pay today manually if owed:\n${lines.join('\n')}`);
    summaryBits.push(`${collisions.length} roster collision${collisions.length === 1 ? '' : 's'}`);
  }
```

- [ ] **Step 5: Make the auto-append target the right roster tab**

Find where the watchdog appends a placeholder row for genuinely-missing staff and change its target tab from the hard-coded `CSV MASTER` to `args.group.rosterTab`, and its spreadsheet to `args.group.rosterSheetId`.

- [ ] **Step 6: Typecheck**

Run: `cd ~/kitchen-plugin-yot && npm run typecheck`
Expected: clean.

- [ ] **Step 7: Dry-run the watchdog for both groups**

Run:

```bash
cd ~/kitchen-plugin-yot
export GOG_KEYRING_PASSWORD="$(cat ~/.openclaw/secrets/gog_keyring_password)"
npx tsx scripts/branch-deposit-watchdog.ts --target-date=2026-07-18 --dry-run
npx tsx scripts/branch-deposit-watchdog.ts --target-date=2026-07-18 --dry-run --group=hmx-group
```

Expected: the CORP run reports on the real `~/hmx-reports` files as it does today. The GROUP run reports that `hmxgroup-branch-deposits-2026-07-18.*` is missing from `~/hmx-reports` — correct, since Task 5's dry run wrote to `/tmp/hmx-dryrun`. No email is sent in `--dry-run`.

- [ ] **Step 8: Commit**

```bash
git add scripts/branch-deposit-watchdog.ts
git commit -m "feat(disbursements): --group flag for the watchdog"
```

---

## Task 7: Wire `--group` into the weekend combine

**Files:**
- Modify: `scripts/combine-weekend-deposits.ts`

**Interfaces:**
- Consumes: `resolveGroupConfig` (Task 3).

- [ ] **Step 1: Add the import and flag**

Add:

```ts
import { resolveGroupConfig, type DisbursementGroupConfig } from '../src/disbursements/group-config';
```

Add `group: resolveGroupConfig(map.get('group'))` to `parseArgs`'s returned object (near line 67) and the matching field to its args type.

- [ ] **Step 2: Make paths group-aware**

Replace lines 169–171:

```ts
  const satPath = path.join(args.outputDir, `${args.group.filePrefix}disbursements-${saturday}.csv`);
  const sunPath = path.join(args.outputDir, `${args.group.filePrefix}disbursements-${sunday}.csv`);
  const combinedPath = path.join(args.outputDir, `${args.group.filePrefix}disbursements-weekend-${saturday}-to-${sunday}.csv`);
```

- [ ] **Step 3: Make recipients and subject group-aware**

Replace the recipient computation (lines 251–254):

```ts
  const recipient = args.testRecipient || args.group.emailTo;
  const sendTo: string | string[] = args.testRecipient ? recipient : [recipient, ...args.group.emailCc];
```

Delete the now-unused `DEFAULT_RECIPIENT` and `ADDITIONAL_RECIPIENTS` constants (lines 37 and 41). Prefix the email subject with `args.group.emailSubjectPrefix` in the same shape the export uses.

- [ ] **Step 4: Typecheck and run the full suite**

Run: `cd ~/kitchen-plugin-yot && npm run typecheck && npx vitest run`
Expected: clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/combine-weekend-deposits.ts
git commit -m "feat(disbursements): --group flag for the weekend combine"
```

---

## Task 8: Schedule the HMX GROUP jobs and open the PR

**Files:**
- Create: `~/Library/LaunchAgents/com.hairmx.branch-deposit-export-hmxgroup.plist`
- Create: `~/Library/LaunchAgents/com.hairmx.branch-deposit-watchdog-hmxgroup.plist`
- Create: `~/Library/LaunchAgents/com.hairmx.weekend-deposit-combine-hmxgroup.plist`

The GROUP jobs run 10 minutes after CORP's, each with its own `shlock` lock file so neither group can block the other. Per the rollout, the export plist initially carries `--test-recipient=rjdjohnston@gmail.com` so the first live nights go only to RJ.

- [ ] **Step 1: Create the export plist**

Write `~/Library/LaunchAgents/com.hairmx.branch-deposit-export-hmxgroup.plist` mirroring `com.hairmx.branch-deposit-export.plist` with these differences: `Label` is `com.hairmx.branch-deposit-export-hmxgroup`; the command is

```
/usr/bin/shlock -p $$ -f /tmp/branch-deposit-export-hmxgroup.lock && $HOME/.openclaw/scripts/branch-deposit-export.sh --group=hmx-group --test-recipient=rjdjohnston@gmail.com
```

log paths are `…/com.hairmx.branch-deposit-export-hmxgroup.log` and `.err.log`; and `StartCalendarInterval` is Weekdays 1–6 at 21:10 plus Weekday 0 at 16:10.

- [ ] **Step 2: Create the watchdog plist**

Same pattern from `com.hairmx.branch-deposit-watchdog.plist`: label `com.hairmx.branch-deposit-watchdog-hmxgroup`, lock `/tmp/branch-deposit-watchdog-hmxgroup.lock`, command appends `--group=hmx-group`, single `StartCalendarInterval` at 22:10.

- [ ] **Step 3: Create the weekend combine plist**

Same pattern from `com.hairmx.weekend-deposit-combine.plist`: label `com.hairmx.weekend-deposit-combine-hmxgroup`, lock `/tmp/weekend-deposit-combine-hmxgroup.lock`, command appends `--group=hmx-group --test-recipient=rjdjohnston@gmail.com`, `StartCalendarInterval` Weekday 0 at 17:10.

- [ ] **Step 4: Validate and load the plists**

Run:

```bash
for p in branch-deposit-export-hmxgroup branch-deposit-watchdog-hmxgroup weekend-deposit-combine-hmxgroup; do
  plutil -lint ~/Library/LaunchAgents/com.hairmx.$p.plist
  launchctl unload ~/Library/LaunchAgents/com.hairmx.$p.plist 2>/dev/null
  launchctl load ~/Library/LaunchAgents/com.hairmx.$p.plist
done
launchctl list | grep hmxgroup
```

Expected: three `OK` lint lines and three entries listed.

- [ ] **Step 5: Confirm CORP's jobs are untouched**

Run:

```bash
launchctl list | grep -E "branch-deposit|weekend-deposit"
/usr/libexec/PlistBuddy -c "Print :ProgramArguments" ~/Library/LaunchAgents/com.hairmx.branch-deposit-export.plist
```

Expected: CORP's three original jobs still listed, and CORP's command still has no `--group` flag (it defaults to `corp`).

- [ ] **Step 6: Push and open the PR**

```bash
cd ~/kitchen-plugin-yot
git push -u origin feat/hmx-group-disbursements
gh pr create --base main --head feat/hmx-group-disbursements \
  --title "HMX GROUP: second daily disbursements CSV + distribution group" \
  --body "$(cat <<'BODY'
Adds a second nightly Branch disbursement pipeline for HAIR MX GROUP (4 FL locations, 32 staff) by parameterizing the existing CORP scripts with a `--group` flag rather than forking them. Design: `docs/superpowers/specs/2026-07-20-hmx-group-disbursements-design.md`.

## What changed
- **Group config registry** (`src/disbursements/group-config.ts`) — roster tab, spreadsheets, BRANCH MASTER geometry, recipients, filename prefix, and garnishment/loan flags per group.
- **`CSV MASTER` → `CORP CSV MASTER`** — the roster tab rename now flows through the config. The old tab can be deleted once this ships.
- **Garnishments and loans are feature-flagged off for HMX GROUP** — it never reads or writes the garnishments spreadsheet.
- **Cross-roster collision guard** (`src/disbursements/roster-collisions.ts`) — a stylist on both rosters is excluded from the CSV and reported in diagnostics + the watchdog email, rather than being paid twice. Deliberately not an abort: one bad roster row must not stop payroll for everyone else.
- **`--group` on all three scripts** (export, watchdog, weekend combine) plus three new launchd jobs staggered 10 min after CORP with their own lock files.

## CORP is unchanged
Verified by diffing a dry run against the live `2026-07-18` output: byte-identical CSV. Same filenames, recipients, spreadsheets, subject, and schedule.

## Tests
`npx vitest run` — normalization, group-config resolution, and collision-guard suites all pass.

## Rollout
HMX GROUP email is routed to RJ only (`--test-recipient`) for the first nights; that flag comes out of the plists once verified.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 7: Tell the operator what remains**

Report back that these steps are RJ's, in order: (1) confirm the first HMX GROUP nightly run's CSV looks right, (2) remove `--test-recipient=rjdjohnston@gmail.com` from the two GROUP plists and reload them so Miranda starts receiving the file, and (3) delete the now-stale `CSV MASTER` tab from the Branch Daily Totals sheet.

---

## Self-Review

**Spec coverage:**
- Parameterize, don't fork → Tasks 3, 5, 6, 7. ✓
- Group config table (roster tab, sheets, recipients, filenames, flags) → Task 3. ✓
- `CSV MASTER` → `CORP CSV MASTER`, landing before tab deletion → Task 3 config + Task 5 Step 10 verification + Task 8 Step 7 handoff. ✓
- Collision guard, exclude-and-report not abort → Task 4 (logic + tests), Task 5 Step 5 (exclusion), Task 6 Step 4 (reporting). ✓
- Garnishments/loans disabled for GROUP, never touching that spreadsheet → Task 5 Step 4, verified Task 5 Step 11. ✓
- New spreadsheet with both templates and 4-location geometry → Task 1. ✓
- Watchdog covers GROUP incl. auto-append to its roster → Task 6. ✓
- Weekend combine covers GROUP → Task 7. ✓
- Own launchd jobs, own lock files, staggered 10 min → Task 8. ✓
- CORP unchanged → asserted by Task 3 tests and proven by Task 5 Step 10's byte-diff. ✓
- Unrostered locations still skipped → unchanged `supportedLocations` behavior; no task alters it. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows complete code. Two steps (Task 5 Step 5's `master` variable, Task 6 Step 5's auto-append site) instruct the implementer to match an existing local name rather than quoting a line verbatim — these name the fallback explicitly and are conditional lookups, not placeholders.

**Type consistency:** `resolveGroupConfig`/`otherGroupConfigs`/`DisbursementGroupConfig` names match between Task 3's definition and their uses in Tasks 5–7. `findRosterCollisions(own, other)` signature and the `RosterEntry`/`RosterCollision` shapes match between Task 4 and Task 5. `filePrefix`, `rosterTab`, `rosterSheetId`, `emailTo`, `emailCc`, `emailSubjectPrefix`, and the three `branchMaster*Row` fields are spelled identically in the config, the tests, and every consumer. The diagnostics fields `groupId` and `crossGroupCollisions` are written in Task 5 Step 7 and read in Task 6 Step 4.
