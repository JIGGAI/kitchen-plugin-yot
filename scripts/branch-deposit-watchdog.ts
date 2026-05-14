// Nightly watchdog for the 21:00 ET Branch deposit export.
//
// Runs at 22:00 ET via ~/Library/LaunchAgents/com.hairmx.branch-deposit-
// watchdog.plist (1h after the export cron). Reads
// /Users/hairmx/hmx-reports/branch-deposits-<date>.{csv,diagnostics.json}
// and emails rjdjohnston@gmail.com from govna.assistant@gmail.com when
// any of three conditions trip:
//
//   1. CSV file missing for the target date
//        → likely silent export failure (gog auth, kitchen API, etc.)
//   2. CSV MASTER spelling drift vs YOT (`fuzzyMatchedRows` with
//        matchKind = "typo")
//        → staff got paid via Damerau-Levenshtein rescue; fix the
//        master spelling so it's not a recurring typo alert
//   3. YOT paid someone whose location IS represented on CSV MASTER but
//        whose name isn't there at all (`reportRowsWithPositiveAmountBut
//        NoBranchMatch` with `inScope: true`)
//        → likely a new hire at a Branch-served shop. Auto-append a
//        placeholder row to CSV MASTER (blank STAFF ID + AMOUNT, the
//        operator fills it in) and email RJ what was added.
//
// YOT-paid staff at locations NOT represented in CSV MASTER (Bethel
// Park, Clearwater, etc.) are intentionally ignored — those locations
// are paid through some other payroll path.

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

function log(line: string) {
  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch { /* best effort */ }
  console.log(line);
}

function splitName(fullName: string): { first: string; last: string } {
  const normalized = String(fullName || '').normalize('NFKD').replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
  const parts = normalized.split(' ').filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  if (parts.length === 1) return { first: '', last: parts[0]! };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1]! };
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function appendPlaceholderToCsvMaster(staffName: string, locationName: string | null, dryRun: boolean): string[] {
  const parts = splitName(staffName);
  const firstName = parts.first.split(' ').map(titleCase).join(' ');
  const lastName = titleCase(parts.last);
  // Match the existing CSV MASTER row shape (A-G): staffId/amount/txid blank
  // so the operator knows there's work to do (fill in the Branch STAFF ID
  // before tomorrow's export can pay them).
  const row = ['', firstName, lastName, 'Deposit', '', '', locationName || ''];
  if (!dryRun) {
    execFileSync('gog', [
      'sheets', 'append', BRANCH_SHEET_ID, `'${CSV_MASTER_TAB}'!A:G`,
      '--values-json', JSON.stringify([row]),
      '--input', 'USER_ENTERED',
      '--account', FROM_ACCOUNT,
      '--no-input',
    ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  }
  return row;
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

type UnmatchedReportRow = {
  staffName: string | null;
  locationName: string | null;
  bankToBankAmount: number;
  inScope: boolean;
};

type FuzzyMatchedRow = {
  csvMasterRowNumber: number;
  csvMasterName: string;
  reportName: string;
  locationName: string | null;
  matchKind: 'prefix' | 'typo';
};

type Diag = {
  date: string;
  source?: string;
  sourceLabel?: string;
  exportRowCount: number;
  masterRowCount?: number;
  reportRowsWithPositiveAmountButNoBranchMatch?: UnmatchedReportRow[];
  fuzzyMatchedRows?: FuzzyMatchedRow[];
};

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
  - kitchen API down (curl http://127.0.0.1:7777/healthz)
  - YOT Telerik report unreachable

To re-run manually:
  cd ~/kitchen-plugin-yot && npx tsx scripts/export-branch-deposits.ts --date=${args.targetDate}

Watchdog log: ${LOG_PATH}`,
      args.dryRun,
    );
    log('missing-file alert sent');
    return;
  }

  if (!existsSync(diagPath)) {
    log(`diagnostics file missing for ${args.targetDate}, skipping further checks`);
    return;
  }

  const diag = JSON.parse(readFileSync(diagPath, 'utf8')) as Diag;
  const typoRows = (diag.fuzzyMatchedRows || []).filter((r) => r.matchKind === 'typo');
  const unmatched = diag.reportRowsWithPositiveAmountButNoBranchMatch || [];
  const inScopeUnmatched = unmatched.filter((r) => r.inScope);
  const outOfScopeCount = unmatched.length - inScopeUnmatched.length;

  log(`diagnostics: export=${diag.exportRowCount} typos=${typoRows.length} unmatched=${unmatched.length} (inScope=${inScopeUnmatched.length}, outOfScope=${outOfScopeCount})`);

  const sections: string[] = [];
  const summaryBits: string[] = [];

  if (typoRows.length) {
    summaryBits.push(`${typoRows.length} typo${typoRows.length > 1 ? 's' : ''}`);
    const lines = typoRows.map((r) => `- CSV MASTER row ${r.csvMasterRowNumber} has "${r.csvMasterName}"; YOT has "${r.reportName}" (${r.locationName || '?'}). The export paid them via fuzzy match. Please fix the spelling on CSV MASTER.`);
    sections.push(`CSV MASTER spelling drift vs YOT:\n${lines.join('\n')}`);
  }

  if (inScopeUnmatched.length) {
    summaryBits.push(`${inScopeUnmatched.length} new staff added to CSV MASTER`);
    const addedRows: Array<{ yotName: string; location: string | null; amount: number; row: string[] }> = [];
    for (const r of inScopeUnmatched) {
      if (args.skipMasterAppend) {
        addedRows.push({ yotName: r.staffName || '', location: r.locationName, amount: r.bankToBankAmount, row: [] });
      } else {
        const row = appendPlaceholderToCsvMaster(r.staffName || '', r.locationName, args.dryRun);
        addedRows.push({ yotName: r.staffName || '', location: r.locationName, amount: r.bankToBankAmount, row });
      }
    }
    const verb = args.skipMasterAppend ? 'would-be added' : (args.dryRun ? 'DRY-RUN would add' : 'auto-added');
    const lines = addedRows.map((r) => `- ${r.yotName} @ ${r.location || '?'} ($${r.amount}) — ${verb} placeholder row to CSV MASTER (blank STAFF ID + AMOUNT, TYPE=Deposit). Please fill in the Branch STAFF ID so tomorrow's export can pay them.`);
    sections.push(`New staff at Branch-supported locations (need a Branch STAFF ID):\n${lines.join('\n')}`);
  }

  if (!sections.length) {
    log(`watchdog ok target=${args.targetDate}`);
    return;
  }

  const subject = `[HMX] Branch deposit watchdog ${args.targetDate} — ${summaryBits.join('; ')}`;
  const body = `Watchdog ran for ${args.targetDate}. Export wrote ${diag.exportRowCount} deposit rows.${outOfScopeCount > 0 ? ` (${outOfScopeCount} YOT-paid staff at out-of-scope locations skipped silently.)` : ''}

${sections.join('\n\n')}

Diagnostics: ${diagPath}
Watchdog log: ${LOG_PATH}`;
  sendEmail(subject, body, args.dryRun);
  log(`email sent: ${summaryBits.join('; ')}`);
}

main().catch((err) => {
  log(`watchdog failed: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
