// Nightly watchdog for the 21:00 ET Branch deposit export.
//
// Runs at 22:00 ET via ~/Library/LaunchAgents/com.hairmx.branch-deposit-
// watchdog.plist (1h after the export cron). Reads
// /Users/hairmx/hmx-reports/<prefix>branch-deposits-<date>.{csv,diagnostics.json}
// for the selected --group (default corp; see src/disbursements/group-config.ts)
// and emails rjdjohnston@gmail.com from govna.assistant@gmail.com when
// any of these conditions trip:
//
//   1. CSV file missing for the target date
//        → likely silent export failure (gog auth, kitchen API, etc.)
//   2. Roster tab spelling drift vs YOT (`fuzzyMatchedRows` with
//        matchKind = "typo")
//        → staff got paid via Damerau-Levenshtein rescue; fix the
//        roster spelling so it's not a recurring typo alert
//   3. YOT paid someone whose location IS represented on the group's
//        roster tab but whose name isn't there at all
//        (`reportRowsWithPositiveAmountButNoBranchMatch` with `inScope: true`)
//        → likely a new hire at a Branch-served shop. RJ pays them
//        manually for today and adds them to the roster tab so tomorrow's
//        export covers them. (We deliberately do NOT auto-append a
//        placeholder — a blank STAFF ID row would escape into the next
//        day's CSV upload to Branch as a degenerate deposit.)
//   4. Cross-roster collisions were found, or the collision check itself
//        could not run — both are double-payment risks (Task 5's
//        crossGroupCollisions / crossGroupCollisionCheckStatus).
//
// YOT-paid staff at locations NOT represented on the group's roster tab
// (Bethel Park, Clearwater, etc.) are intentionally ignored — those
// locations are paid through some other payroll path.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveGroupConfig, type DisbursementGroupConfig } from '../src/disbursements/group-config';
import type { RosterCollision } from '../src/disbursements/roster-collisions';

const NEW_YORK_TZ = 'America/New_York';
const EXPORT_DIR = '/Users/hairmx/hmx-reports';
const FROM_ACCOUNT = 'govna.assistant@gmail.com';
const TO_ADDR = 'rjdjohnston@gmail.com';
const LOG_PATH = `${process.env.HOME || ''}/.openclaw/logs/cron/branch-deposit-watchdog.log`;

