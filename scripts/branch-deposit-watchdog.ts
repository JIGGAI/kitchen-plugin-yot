// Nightly watchdog for the 21:00 ET Branch deposit export.
//
// Inputs:
//   --target-date=YYYY-MM-DD   default: today in America/New_York
//   --dry-run                  print the email + writes that WOULD happen
//   --skip-master-append       email-only mode; never appends to CSV MASTER
//
// Behaviour (in priority order):
//   1. CSV file missing                          → email "export missing"
//   2. fuzzyMatchedRows non-empty                → email "Branch sheet typos"
//   3. unmatched positive YOT rows               → for each, look up CSV MASTER
//        a. found exact or by fuzzy first name   → email "in CSV MASTER but
//                                                   missing from {tab} — add
//                                                   the row to today's tab"
//        b. not found                            → APPEND placeholder row to
//                                                   CSV MASTER (blank staff
//                                                   id + amount + tx id) and
//                                                   email what was added.
//   4. happy path                                → no email; just log.
//
// Email is sent via `gog gmail send` from govna.assistant@gmail.com to
// rjdjohnston@gmail.com. Run by ~/.openclaw/scripts/branch-deposit-watchdog.sh
// at 22:00 ET via the launchd plist.
//
// This file deliberately mirrors export-branch-deposits.ts's tone — direct
// invocations of `gog`, JSON in / out, no framework noise — so future
// maintenance feels familiar.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const NEW_YORK_TZ = 'America/New_York';
const EXPORT_DIR = '/Users/hairmx/hmx-reports';
const BRANCH_SHEET_ID = '1jIFWOMmvMVbGULUbDpEqV2e6CsXy_DzhBrCorV9H-EA';
const CSV_MASTER_TAB = 'CSV MASTER';
const FROM_ACCOUNT = 'govna.assistant@gmail.com';
const TO_ADDR = 'rjdjohnston@gmail.com';
const LOG_PATH = `${process.env.HOME || ''}/.openclaw/logs/cron/branch-deposit-watchdog.log`;

type Args = {
  targetDate: string;
  dryRun: boolean;
  skipMasterAppend: boolean;
};

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) map.set(arg.slice(2), 'true');
    else map.set(arg.slice(2, eq), arg.slice(eq + 1));
  }
  return {
    targetDate: map.get('target-date') || todayInNyTz(),
    dryRun: (map.get('dry-run') ?? 'false') !== 'false',
    skipMasterAppend: (map.get('skip-master-append') ?? 'false') !== 'false',
  };
}

function todayInNyTz(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: NEW_YORK_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function ts(): string {
  return new Date().toISOString();
}

function log(line: string) {
  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `[${ts()}] ${line}\n`, 'utf8');
  } catch {
    // best-effort
  }
  console.log(line);
}

function normalizeText(value: string | null | undefined): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[’']/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function splitName(fullName: string): { first: string; last: string } {
  const parts = normalizeText(fullName).split(' ').filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0]!, last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1]! };
}

function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i]![0] = i;
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[m]![n]!;
}

type MasterRow = {
  rowNumber: number; // 1-indexed including header
  staffId: string;
  firstName: string;
  lastName: string;
  location: string;
};