type Args = {
  targetDate: string;
  dryRun: boolean;
  group: DisbursementGroupConfig;
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
    group: resolveGroupConfig(map.get('group')),
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

type LoanPaidOff = {
  staffId: string;
  firstName: string;
  lastName: string;
  totalAmount: number;
  paidOffOn: string;
  loanRow: number;
};

type Diag = {
  date: string;
  source?: string;
  sourceLabel?: string;
  groupId?: string;
  exportRowCount: number;
  masterRowCount?: number;
  reportRowsWithPositiveAmountButNoBranchMatch?: UnmatchedReportRow[];
  fuzzyMatchedRows?: FuzzyMatchedRow[];
  loansPaidOffToday?: LoanPaidOff[];
  // Cross-group roster safety (Task 5). `crossGroupCollisionCheckStatus`
  // is 'failed' when the other group's roster couldn't be read this run —
  // in that case collisions were NOT excluded from the CSV, so the
  // watchdog must say double-payment protection wasn't verified rather
  // than silently reporting zero collisions.
  crossGroupCollisions?: RosterCollision[];
  crossGroupCollisionCheckStatus?: 'ok' | 'failed';
  // Delivery outcome (export script >= 2026-06-08). Undefined on legacy
  // diagnostics files written before the field existed.
  dryRun?: boolean;
  skipEmail?: boolean;
  disbursementsRecipient?: string;
  disbursementsEmailStatus?: 'sent' | 'skipped' | 'failed';
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log(`watchdog start target=${args.targetDate} dryRun=${args.dryRun} group=${args.group.id}`);

  const csvPath = path.join(EXPORT_DIR, `${args.group.filePrefix}branch-deposits-${args.targetDate}.csv`);
  const diagPath = path.join(EXPORT_DIR, `${args.group.filePrefix}branch-deposits-${args.targetDate}.diagnostics.json`);

  if (!existsSync(csvPath)) {
    log(`MISSING ${csvPath}`);
    sendEmail(
      `[${args.group.emailSubjectPrefix}] Branch deposit export missing for ${args.targetDate}`,
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
  const loansPaidOff = diag.loansPaidOffToday || [];

  log(`diagnostics: export=${diag.exportRowCount} typos=${typoRows.length} unmatched=${unmatched.length} (inScope=${inScopeUnmatched.length}, outOfScope=${outOfScopeCount}) loansPaidOff=${loansPaidOff.length} emailStatus=${diag.disbursementsEmailStatus ?? 'n/a'} dryRun=${diag.dryRun ?? 'n/a'}`);

  // The CSV + diagnostics can exist yet the real send never happened — a
  // manual --dry-run / --skip-email run, or the nightly send failed. These
  // leave identical files on disk, so without this check a stale dry-run
  // masks a missed payout (exactly what happened on 2026-06-07). On legacy
  // files the field is undefined ("can't tell") — skip rather than false-alarm.
  if (diag.disbursementsEmailStatus !== undefined && diag.disbursementsEmailStatus !== 'sent') {
    const reason = diag.dryRun
      ? 'a dry-run produced these files — no real send happened'
      : `the disbursements email status was "${diag.disbursementsEmailStatus}"`;
    log(`NOT-SENT target=${args.targetDate} emailStatus=${diag.disbursementsEmailStatus} dryRun=${!!diag.dryRun}`);
    sendEmail(
      `[${args.group.emailSubjectPrefix}] Branch deposit NOT SENT for ${args.targetDate}`,
      `The Branch deposit files for ${args.targetDate} exist, but ${reason}.

Miranda was NOT emailed the deposit CSV and the live Google Sheets were NOT updated. The ${diag.exportRowCount} deposits for ${args.targetDate} have not been processed.

  Email status: ${diag.disbursementsEmailStatus}
  Dry run: ${!!diag.dryRun}
  Recipient: ${diag.disbursementsRecipient || '(default)'}

Re-run for real (emails Miranda + writes the live sheets):
  export GOG_KEYRING_PASSWORD="$(cat ~/.openclaw/secrets/gog_keyring_password)" && cd ~/kitchen-plugin-yot && npx tsx scripts/export-branch-deposits.ts --date=${args.targetDate}

Diagnostics: ${diagPath}
Watchdog log: ${LOG_PATH}`,
      args.dryRun,
    );
    log('not-sent alert sent');
    return;
  }

  const sections: string[] = [];
  const summaryBits: string[] = [];

  if (typoRows.length) {
    summaryBits.push(`${typoRows.length} typo${typoRows.length > 1 ? 's' : ''}`);
    const lines = typoRows.map((r) => `- ${args.group.rosterTab} row ${r.csvMasterRowNumber} has "${r.csvMasterName}"; YOT has "${r.reportName}" (${r.locationName || '?'}). The export paid them via fuzzy match. Please fix the spelling on ${args.group.rosterTab}.`);
    sections.push(`${args.group.rosterTab} spelling drift vs YOT:\n${lines.join('\n')}`);
  }

  if (inScopeUnmatched.length) {
    summaryBits.push(`${inScopeUnmatched.length} need manual payout`);
    const lines = inScopeUnmatched.map((r) => `- ${r.staffName || '?'} @ ${r.locationName || '?'} earned $${r.bankToBankAmount} today (YOT bank-to-bank). They aren't on ${args.group.rosterTab}, so they were not in tonight's deposit CSV. Action: pay them manually for today's amount, then add them to ${args.group.rosterTab} (with their Branch STAFF ID) so tomorrow's export covers them.`);
    sections.push(`Missing from ${args.group.rosterTab} (manual payout for today):\n${lines.join('\n')}`);
  }

  if (loansPaidOff.length) {
    summaryBits.push(`${loansPaidOff.length} loan${loansPaidOff.length > 1 ? 's' : ''} paid off`);
    const lines = loansPaidOff.map((l) => `- ${l.firstName} ${l.lastName} (staff id ${l.staffId}) finished a $${l.totalAmount.toFixed(2)} loan today (LOANS row ${l.loanRow}). Archive the row to a "PAID …" tab when convenient.`);
    sections.push(`Loans paid off today:\n${lines.join('\n')}`);
  }

  const collisions = diag.crossGroupCollisions || [];
  if (collisions.length) {
    const lines = collisions.map((c) => `- ${c.detail}`);
    sections.push(`Cross-roster collisions — these stylists were EXCLUDED from tonight's CSV to avoid double payment. Resolve by removing them from the wrong roster tab, then pay today manually if owed:\n${lines.join('\n')}`);
    summaryBits.push(`${collisions.length} roster collision${collisions.length === 1 ? '' : 's'}`);
  }

  if (diag.crossGroupCollisionCheckStatus === 'failed') {
    summaryBits.push('collision check failed');
    sections.push(`Cross-roster collision check FAILED for ${args.targetDate} — the other group's roster could not be read tonight, so double-payment protection was NOT verified for this ${args.group.label} run. Manually confirm no stylist appears on more than one group's roster tab before treating tonight's CSV as final.`);
  }

  if (!sections.length) {
    log(`watchdog ok target=${args.targetDate}`);
    return;
  }

  const subject = `[${args.group.emailSubjectPrefix}] Branch deposit watchdog ${args.targetDate} — ${summaryBits.join('; ')}`;
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