function loadCsvMaster(): MasterRow[] {
  const out = execFileSync('gog', [
    'sheets', 'get', BRANCH_SHEET_ID, `'${CSV_MASTER_TAB}'!A1:G500`,
    '--account', FROM_ACCOUNT, '--no-input', '--json',
  ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const parsed = JSON.parse(out) as { values?: string[][] };
  const values = parsed.values || [];
  const rows: MasterRow[] = [];
  for (let i = 1; i < values.length; i++) { // skip header row
    const row = values[i] || [];
    const staffId = String(row[0] || '').trim();
    const firstName = String(row[1] || '').trim();
    const lastName = String(row[2] || '').trim();
    const location = String(row[6] || '').trim();
    if (!staffId && !lastName && !firstName) continue;
    rows.push({ rowNumber: i + 1, staffId, firstName, lastName, location });
  }
  return rows;
}

type MasterMatchKind = 'exact' | 'typo' | 'lastname-only';
type MasterLookup =
  | { kind: 'absent' }
  | { kind: MasterMatchKind; row: MasterRow };

function findInCsvMaster(staffName: string, locationName: string | null, master: MasterRow[]): MasterLookup {
  const parts = splitName(staffName);
  if (!parts.last) return { kind: 'absent' };
  const normLoc = normalizeText(locationName);
  const candidatesByLast = master.filter((r) => normalizeText(r.lastName) === parts.last);
  if (!candidatesByLast.length) return { kind: 'absent' };

  // Same last + same first → exact
  const exact = candidatesByLast.find((r) => normalizeText(r.firstName) === parts.first);
  if (exact) return { kind: 'exact', row: exact };

  // Same last + Damerau-Levenshtein ≤1 first (and ≥4 chars on both sides) → typo
  if (parts.first.length >= 4) {
    const typo = candidatesByLast.find((r) => {
      const masterFirst = normalizeText(r.firstName);
      return masterFirst.length >= 4 && damerauLevenshtein(masterFirst, parts.first) <= 1;
    });
    if (typo) return { kind: 'typo', row: typo };
  }

  // Same last + same location → likely the same person under a totally
  // different first name (e.g. nickname). Surface as last-name-only so we
  // can tell the operator instead of double-adding.
  if (normLoc) {
    const lastAndLoc = candidatesByLast.find((r) => normalizeText(r.location) === normLoc);
    if (lastAndLoc) return { kind: 'lastname-only', row: lastAndLoc };
  }

  return { kind: 'absent' };
}

function appendPlaceholderToCsvMaster(staffName: string, locationName: string | null, dryRun: boolean): { range: string; values: string[] } {
  const parts = splitName(staffName);
  const firstName = parts.first
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  const lastName = parts.last.charAt(0).toUpperCase() + parts.last.slice(1);
  // Match the existing CSV MASTER row shape (A-G), staffId/amount blank so
  // the operator knows to fill them in before tomorrow's export.
  const row = ['', firstName, lastName, 'Deposit', '', '', locationName || ''];
  if (dryRun) {
    log(`DRY-RUN would append row to ${CSV_MASTER_TAB}: ${JSON.stringify(row)}`);
  } else {
    execFileSync('gog', [
      'sheets', 'append', BRANCH_SHEET_ID, `'${CSV_MASTER_TAB}'!A:G`,
      '--values-json', JSON.stringify([row]),
      '--input', 'USER_ENTERED',
      '--account', FROM_ACCOUNT,
      '--no-input',
    ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  }
  return { range: `${CSV_MASTER_TAB}!A:G`, values: row };
}

function sendEmail(subject: string, body: string, dryRun: boolean) {
  if (dryRun) {
    log(`DRY-RUN would send email\n  to: ${TO_ADDR}\n  from: ${FROM_ACCOUNT}\n  subject: ${subject}\n--- body ---\n${body}\n--- end ---`);
    return;
  }
  execFileSync('gog', [
    'gmail', 'send',
    '--account', FROM_ACCOUNT,
    '--from', FROM_ACCOUNT,
    '--to', TO_ADDR,
    '--subject', subject,
    '--body', body,
    '--no-input',
  ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log(`watchdog start target=${args.targetDate} dryRun=${args.dryRun} skipMasterAppend=${args.skipMasterAppend}`);

  const csvPath = path.join(EXPORT_DIR, `branch-deposits-${args.targetDate}.csv`);
  const diagPath = path.join(EXPORT_DIR, `branch-deposits-${args.targetDate}.diagnostics.json`);

  if (!existsSync(csvPath)) {
    log(`MISSING ${csvPath}`);
    sendEmail(
      `[HMX] Branch deposit export missing for ${args.targetDate}`,
      `The nightly Branch deposit export (21:00 ET) did not produce:
${csvPath}

The export script likely failed silently. Common causes:
  - gog auth refresh token missing (run: gog auth list)
  - Branch sheet missing the ${args.targetDate} tab
  - kitchen API down

To re-run manually:
  cd ~/kitchen-plugin-yot && npx tsx scripts/export-branch-deposits.ts --date=${args.targetDate}

OpenClaw cron state: ~/.openclaw/cron/jobs-state.json id 028128b0-6567-4927-b2ed-2a64e2c22559
Watchdog log: ${LOG_PATH}`,
      args.dryRun,
    );
    log('missing-file alert sent');
    return;
  }

  if (!existsSync(diagPath)) {
    log(`diagnostics file missing for ${args.targetDate}, nothing more to check`);
    return;
  }

  type Diag = {
    date: string;
    exportRowCount: number;
    branchSheetTab: string;
    reportRowsWithPositiveAmountButNoBranchMatch?: Array<{ staffName: string | null; locationName: string | null; bankToBankAmount: number }>;
    fuzzyMatchedRows?: Array<{ branchStaffId: string; branchName: string; reportName: string; locationName: string | null; matchKind: 'prefix' | 'typo' }>;
  };
  const diag = JSON.parse(readFileSync(diagPath, 'utf8')) as Diag;
  const fuzzyRows = diag.fuzzyMatchedRows || [];
  const unmatchedReport = diag.reportRowsWithPositiveAmountButNoBranchMatch || [];

  // Drop prefix-only matches (nicknames like Matt↔Matthew) from the alert
  // list — those have been working fine forever and aren't typos.
  const typoRows = fuzzyRows.filter((r) => r.matchKind === 'typo');

  const sections: string[] = [];
  const summaryBits: string[] = [];

  if (typoRows.length) {
    summaryBits.push(`${typoRows.length} typo${typoRows.length > 1 ? 's' : ''}`);
    const lines = typoRows.map((r) => `- Branch sheet shows "${r.branchName}" (staff id ${r.branchStaffId}, ${r.locationName || '?'}); YOT has "${r.reportName}". The export still paid them tonight via fuzzy match.`);
    sections.push(`Spelling mismatches on the ${diag.branchSheetTab} tab (Branch row vs YOT — please correct the Branch side so they match):\n${lines.join('\n')}`);
  }

  if (unmatchedReport.length) {
    const master = (() => {
      try { return loadCsvMaster(); } catch (err: any) {
        log(`failed to load CSV MASTER: ${err?.message || err}`);
        return [];
      }
    })();

    const inMaster: Array<{ yotName: string; location: string | null; amount: number; masterRow: number }> = [];
    const masterTypo: Array<{ yotName: string; location: string | null; amount: number; masterRow: number; masterFirst: string; masterLast: string }> = [];
    const lastNameOnly: Array<{ yotName: string; location: string | null; amount: number; masterRow: number; masterFirst: string; masterLast: string }> = [];
    const appended: Array<{ yotName: string; location: string | null; amount: number; addedRow: string[] }> = [];

    for (const row of unmatchedReport) {
      const lookup = findInCsvMaster(row.staffName || '', row.locationName, master);
      if (lookup.kind === 'exact') {
        inMaster.push({ yotName: row.staffName || '', location: row.locationName, amount: row.bankToBankAmount, masterRow: lookup.row.rowNumber });
      } else if (lookup.kind === 'typo') {
        masterTypo.push({ yotName: row.staffName || '', location: row.locationName, amount: row.bankToBankAmount, masterRow: lookup.row.rowNumber, masterFirst: lookup.row.firstName, masterLast: lookup.row.lastName });
      } else if (lookup.kind === 'lastname-only') {
        lastNameOnly.push({ yotName: row.staffName || '', location: row.locationName, amount: row.bankToBankAmount, masterRow: lookup.row.rowNumber, masterFirst: lookup.row.firstName, masterLast: lookup.row.lastName });
      } else {
        if (args.skipMasterAppend) {
          appended.push({ yotName: row.staffName || '', location: row.locationName, amount: row.bankToBankAmount, addedRow: [] });
        } else {
          const { values } = appendPlaceholderToCsvMaster(row.staffName || '', row.locationName, args.dryRun);
          appended.push({ yotName: row.staffName || '', location: row.locationName, amount: row.bankToBankAmount, addedRow: values });
        }
      }
    }

    if (inMaster.length) {
      summaryBits.push(`${inMaster.length} in CSV MASTER but missing from today's tab`);
      const lines = inMaster.map((r) => `- ${r.yotName} @ ${r.location || '?'} ($${r.amount}) — already on CSV MASTER row ${r.masterRow}; add a copy of that row to the ${diag.branchSheetTab} tab so the export can match them.`);
      sections.push(`YOT paid these staff but they're not on the ${diag.branchSheetTab} tab:\n${lines.join('\n')}`);
    }
    if (masterTypo.length) {
      summaryBits.push(`${masterTypo.length} CSV MASTER typo${masterTypo.length > 1 ? 's' : ''}`);
      const lines = masterTypo.map((r) => `- CSV MASTER row ${r.masterRow} has "${r.masterFirst} ${r.masterLast}"; YOT has "${r.yotName}". Fix the CSV MASTER spelling, then copy the row to the ${diag.branchSheetTab} tab.`);
      sections.push(`Spelling drift on CSV MASTER vs YOT:\n${lines.join('\n')}`);
    }
    if (lastNameOnly.length) {
      summaryBits.push(`${lastNameOnly.length} ambiguous last-name match${lastNameOnly.length > 1 ? 'es' : ''}`);
      const lines = lastNameOnly.map((r) => `- YOT "${r.yotName}" matches CSV MASTER last name "${r.masterLast}" (row ${r.masterRow}: "${r.masterFirst} ${r.masterLast}") at the same location, but the first names differ enough to be a different person or a nickname. Please verify.`);
      sections.push(`Ambiguous CSV MASTER matches:\n${lines.join('\n')}`);
    }
    if (appended.length) {
      const verb = args.skipMasterAppend ? 'would-be added' : (args.dryRun ? 'DRY-RUN would add' : 'auto-added');
      summaryBits.push(`${appended.length} ${args.skipMasterAppend ? 'missing from' : 'appended to'} CSV MASTER`);
      const lines = appended.map((r) => `- ${r.yotName} @ ${r.location || '?'} ($${r.amount}) — ${verb} placeholder row on CSV MASTER (blank STAFF ID / blank AMOUNT / TYPE=Deposit). Please fill in the Branch STAFF ID, then copy the row into the ${diag.branchSheetTab} tab to issue the deposit.`);
      sections.push(`Staff missing from CSV MASTER:\n${lines.join('\n')}`);
    }
  }

  if (!sections.length) {
    log(`watchdog ok target=${args.targetDate} export=${diag.exportRowCount} fuzzy=${fuzzyRows.length} unmatchedReport=${unmatchedReport.length}`);
    return;
  }

  const subject = `[HMX] Branch deposit watchdog ${args.targetDate} — ${summaryBits.join('; ')}`;
  const body = `Watchdog ran for ${args.targetDate} (Branch tab: ${diag.branchSheetTab}). Export wrote ${diag.exportRowCount} rows. Issues found:\n\n${sections.join('\n\n')}\n\nDiagnostics: ${diagPath}\nWatchdog log: ${LOG_PATH}`;
  sendEmail(subject, body, args.dryRun);
  log(`email sent: ${summaryBits.join('; ')}`);
}

main().catch((err) => {
  log(`watchdog failed: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
