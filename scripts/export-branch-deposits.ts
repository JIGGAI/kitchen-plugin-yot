// Nightly Branch deposit export.
//
// Produces /Users/hairmx/hmx-reports/branch-deposits-<date>.csv (the file
// the operator uploads to branchapp.com) plus a diagnostics JSON. Triggered
// every night at 21:00 ET by the OpenClaw cron job
// `branch-deposit-export-nightly` (jobs.json id 028128b0-…); the
// branch-deposit-watchdog at 22:00 ET reads our diagnostics to email RJ
// about anything that needs human follow-up.
//
// Source of truth shape (post-cutover 2026-05-14):
//   - YOT StaffCashoutReport for the target date → who got paid, how much
//   - "CSV MASTER" tab on the Branch Daily Totals sheet → roster of staff
//     known to Branch (staffId, first, last, location)
//
// We iterate YOT positives and look each up in CSV MASTER. A match emits
// an export row with the YOT bank-to-bank amount minus any garnishment;
// the transaction id is rebuilt in the format Branch has been receiving
// (<LastName><StaffId><AmountInteger>12/30/1899). When YOT pays someone
// who isn't on CSV MASTER, the watchdog appends a placeholder row to the
// sheet and emails RJ.
//
// Per-day tab handling (the old `5/13/26` tab flow) is intentionally gone.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runStaffCashoutReport } from '../src/reports/run-staff-cashout';
import type { StaffCashoutRow } from '../src/reports/reports/staff-cashout';

type Args = {
  date: string;
  teamId: string;
  organisationId: number;
  sheetId: string;
  garnishmentsSheetId: string;
  account: string;
  outputDir: string;
  // When true, the CSV + diagnostics still land on disk but no Google
  // Sheets writes happen (GARNISHMENTS PAYOUTS rewrite, LOAN PAYMENTS
  // rewrite, LOANS cell updates are all skipped) AND the disbursements
  // email is NOT sent. Useful for verifying a date's behavior against
  // the live sheet state without touching it or pinging Miranda.
  dryRun: boolean;
  // Optional override for the disbursements email To: address. Defaults
  // to Miranda; testing can redirect to e.g. rjdjohnston@gmail.com.
  testRecipient: string | null;
  // When true, the disbursements CSV is still written to disk but no
  // email is sent (regardless of dryRun). Useful when you want to inspect
  // the file but not bother Miranda.
  skipEmail: boolean;
};

type SheetValuesResponse = {
  values?: string[][];
};

type MasterRow = {
  rowNumber: number;
  staffId: string;
  firstName: string;
  lastName: string;
  location: string;
};

type ExportRow = {
  staffId: string;
  firstName: string;
  lastName: string;
  type: 'Deposit';
  amount: number;
  originalAmount: number;
  garnishmentPercent: number | null;
  garnishmentAmount: number;
  transactionId: string;
  location: string;
  matchedReportName: string;
  matchedReportLocation: string | null;
  // Set when the row came from a negative bankToBank — paid via the
  // disbursements CSV (operator settles with the stylist via Branch) but
  // excluded from the BRANCH MASTER daily tab's BRANCH column (which
  // tracks only positives, matching the operator's accounting model).
  isRebate: boolean;
};

type GarnishmentRule = {
  staffId: string;
  firstName: string;
  lastName: string;
  percent: number;
};

type GarnishmentPayoutRow = {
  staffId: string;
  firstName: string;
  lastName: string;
  type: 'GARNISHMENT';
  amount: number;
  transactionId: string;
  location: string;
  date: string;
};

// One row of the LOANS tab on the garnishments sheet. `totalPaid` is the
// running total before today's run; `remainingBalance` is recomputed from
// totalAmount − totalPaid. Idempotency adjustment for re-runs subtracts any
// same-date prior LOAN PAYMENTS rows from totalPaid before processing, so
// re-running the export for 2026-05-13 produces the same on-sheet state as
// running once.
type Loan = {
  rowNumber: number;       // 1-indexed including the header row
  staffId: string;
  startDate: string;
  firstName: string;
  lastName: string;
  totalAmount: number;
  withholding: number;
  day: string;             // raw label from the sheet (FRIDAY, WEDS, DAILY, …)
  totalPaid: number;
  remainingBalance: number;
};

type LoanPaymentRow = {
  staffId: string;
  date: string;
  firstName: string;
  lastName: string;
  loanAmount: number;
  totalPaid: number;       // cumulative including this payment
  withholding: number;     // amount taken this payment (may be less than loan.withholding if balance/deposit ran out)
  day: string;
  transactionId: string;
};

type FuzzyMatchedRow = {
  csvMasterRowNumber: number;
  csvMasterName: string;
  reportName: string;
  locationName: string | null;
  matchKind: 'prefix' | 'typo';
};

type UnmatchedReportRow = {
  staffName: string | null;
  locationName: string | null;
  bankToBankAmount: number;
  // true when the YOT row's location appears in CSV MASTER (so this is
  // likely a new hire at a Branch-served shop that needs to be added),
  // false when the entire location is out of scope for Branch (e.g.
  // Bethel Park, Clearwater — paid through another system).
  inScope: boolean;
};

type LoanPaidOff = {
  staffId: string;
  firstName: string;
  lastName: string;
  totalAmount: number;
  paidOffOn: string;
  loanRow: number;
};

type MatchDiagnostics = {
  date: string;
  source: 'csv-master';
  sourceLabel: string;
  generatedAt: string;
  reportRowCount: number;
  masterRowCount: number;
  exportRowCount: number;
  reportRowsWithPositiveAmountButNoBranchMatch: UnmatchedReportRow[];
  fuzzyMatchedRows: FuzzyMatchedRow[];
  garnishmentRuleCount: number;
  garnishmentAdjustedRowCount: number;
  garnishmentPayoutRows: GarnishmentPayoutRow[];
  loanRuleCount: number;
  loanWithholdingCount: number;
  loanPaymentRows: LoanPaymentRow[];
  loansPaidOffToday: LoanPaidOff[];
  branchMasterTabName: string;
  branchMasterPerLocation: Array<{
    location: string;
    branchAmount: number;
    branchNotes: string;
    yotAmount: number;
    yotNotes: string;
  }>;
  negativeRebates: Array<{
    staffName: string;
    locationName: string | null;
    rebateAmount: number;
    matched: boolean;
  }>;
};

const DEFAULT_SHEET_ID = '1jIFWOMmvMVbGULUbDpEqV2e6CsXy_DzhBrCorV9H-EA';
const DEFAULT_GARNISHMENTS_SHEET_ID = '1pvwN3h0X9ZsdhpH024zue9DlE4NaZiuzTia5NMoEn6c';
const DEFAULT_ACCOUNT = 'govna.assistant@gmail.com';
const DEFAULT_TEAM_ID = 'hmx-marketing-team';
const DEFAULT_ORGANISATION_ID = 11082;
const DEFAULT_OUTPUT_DIR = '/Users/hairmx/hmx-reports';
const NEW_YORK_TZ = 'America/New_York';
const CSV_MASTER_TAB = 'CSV MASTER';
// Template tab on the Branch Daily Totals sheet. Holds two side-by-side
// tables (BRANCH at cols A-C, YOT at cols E-G) keyed by location name in
// rows 4-18 plus a TOTAL row at 21. We read it once per run to learn the
// location list + TOTAL formula shape, then write a fresh per-day copy.
const BRANCH_MASTER_TAB = 'BRANCH MASTER';
const BRANCH_MASTER_FIRST_LOCATION_ROW = 4;
const BRANCH_MASTER_LAST_LOCATION_ROW = 18;
const BRANCH_MASTER_TOTAL_ROW = 21;
// The Branch DISPURSEMENTS sheet — separate spreadsheet from the Branch
// Daily Totals one. CSV BLANK MASTER tab carries the column layout for
// Miranda's Branch processing; we only use its header for shape (the tab
// has no data rows). Trailing space in the tab name is intentional — that's
// how it's named on the sheet.
const DISPURSEMENTS_SHEET_ID = '1Z9Ey0oaKAH1J4gy0JlL-m3HjLvy4PKbBYFno3dYjbH8';
const DISPURSEMENTS_TEMPLATE_TAB = 'CSV BLANK MASTER ';
const DEFAULT_DISPURSEMENTS_RECIPIENT = 'Miranda.hmx.corp@hairmx.net';
// When the disbursements email to Miranda (or whoever the recipient is set
// to) fails, we send a fallback alert to this address so the failure
// doesn't sit silently in stdout. RJ's personal Gmail keeps the alert
// path independent of the corporate inbox we just failed to reach.
const DISPURSEMENTS_FAILURE_ALERT_TO = 'rjdjohnston@gmail.com';

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) {
      map.set(arg.slice(2), 'true');
    } else {
      map.set(arg.slice(2, eq), arg.slice(eq + 1));
    }
  }

  const date = map.get('date') || todayIsoInTimezone(NEW_YORK_TZ);
  const organisationId = Number(map.get('organisationId') || map.get('org') || String(DEFAULT_ORGANISATION_ID));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid --date value: ${date}`);
  if (!Number.isFinite(organisationId)) throw new Error(`Invalid organisationId: ${map.get('organisationId') || map.get('org')}`);

  return {
    date,
    teamId: map.get('teamId') || DEFAULT_TEAM_ID,
    organisationId,
    sheetId: map.get('sheetId') || DEFAULT_SHEET_ID,
    garnishmentsSheetId: map.get('garnishmentsSheetId') || DEFAULT_GARNISHMENTS_SHEET_ID,
    account: map.get('account') || DEFAULT_ACCOUNT,
    outputDir: expandHome(map.get('outputDir') || DEFAULT_OUTPUT_DIR),
    dryRun: (map.get('dry-run') ?? 'false') !== 'false',
    testRecipient: map.get('test-recipient') || null,
    skipEmail: (map.get('skip-email') ?? 'false') !== 'false',
  };
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2));
  return value;
}

function todayIsoInTimezone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function gogJsonForAccount(account: string, args: string[]): any {
  const out = execFileSync('gog', [...args, '--account', account, '--json', '--no-input'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(out);
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

function normalizeLocation(value: string | null | undefined): string {
  return normalizeText(value)
    .replace(/\bmi\b|\boh\b|\bpa\b|\bwv\b|\bfl\b/g, '')
    .replace(/\btownship\b|\btwp\b/g, '')
    .replace(/\bstylist\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitName(fullName: string): { first: string; last: string } {
  const normalized = normalizeText(fullName);
  const parts = normalized.split(' ').filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0]!, last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1]! };
}

function firstToken(value: string): string {
  return normalizeText(value).split(' ').filter(Boolean)[0] || '';
}

// Damerau-Levenshtein: counts substitution, insertion, deletion, AND
// adjacent transposition each as 1 edit. Lets us recognise typos like
// "Krisitn" ↔ "Kristin" (a single transposition) as a near-match without
// being so loose that we collide unrelated names.
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

type FirstNameMatchKind = 'exact' | 'prefix' | 'typo' | 'none';

function firstNameMatchKind(a: string, b: string): FirstNameMatchKind {
  const aa = firstToken(a);
  const bb = firstToken(b);
  if (!aa || !bb) return 'none';
  if (aa === bb) return 'exact';
  if (aa.startsWith(bb) || bb.startsWith(aa)) return 'prefix';
  if (aa.length >= 4 && bb.length >= 4 && damerauLevenshtein(aa, bb) <= 1) return 'typo';
  return 'none';
}

function formatCsvCell(value: string | number): string {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

// Adds one calendar day to a YYYY-MM-DD string. Used for the
// Disbursement Date column on the CSV emailed to Miranda — she was
// manually bumping every row to the next day, so we now ship it
// pre-advanced (run on 5/21 → disbursement date 5/22).
function nextDayIso(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function toCsv(rows: ExportRow[]): string {
  const lines = [
    ['STAFF ID', 'FIRST NAME', 'LAST NAME', 'TYPE', 'AMOUNT', 'TRANSACTION ID', 'LOCATION'].join(','),
  ];
  for (const row of rows) {
    lines.push([
      row.staffId,
      row.firstName,
      row.lastName,
      row.type,
      Number.isInteger(row.amount) ? String(row.amount) : row.amount.toFixed(2),
      row.transactionId,
      row.location,
    ].map(formatCsvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// Builds the secondary CSV emailed to Miranda for Branch processing. Shape
// matches the CSV BLANK MASTER tab on the Branch DISPURSEMENTS sheet:
//   ID, First Name, Last Name, Type, Amount, Transaction ID, Location,
//   Disbursement Date (YYYY-MM-DD), Description
// First seven columns are sourced from our export rows (which already have
// garnishment + loan withholdings applied); the disbursement date is
// args.date + 1 day (Branch pays out the day after the export runs);
// description is left blank for Miranda to annotate as needed.
function toDisbursementsCsv(rows: ExportRow[], date: string): string {
  const disbursementDate = nextDayIso(date);
  const lines = [
    ['ID', 'First Name', 'Last Name', 'Type', 'Amount', 'Transaction ID', 'Location', 'Disbursement Date (YYYY-MM-DD)', 'Description'].join(','),
  ];
  for (const row of rows) {
    lines.push([
      row.staffId,
      row.firstName,
      row.lastName,
      row.type,
      Number.isInteger(row.amount) ? String(row.amount) : row.amount.toFixed(2),
      row.transactionId,
      row.location,
      disbursementDate,
      '',
    ].map(formatCsvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function buildWatchdogEmailSection(args: {
  typoRows: FuzzyMatchedRow[];
  inScopeUnmatched: UnmatchedReportRow[];
  loansPaidOff: LoanPaidOff[];
}): string {
  const sections: string[] = [];

  if (args.typoRows.length) {
    const lines = args.typoRows.map((r) => `- CSV MASTER row ${r.csvMasterRowNumber} has "${r.csvMasterName}"; YOT has "${r.reportName}" (${r.locationName || '?'}). The export paid them via fuzzy match. Please fix the spelling on CSV MASTER.`);
    sections.push(`CSV MASTER spelling drift vs YOT:\n${lines.join('\n')}`);
  }

  if (args.inScopeUnmatched.length) {
    const lines = args.inScopeUnmatched.map((r) => `- ${r.staffName || '?'} @ ${r.locationName || '?'} earned $${r.bankToBankAmount} today (YOT bank-to-bank). They aren't on CSV MASTER, so they were not in tonight's deposit CSV. Action: pay them manually for today's amount, then add them to CSV MASTER (with their Branch STAFF ID) so tomorrow's export covers them.`);
    sections.push(`Missing from CSV MASTER (manual payout for today):\n${lines.join('\n')}`);
  }

  if (args.loansPaidOff.length) {
    const lines = args.loansPaidOff.map((l) => `- ${l.firstName} ${l.lastName} (staff id ${l.staffId}) finished a $${l.totalAmount.toFixed(2)} loan today (LOANS row ${l.loanRow}). Archive the row to a "PAID …" tab when convenient.`);
    sections.push(`Loans paid off today:\n${lines.join('\n')}`);
  }

  if (!sections.length) return '';
  return `\n\nWatchdog messages:\n${sections.join('\n\n')}`;
}

function emailDisbursementsCsv(filePath: string, account: string, recipient: string, subject: string, body: string): void {
  execFileSync('gog', [
    'gmail', 'send',
    '--account', account,
    '--from', account,
    '--to', recipient,
    '--subject', subject,
    '--body', body,
    '--attach', filePath,
    '--no-input',
  ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

// Fallback path: when the disbursements email to the configured recipient
// fails (auth expired, attachment too big, address bounces, etc.), we
// notify RJ directly so the failure doesn't get buried in cron stdout.
// Returns whether the fallback itself delivered — both `false` outcomes
// (e.g., gog auth entirely broken) just end up in stderr.
function sendDisbursementsFailureAlert(
  account: string,
  intendedRecipient: string,
  date: string,
  disbursementsPath: string,
  errorMessage: string,
): boolean {
  if (intendedRecipient === DISPURSEMENTS_FAILURE_ALERT_TO) {
    // Don't alert RJ that the email to RJ failed — they'll just see stdout.
    return false;
  }
  const subject = `[HMX] Disbursements email to ${intendedRecipient} FAILED for ${date}`;
  const body = `The nightly disbursements email failed to deliver to ${intendedRecipient}.

Date: ${date}
Error: ${errorMessage}

The CSV is still on disk:
  ${disbursementsPath}

To retry by hand:
  /opt/homebrew/bin/gog gmail send \\
    --account ${account} --from ${account} --to ${intendedRecipient} \\
    --subject "HMX Disbursements ${date}" \\
    --body "Attached." --attach ${disbursementsPath} --no-input

To re-run the whole export (idempotent on sheet writes):
  cd ~/kitchen-plugin-yot && npx tsx scripts/export-branch-deposits.ts --date=${date}
`;
  try {
    execFileSync('gog', [
      'gmail', 'send',
      '--account', account,
      '--from', account,
      '--to', DISPURSEMENTS_FAILURE_ALERT_TO,
      '--subject', subject,
      '--body', body,
      '--no-input',
    ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    return true;
  } catch (alertErr: any) {
    console.error(`fallback alert email to ${DISPURSEMENTS_FAILURE_ALERT_TO} also failed: ${alertErr?.message || alertErr}`);
    return false;
  }
}

// Wraps a staff id with the Google Sheets text-marker apostrophe so a
// USER_ENTERED write doesn't re-parse "0731" as the number 731 and
// strip the leading zero. The apostrophe is invisible in the cell;
// subsequent FORMATTED_VALUE reads return the literal string back.
function toStaffIdCell(staffId: string): string {
  return staffId ? `'${staffId}` : staffId;
}

function toSheetValues(rows: GarnishmentPayoutRow[]): string[][] {
  return [
    ['STAFF ID', 'FIRST NAME', 'LAST NAME', 'TYPE', 'AMOUNT', 'TRANSACTION ID', 'LOCATION', 'DATE'],
    ...rows.map((row) => [
      toStaffIdCell(row.staffId),
      row.firstName,
      row.lastName,
      row.type,
      row.amount.toFixed(2),
      row.transactionId,
      row.location,
      row.date,
    ]),
  ];
}

// Branch's TRANSACTION ID convention, mirrored from the per-day tabs the
// operator used to maintain by hand: lastName + staffId + integer amount
// (truncated, not rounded — matches what operators typed historically)
// + literal "12/30/1899" (Sheets' epoch placeholder).
function buildTransactionId(lastName: string, staffId: string, amount: number): string {
  return `${lastName}${staffId}${Math.floor(amount)}12/30/1899`;
}

function loadCsvMasterRows(sheetId: string, account: string): MasterRow[] {
  // FORMATTED_VALUE preserves the cell's display string — critical for
  // staff IDs typed with leading zeros (e.g. "0731" for Miranda Bender)
  // which UNFORMATTED_VALUE would return as the number 731 and silently
  // drop the leading zero on the way into the export CSV.
  const response = gogJsonForAccount(account, ['sheets', 'get', sheetId, `'${CSV_MASTER_TAB}'!A1:G500`, '--render', 'FORMATTED_VALUE']) as SheetValuesResponse;
  const values = response.values || [];
  const rows: MasterRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const staffId = String(row[0] || '').trim();
    const firstName = String(row[1] || '').trim();
    const lastName = String(row[2] || '').trim();
    const location = String(row[6] || '').trim();
    // Skip section header rows ("STAFF ID" in col A) and footer ("TOTAL")
    // and rows with no identifying content.
    if (staffId.toUpperCase() === 'STAFF ID') continue;
    if (!staffId && !firstName && !lastName) continue;
    if (lastName.toUpperCase() === 'TOTAL' || firstName.toUpperCase() === 'TOTAL') continue;
    rows.push({ rowNumber: i + 1, staffId, firstName, lastName, location });
  }
  return rows;
}

function buildMasterIndexes(rows: MasterRow[]) {
  const byExactName = new Map<string, MasterRow[]>();
  const byLastName = new Map<string, MasterRow[]>();
  for (const row of rows) {
    const fullName = normalizeText(`${row.firstName} ${row.lastName}`);
    if (fullName) {
      if (!byExactName.has(fullName)) byExactName.set(fullName, []);
      byExactName.get(fullName)!.push(row);
    }
    const last = normalizeText(row.lastName);
    if (last) {
      if (!byLastName.has(last)) byLastName.set(last, []);
      byLastName.get(last)!.push(row);
    }
  }
  return { byExactName, byLastName };
}

type MasterMatchResult = { row: MasterRow; kind: 'exact' | 'prefix' | 'typo' };

function matchYotRowToMaster(yot: StaffCashoutRow, indexes: ReturnType<typeof buildMasterIndexes>): MasterMatchResult | null {
  const yotParts = splitName(yot.staffName || '');
  if (!yotParts.last) return null;
  const yotLoc = normalizeLocation(yot.locationName);

  const tiebreak = (a: MasterRow, b: MasterRow) => {
    const aLoc = normalizeLocation(a.location) === yotLoc ? 1 : 0;
    const bLoc = normalizeLocation(b.location) === yotLoc ? 1 : 0;
    if (aLoc !== bLoc) return bLoc - aLoc;
    return 0;
  };

  const exactKey = normalizeText(yot.staffName || '');
  const exactHits = indexes.byExactName.get(exactKey) || [];
  if (exactHits.length === 1) return { row: exactHits[0]!, kind: 'exact' };
  if (exactHits.length > 1) {
    const row = [...exactHits].sort(tiebreak)[0]!;
    return { row, kind: 'exact' };
  }

  const lastHits = indexes.byLastName.get(yotParts.last) || [];
  const ranked = lastHits
    .map((candidate) => ({ candidate, kind: firstNameMatchKind(yotParts.first, splitName(`${candidate.firstName} ${candidate.lastName}`).first) }))
    .filter((entry) => entry.kind !== 'none');
  if (!ranked.length) return null;
  const order = { exact: 0, prefix: 1, typo: 2 } as const;
  ranked.sort((a, b) => {
    const ak = order[a.kind as 'exact' | 'prefix' | 'typo'];
    const bk = order[b.kind as 'exact' | 'prefix' | 'typo'];
    if (ak !== bk) return ak - bk;
    return tiebreak(a.candidate, b.candidate);
  });
  const best = ranked[0]!;
  return { row: best.candidate, kind: best.kind as 'exact' | 'prefix' | 'typo' };
}

function parsePercent(value: string | null | undefined): number | null {
  if (!value) return null;
  const cleaned = String(value).replace(/[%\s]/g, '').trim();
  if (!cleaned) return null;
  const raw = Number(cleaned);
  if (!Number.isFinite(raw)) return null;
  if (raw > 1) return raw / 100;
  if (raw <= 0) return null;
  return raw;
}

function loadGarnishmentRules(sheetId: string, account: string): Map<string, GarnishmentRule> {
  const response = gogJsonForAccount(account, ['sheets', 'get', sheetId, 'GARNISHMENTS!A1:H1200', '--render', 'FORMATTED_VALUE']) as SheetValuesResponse;
  const rows = response.values || [];
  const rules = new Map<string, GarnishmentRule>();
  for (const row of rows.slice(1)) {
    const staffId = String(row[0] || '').trim();
    const firstName = String(row[1] || '').trim();
    const lastName = String(row[2] || '').trim();
    const percent = parsePercent(row[4]);
    if (!staffId || percent == null) continue;
    rules.set(staffId, { staffId, firstName, lastName, percent });
  }
  return rules;
}

function loadExistingGarnishmentPayoutRows(sheetId: string, account: string): GarnishmentPayoutRow[] {
  const response = gogJsonForAccount(account, ['sheets', 'get', sheetId, `'GARNISHMENTS PAYOUTS'!A1:H1200`, '--render', 'FORMATTED_VALUE']) as SheetValuesResponse;
  const rows = response.values || [];
  return rows.slice(1).map((row) => ({
    staffId: String(row[0] || '').trim(),
    firstName: String(row[1] || '').trim(),
    lastName: String(row[2] || '').trim(),
    type: 'GARNISHMENT' as const,
    amount: Number(String(row[4] || '').replace(/[$,]/g, '').trim() || '0') || 0,
    transactionId: String(row[5] || '').trim(),
    location: String(row[6] || '').trim(),
    date: String(row[7] || '').trim(),
  })).filter((row) => row.staffId || row.transactionId || row.date);
}

function rewriteGarnishmentPayoutSheet(sheetId: string, account: string, rows: GarnishmentPayoutRow[]) {
  const valuesJson = JSON.stringify(toSheetValues(rows));
  execFileSync('gog', ['sheets', 'clear', sheetId, `'GARNISHMENTS PAYOUTS'!A:Z`, '--account', account, '--no-input'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  execFileSync('gog', ['sheets', 'update', sheetId, `'GARNISHMENTS PAYOUTS'!A1:H${Math.max(rows.length + 1, 1)}`, '--values-json', valuesJson, '--input', 'USER_ENTERED', '--account', account, '--no-input'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

// Parses currency strings the operator types into the LOANS tab — accepts
// "$500.00", "$1,250.00", " 75 ", etc. Returns 0 for blank/garbage so
// downstream math doesn't NaN out a deposit.
function parseCurrency(value: string | null | undefined): number {
  if (!value) return 0;
  const cleaned = String(value).replace(/[$,\s]/g, '').trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

const DAY_OF_WEEK_BY_LABEL: Record<string, number> = {
  SUN: 0, SUNDAY: 0,
  MON: 1, MONDAY: 1,
  TUE: 2, TUES: 2, TUESDAY: 2,
  WED: 3, WEDS: 3, WEDNESDAY: 3,
  THU: 4, THUR: 4, THURS: 4, THURSDAY: 4,
  FRI: 5, FRIDAY: 5,
  SAT: 6, SATURDAY: 6,
};

function dayOfWeekForIso(dateIso: string): number {
  // Anchor on UTC noon so DST edge cases never flip the calendar day.
  return new Date(`${dateIso}T12:00:00Z`).getUTCDay();
}

function isLoanDueOn(loan: Loan, dateIso: string): boolean {
  const label = (loan.day || '').toUpperCase().trim();
  if (!label) return false;
  if (label === 'DAILY' || label === 'EVERY DAY' || label === 'EVERYDAY') return true;
  const target = DAY_OF_WEEK_BY_LABEL[label];
  if (target === undefined) return false;
  return dayOfWeekForIso(dateIso) === target;
}

function loadActiveLoans(sheetId: string, account: string): Loan[] {
  const response = gogJsonForAccount(account, ['sheets', 'get', sheetId, `'LOANS'!A1:J500`, '--render', 'FORMATTED_VALUE']) as SheetValuesResponse;
  const values = response.values || [];
  const loans: Loan[] = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const staffId = String(row[0] || '').trim();
    const startDate = String(row[1] || '').trim();
    const firstName = String(row[2] || '').trim();
    const lastName = String(row[3] || '').trim();
    const totalAmount = parseCurrency(row[4]);
    const withholding = parseCurrency(row[5]);
    const day = String(row[6] || '').trim();
    const totalPaid = parseCurrency(row[7]);
    // Skip section headers and empty rows. We require a numeric staff id +
    // a non-zero principal to consider a row "active".
    if (!staffId || staffId.toUpperCase() === 'STAFF ID') continue;
    if (totalAmount <= 0) continue;
    const remainingBalance = Math.max(0, Number((totalAmount - totalPaid).toFixed(2)));
    loans.push({
      rowNumber: i + 1,
      staffId, startDate, firstName, lastName,
      totalAmount, withholding, day, totalPaid, remainingBalance,
    });
  }
  return loans;
}

function loadExistingLoanPayments(sheetId: string, account: string): LoanPaymentRow[] {
  const response = gogJsonForAccount(account, ['sheets', 'get', sheetId, `'LOAN PAYMENTS'!A1:I1200`, '--render', 'FORMATTED_VALUE']) as SheetValuesResponse;
  const values = response.values || [];
  return values.slice(1).map((row) => ({
    staffId: String(row[0] || '').trim(),
    date: String(row[1] || '').trim(),
    firstName: String(row[2] || '').trim(),
    lastName: String(row[3] || '').trim(),
    loanAmount: parseCurrency(row[4]),
    totalPaid: parseCurrency(row[5]),
    withholding: parseCurrency(row[6]),
    day: String(row[7] || '').trim(),
    transactionId: String(row[8] || '').trim(),
  })).filter((r) => r.staffId || r.date);
}

function rewriteLoanPaymentsSheet(sheetId: string, account: string, rows: LoanPaymentRow[]) {
  const values: string[][] = [
    ['STAFF ID', 'DATE', 'FIRST NAME', 'LAST NAME', 'LOAN AMOUNT', 'TOTAL PAID', 'WITHHOLDING', 'DAY', 'TRANSACTION ID'],
    ...rows.map((r) => [
      toStaffIdCell(r.staffId),
      r.date,
      r.firstName,
      r.lastName,
      `$${r.loanAmount.toFixed(2)}`,
      `$${r.totalPaid.toFixed(2)}`,
      `$${r.withholding.toFixed(2)}`,
      r.day,
      r.transactionId,
    ]),
  ];
  const valuesJson = JSON.stringify(values);
  execFileSync('gog', ['sheets', 'clear', sheetId, `'LOAN PAYMENTS'!A:Z`, '--account', account, '--no-input'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  execFileSync('gog', ['sheets', 'update', sheetId, `'LOAN PAYMENTS'!A1:I${Math.max(values.length, 1)}`, '--values-json', valuesJson, '--input', 'USER_ENTERED', '--account', account, '--no-input'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

// Writes one loan's TOTAL PAID (col H) + REMAINING BAL. (col J) back to the
// LOANS sheet. Per-row writes — we expect a handful of affected rows per
// run (~10 active loans max), so the chattiness is fine.
function updateLoanCellsForRow(sheetId: string, account: string, rowNumber: number, totalPaid: number, remainingBalance: number) {
  execFileSync('gog', ['sheets', 'update', sheetId, `'LOANS'!H${rowNumber}`, '--values-json', JSON.stringify([[`$${totalPaid.toFixed(2)}`]]), '--input', 'USER_ENTERED', '--account', account, '--no-input'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  execFileSync('gog', ['sheets', 'update', sheetId, `'LOANS'!J${rowNumber}`, '--values-json', JSON.stringify([[`$${remainingBalance.toFixed(2)}`]]), '--input', 'USER_ENTERED', '--account', account, '--no-input'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

// Formats an ISO yyyy-mm-dd into the tab name convention the operator has
// been using on the Branch Daily Totals sheet: M/D/YY (no zero-padding,
// two-digit year). Matches existing tabs like "5/15/26", "4/30/26".
function formatDailyTabName(dateIso: string): string {
  const m = dateIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid ISO date: ${dateIso}`);
  const year2 = m[1]!.slice(2);
  const month = String(Number(m[2]));
  const day = String(Number(m[3]));
  return `${month}/${day}/${year2}`;
}

type BranchMasterTemplate = {
  /** Location labels as they appear in col A rows 4-18 (preserve trailing
   *  spaces — they're part of the sheet's identity for some rows). */
  locationLabels: string[];
  /** Row 2 header labels for the two tables: [A2, B2, C2, E2, F2, G2]. */
  headerLabels: { a: string; b: string; c: string; e: string; f: string; g: string };
};

function loadBranchMasterTemplate(sheetId: string, account: string): BranchMasterTemplate {
  const response = gogJsonForAccount(account, [
    'sheets', 'get', sheetId, `'${BRANCH_MASTER_TAB}'!A1:G${BRANCH_MASTER_TOTAL_ROW}`,
    '--render', 'FORMATTED_VALUE',
  ]) as SheetValuesResponse;
  const values = response.values || [];
  const header = values[1] || [];
  const locationLabels: string[] = [];
  for (let r = BRANCH_MASTER_FIRST_LOCATION_ROW - 1; r <= BRANCH_MASTER_LAST_LOCATION_ROW - 1; r++) {
    const label = String((values[r] || [])[0] || '');
    locationLabels.push(label);
  }
  return {
    locationLabels,
    headerLabels: {
      a: String(header[0] || 'LOCATION'),
      b: String(header[1] || 'BRANCH'),
      c: String(header[2] || 'NOTES'),
      e: String(header[4] || 'LOCATION'),
      f: String(header[5] || 'YOT'),
      g: String(header[6] || 'NOTES'),
    },
  };
}

function getSheetIdByTitle(spreadsheetId: string, account: string, title: string): number | null {
  const info = gogJsonForAccount(account, ['sheets', 'metadata', spreadsheetId]);
  const sheets: any[] = info?.sheets || [];
  for (const s of sheets) {
    if (s?.properties?.title === title) return Number(s.properties.sheetId);
  }
  return null;
}

function deleteTabIfExists(spreadsheetId: string, account: string, title: string): void {
  const id = getSheetIdByTitle(spreadsheetId, account, title);
  if (id == null) return;
  execFileSync('gog', ['sheets', 'delete-tab', spreadsheetId, title, '--account', account, '--force', '--no-input'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function addTab(spreadsheetId: string, account: string, title: string): void {
  execFileSync('gog', ['sheets', 'add-tab', spreadsheetId, title, '--account', account, '--no-input'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

// Moves a freshly-created tab to a specific position in the spreadsheet's
// tab list. gog doesn't expose tab-position control, so we shell out to
// gog to dump the refresh token, exchange it for an access token via the
// OAuth client cred file, and call the Sheets API's batchUpdate endpoint
// directly. The refresh token lives on disk only for the duration of the
// call and is unlinked in the `finally` block (mode 0600 by gog default).
//
// If anything in this chain fails the new tab still ends up created
// successfully (at the right end of the tab list) — we just log a warning
// and let the operator drag it into place. The export's other on-sheet
// writes are unaffected.
const GOG_CLIENT_FILE_DEFAULT = path.join(homedir(), '.openclaw', 'secrets', 'gog-client.json');

async function moveTabToIndex(args: {
  spreadsheetId: string;
  account: string;
  sheetId: number;
  newIndex: number;
}): Promise<void> {
  const refreshFile = path.join(homedir(), `.gog-refresh-${process.pid}-${Date.now()}.json`);
  try {
    execFileSync('gog', [
      'auth', 'tokens', 'export', args.account,
      '--out', refreshFile, '--overwrite', '--no-input',
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const refresh = JSON.parse(readFileSync(refreshFile, 'utf8'));
    const refreshToken = String(refresh.refresh_token || '');
    if (!refreshToken) throw new Error('gog auth tokens export returned no refresh_token');

    const clientPath = process.env.GOG_CLIENT_FILE || GOG_CLIENT_FILE_DEFAULT;
    const client = JSON.parse(readFileSync(clientPath, 'utf8'));
    const installed = client.installed || client.web || {};
    const clientId = String(installed.client_id || '');
    const clientSecret = String(installed.client_secret || '');
    if (!clientId || !clientSecret) throw new Error(`OAuth client creds missing in ${clientPath}`);

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!tokenResp.ok) {
      throw new Error(`OAuth refresh failed: ${tokenResp.status} ${await tokenResp.text()}`);
    }
    const tokenJson = await tokenResp.json() as { access_token?: string };
    const accessToken = String(tokenJson.access_token || '');
    if (!accessToken) throw new Error('OAuth refresh returned no access_token');

    const apiResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(args.spreadsheetId)}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: [{
            updateSheetProperties: {
              properties: { sheetId: args.sheetId, index: args.newIndex },
              fields: 'index',
            },
          }],
        }),
      },
    );
    if (!apiResp.ok) {
      throw new Error(`Sheets batchUpdate failed: ${apiResp.status} ${await apiResp.text()}`);
    }
  } finally {
    try { unlinkSync(refreshFile); } catch { /* noop */ }
  }
}

type DailyTabLocationAggregate = {
  branchAmount: number;
  branchNotes: string;
  yotAmount: number;
  yotNotes: string;
};

// Joins multi-source notes (one string per source) with " / " in a stable,
// non-empty-only way. Mirrors the formatting the operator has been using on
// BRANCH NOTES (e.g. "WH $75 LOAN ALLISON/ WH $50 LOAN TRISH").
function joinNotes(parts: string[]): string {
  return parts.filter((p) => p && p.trim()).join(' / ');
}

type ResolvedLocationRow = {
  location: string;
  branchAmount: number;
  branchNotes: string;
  yotAmount: number;
  yotNotes: string;
};

function writeDailyTabContent(args: {
  spreadsheetId: string;
  account: string;
  tabName: string;
  template: BranchMasterTemplate;
  resolved: ResolvedLocationRow[];
  date: string;
}): void {
  const { spreadsheetId, account, tabName, template, resolved, date } = args;
  const labelWithDate = `LOCATION ${formatDailyTabName(date)}`;

  // Build the full A1:G21 grid in one shot.
  const grid: string[][] = [];
  // Row 1: leave blank (operator clears this on existing daily tabs).
  grid.push(['', '', '', '', '', '', '']);
  // Row 2: headers with date-stamped LOCATION labels.
  grid.push([labelWithDate, template.headerLabels.b, template.headerLabels.c, '', labelWithDate, template.headerLabels.f, template.headerLabels.g]);
  // Row 3: blank spacer (matches template).
  grid.push(['', '', '', '', '', '', '']);

  // Rows 4-18: one per template location. Blank cell when amount is zero
  // (matches the operator's manual pattern on existing daily tabs).
  for (const row of resolved) {
    const branchVal = row.branchAmount !== 0 ? `$${row.branchAmount.toFixed(2)}` : '';
    const yotVal = row.yotAmount !== 0 ? `$${row.yotAmount.toFixed(2)}` : '';
    grid.push([
      row.location,
      branchVal,
      row.branchNotes,
      '',
      row.location,
      yotVal,
      row.yotNotes,
    ]);
  }
  // Rows 19, 20: blank spacers (preserve template shape).
  while (grid.length < BRANCH_MASTER_TOTAL_ROW - 1) {
    grid.push(['', '', '', '', '', '', '']);
  }
  // Row 21: TOTAL row with SUM formulas matching the template.
  const sumRangeBranch = `B${BRANCH_MASTER_FIRST_LOCATION_ROW}:B${BRANCH_MASTER_LAST_LOCATION_ROW}`;
  const sumRangeYot = `F${BRANCH_MASTER_FIRST_LOCATION_ROW}:F${BRANCH_MASTER_LAST_LOCATION_ROW}`;
  grid.push(['', 'TOTAL', `=SUM(${sumRangeBranch})`, '', '', 'TOTAL', `=SUM(${sumRangeYot})`]);

  const valuesJson = JSON.stringify(grid);
  execFileSync('gog', [
    'sheets', 'update', spreadsheetId,
    `'${tabName}'!A1:G${BRANCH_MASTER_TOTAL_ROW}`,
    '--values-json', valuesJson,
    '--input', 'USER_ENTERED',
    '--account', account,
    '--no-input',
  ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outputDir, { recursive: true });

  const report = await runStaffCashoutReport({
    teamId: args.teamId,
    startDateIso: args.date,
    endDateIso: args.date,
    organisationId: args.organisationId,
  });
  const masterRows = loadCsvMasterRows(args.sheetId, args.account);
  const garnishmentRules = loadGarnishmentRules(args.garnishmentsSheetId, args.account);
  const activeLoans = loadActiveLoans(args.garnishmentsSheetId, args.account);
  const existingLoanPayments = loadExistingLoanPayments(args.garnishmentsSheetId, args.account);
  const masterIndexes = buildMasterIndexes(masterRows);
  // CSV MASTER is the authoritative list of which locations Branch handles
  // — staff at any other location are paid through some other system and
  // we deliberately skip them. The watchdog uses inScope to decide which
  // unmatched YOT rows deserve an alert (likely new hire at a covered
  // shop) versus a silent skip (out-of-scope shop entirely).
  const supportedLocations = new Set<string>();
  for (const row of masterRows) {
    const norm = normalizeLocation(row.location);
    if (norm) supportedLocations.add(norm);
  }

  // Idempotency: if a LOAN PAYMENTS row already exists for (staffId, args.date)
  // from a previous run of this date, roll that withholding back out of the
  // in-memory loan state so this run computes deltas from the same starting
  // point. The rewrite of LOAN PAYMENTS at the end will replace those rows.
  const todayPriorLoanPaymentsByStaff = new Map<string, LoanPaymentRow[]>();
  for (const p of existingLoanPayments) {
    if (p.date !== args.date) continue;
    const arr = todayPriorLoanPaymentsByStaff.get(p.staffId) || [];
    arr.push(p);
    todayPriorLoanPaymentsByStaff.set(p.staffId, arr);
  }
  const loansByStaffId = new Map<string, Loan[]>();
  for (const loan of activeLoans) {
    const arr = loansByStaffId.get(loan.staffId) || [];
    arr.push(loan);
    loansByStaffId.set(loan.staffId, arr);
  }
  for (const [staffId, priors] of todayPriorLoanPaymentsByStaff) {
    const loans = loansByStaffId.get(staffId) || [];
    if (!loans.length) continue;
    // When a stylist has more than one active loan and multiple prior-day
    // rows, we don't have a stable loan identity in LOAN PAYMENTS. Fall back
    // to the simplest rule: subtract each prior withholding from the first
    // loan that can absorb it. (Same-stylist multi-loan is rare today; if it
    // becomes common we can add a loan id column.)
    for (const prior of priors) {
      const target = loans.find((l) => l.totalPaid >= prior.withholding) || loans[0]!;
      target.totalPaid = Number((target.totalPaid - prior.withholding).toFixed(2));
      target.remainingBalance = Number((target.totalAmount - target.totalPaid).toFixed(2));
    }
  }

  const exportRows: ExportRow[] = [];
  const fuzzyMatchedRows: FuzzyMatchedRow[] = [];
  const unmatchedReport: UnmatchedReportRow[] = [];
  const garnishmentPayoutRows: GarnishmentPayoutRow[] = [];
  const loanPaymentsThisRun: LoanPaymentRow[] = [];
  const loansPaidOffToday: LoanPaidOff[] = [];
  const loanCellUpdates: Array<{ rowNumber: number; totalPaid: number; remainingBalance: number }> = [];
  // Tracks stylists whose bankToBank was negative for the day — the shop
  // "owes" them that amount as a makewhole rebate. Drives both the BRANCH
  // MASTER daily tab YOT NOTES ("FIRSTNAME OWED $X") and the new
  // disbursements rows that pay them out.
  type NegativeRebate = {
    staffName: string;
    locationName: string | null;
    rebateAmount: number;
    matched: boolean;
  };
  const negativeRebates: NegativeRebate[] = [];

  for (const yotRow of report.rows) {
    const rawAmount = Number(yotRow.bankToBankAmount || 0);
    if (rawAmount === 0) continue;
    const isRebate = rawAmount < 0;
    const baseAmount = Math.abs(rawAmount);

    const match = matchYotRowToMaster(yotRow, masterIndexes);
    if (!match) {
      if (isRebate) {
        // Tracked in negativeRebates instead of unmatchedReport — the
        // watchdog's "pay them manually for today's amount" phrasing is
        // only correct for positive bankToBank rows. YOT NOTES on the
        // BRANCH MASTER daily tab will still annotate the rebate.
        negativeRebates.push({
          staffName: yotRow.staffName || '?',
          locationName: yotRow.locationName,
          rebateAmount: baseAmount,
          matched: false,
        });
      } else {
        unmatchedReport.push({
          staffName: yotRow.staffName,
          locationName: yotRow.locationName,
          bankToBankAmount: rawAmount,
          inScope: supportedLocations.has(normalizeLocation(yotRow.locationName)),
        });
      }
      continue;
    }
    if (match.kind !== 'exact') {
      fuzzyMatchedRows.push({
        csvMasterRowNumber: match.row.rowNumber,
        csvMasterName: `${match.row.firstName} ${match.row.lastName}`.trim(),
        reportName: yotRow.staffName || '',
        locationName: yotRow.locationName,
        matchKind: match.kind,
      });
    }

    const garnishmentRule = garnishmentRules.get(match.row.staffId) || null;
    const garnishmentPercent = garnishmentRule?.percent ?? null;
    const garnishmentAmount = garnishmentPercent ? Number((baseAmount * garnishmentPercent).toFixed(2)) : 0;
    const postGarnishment = Number((baseAmount - garnishmentAmount).toFixed(2));

    // Loan withholding runs AFTER garnishment so the loan amount can't push
    // the deposit negative. For each active loan whose DAY matches today
    // and which still has a balance, we withhold min(WITHHOLDING, balance,
    // postGarnishment-remaining). Multiple loans on the same stylist are
    // processed serially against the dwindling postGarnishment pool.
    const stylistLoans = loansByStaffId.get(match.row.staffId) || [];
    let loanWithheldTotal = 0;
    let availableForLoan = postGarnishment;
    for (const loan of stylistLoans) {
      if (!isLoanDueOn(loan, args.date)) continue;
      if (loan.remainingBalance <= 0) continue;
      if (loan.withholding <= 0) continue;
      if (availableForLoan <= 0) break;

      const desired = Math.min(loan.withholding, loan.remainingBalance);
      const actual = Number(Math.min(desired, availableForLoan).toFixed(2));
      if (actual <= 0) continue;

      loanWithheldTotal = Number((loanWithheldTotal + actual).toFixed(2));
      availableForLoan = Number((availableForLoan - actual).toFixed(2));

      const newTotalPaid = Number((loan.totalPaid + actual).toFixed(2));
      const newRemaining = Math.max(0, Number((loan.totalAmount - newTotalPaid).toFixed(2)));

      loanPaymentsThisRun.push({
        staffId: loan.staffId,
        date: args.date,
        firstName: loan.firstName,
        lastName: loan.lastName,
        loanAmount: loan.totalAmount,
        totalPaid: newTotalPaid,
        withholding: actual,
        day: loan.day,
        transactionId: buildTransactionId(loan.lastName, loan.staffId, actual),
      });
      loanCellUpdates.push({
        rowNumber: loan.rowNumber,
        totalPaid: newTotalPaid,
        remainingBalance: newRemaining,
      });
      // Mutate the in-memory loan so any subsequent same-stylist YOT row in
      // the same run (e.g. a split shift across two locations) sees the
      // already-reduced balance and we don't withhold past zero.
      loan.totalPaid = newTotalPaid;
      loan.remainingBalance = newRemaining;
      if (newRemaining <= 0) {
        loansPaidOffToday.push({
          staffId: loan.staffId,
          firstName: loan.firstName,
          lastName: loan.lastName,
          totalAmount: loan.totalAmount,
          paidOffOn: args.date,
          loanRow: loan.rowNumber,
        });
      }
    }

    const adjustedAmount = Number((postGarnishment - loanWithheldTotal).toFixed(2));
    const transactionId = buildTransactionId(match.row.lastName, match.row.staffId, adjustedAmount);

    // Use CSV MASTER's location (column G on the Branch Daily Totals
    // sheet) as the canonical location string. YOT's report appends the
    // state abbreviation (e.g. "Brighton MI") which doesn't match the
    // sheet's location field downstream consumers join against.
    // matchedReportLocation keeps the raw YOT string for traceability in
    // the watchdog log; only `location` (the field that flows to the CSV)
    // gets normalized.
    const csvLocation = match.row.location || yotRow.locationName || '';
    exportRows.push({
      staffId: match.row.staffId,
      firstName: match.row.firstName,
      lastName: match.row.lastName,
      type: 'Deposit',
      amount: adjustedAmount,
      originalAmount: baseAmount,
      garnishmentPercent,
      garnishmentAmount,
      transactionId,
      location: csvLocation,
      matchedReportName: yotRow.staffName || '',
      matchedReportLocation: yotRow.locationName,
      isRebate,
    });

    if (isRebate) {
      // baseAmount drove the disbursement row; record the original |negative|
      // so the BRANCH MASTER YOT NOTES read "FIRSTNAME OWED $X" with the
      // stylist's actual rebate amount (pre-deduction).
      negativeRebates.push({
        staffName: `${match.row.firstName} ${match.row.lastName}`.trim() || yotRow.staffName || '?',
        locationName: csvLocation,
        rebateAmount: baseAmount,
        matched: true,
      });
    }

    if (garnishmentAmount > 0) {
      garnishmentPayoutRows.push({
        staffId: match.row.staffId,
        firstName: match.row.firstName,
        lastName: match.row.lastName,
        type: 'GARNISHMENT',
        amount: garnishmentAmount,
        transactionId: buildTransactionId(match.row.lastName, match.row.staffId, garnishmentAmount),
        location: csvLocation,
        date: args.date,
      });
    }
  }

  exportRows.sort((a, b) => a.location.localeCompare(b.location) || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));

  const existingGarnishmentPayoutRows = loadExistingGarnishmentPayoutRows(args.garnishmentsSheetId, args.account)
    .filter((row) => row.date !== args.date);
  const rewrittenGarnishmentPayoutRows = [...existingGarnishmentPayoutRows, ...garnishmentPayoutRows]
    .sort((a, b) => (a.date === b.date ? a.location.localeCompare(b.location) || a.lastName.localeCompare(b.lastName) : b.date.localeCompare(a.date)));

  // LOAN PAYMENTS: prune any prior rows for args.date (idempotent re-run)
  // and append this run's withholdings, then rewrite the entire tab so the
  // sheet stays sorted by date desc / lastName.
  const rewrittenLoanPayments = [
    ...existingLoanPayments.filter((row) => row.date !== args.date),
    ...loanPaymentsThisRun,
  ].sort((a, b) => (b.date.localeCompare(a.date)) || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));

  // LOANS: write today's new TOTAL PAID + REMAINING BAL. into each affected
  // row. Multiple withholdings against the same loan (split shift, etc.)
  // collapse to one final cell update via the keyed map.
  const finalCellByRow = new Map<number, { totalPaid: number; remainingBalance: number }>();
  for (const u of loanCellUpdates) finalCellByRow.set(u.rowNumber, { totalPaid: u.totalPaid, remainingBalance: u.remainingBalance });

  if (args.dryRun) {
    console.error(`[dry-run] skipping sheet writes: GARNISHMENTS PAYOUTS=${rewrittenGarnishmentPayoutRows.length} rows, LOAN PAYMENTS=${rewrittenLoanPayments.length} rows, LOANS cell updates=${finalCellByRow.size}`);
  } else {
    rewriteGarnishmentPayoutSheet(args.garnishmentsSheetId, args.account, rewrittenGarnishmentPayoutRows);
    rewriteLoanPaymentsSheet(args.garnishmentsSheetId, args.account, rewrittenLoanPayments);
    for (const [rowNumber, vals] of finalCellByRow) {
      updateLoanCellsForRow(args.garnishmentsSheetId, args.account, rowNumber, vals.totalPaid, vals.remainingBalance);
    }
  }

  // Build per-location aggregates for the BRANCH MASTER daily tab.
  //   - YOT column = sum of bankToBankAmount (signed) for ALL stylists at
  //     the location from the cashout report — i.e., commission already
  //     net of any -negative- bank-to-bank entries.
  //   - BRANCH column = sum of exportRows.amount for the location (already
  //     net of garnishment + loan withholding). For locations with
  //     negative-bankToBank stylists, this naturally equals
  //     `yotPerLocation + |negatives|` because we now emit a positive-
  //     amount disbursement row for each negative stylist.
  //   - BRANCH NOTES = per-loan annotations ("WH $X LOAN FIRSTNAME").
  //   - YOT NOTES = per-rebate annotations ("FIRSTNAME OWED $X").
  const branchMasterTemplate = loadBranchMasterTemplate(args.sheetId, args.account);
  const branchMasterTabName = formatDailyTabName(args.date);

  type PerLocAgg = DailyTabLocationAggregate;
  const perLocation = new Map<string, PerLocAgg>();
  const ensureAgg = (key: string): PerLocAgg => {
    let agg = perLocation.get(key);
    if (!agg) {
      agg = { branchAmount: 0, branchNotes: '', yotAmount: 0, yotNotes: '' };
      perLocation.set(key, agg);
    }
    return agg;
  };

  // YOT side: aggregate signed bankToBank across ALL report rows. Use the
  // YOT-reported location (normalized) so locations not in CSV MASTER still
  // get a number on the daily tab if they appear in the template.
  for (const yotRow of report.rows) {
    const key = normalizeLocation(yotRow.locationName);
    if (!key) continue;
    const agg = ensureAgg(key);
    agg.yotAmount = Number((agg.yotAmount + (yotRow.bankToBankAmount ?? 0)).toFixed(2));
  }
  // YOT NOTES from rebates (matched + unmatched alike).
  const yotNotesByKey = new Map<string, string[]>();
  for (const r of negativeRebates) {
    const key = normalizeLocation(r.locationName);
    if (!key) continue;
    const first = (r.staffName.split(' ')[0] || '').toUpperCase();
    const note = `${first} OWED $${r.rebateAmount.toFixed(2)}`;
    const arr = yotNotesByKey.get(key) || [];
    arr.push(note);
    yotNotesByKey.set(key, arr);
  }
  for (const [key, notes] of yotNotesByKey) {
    ensureAgg(key).yotNotes = joinNotes(notes);
  }

  // BRANCH side: aggregate ALL exportRows.amount (positives + rebate
  // rows). BRANCH per location matches the disbursements CSV per-location
  // subtotal — what Branch actually pays out for the day.
  //
  // Policy note (2026-05-21): RJ chose this over "positives-only" so the
  // operator can reconcile BRANCH against the CSV directly. If this gets
  // flipped back, the only change needed is `if (r.isRebate) continue;`
  // in this loop — the isRebate field is preserved on ExportRow.
  const branchNotesByKey = new Map<string, string[]>();
  const exportRowLocByStaff = new Map<string, string>();
  for (const r of exportRows) {
    exportRowLocByStaff.set(r.staffId, r.location);
    const key = normalizeLocation(r.location);
    if (!key) continue;
    const agg = ensureAgg(key);
    agg.branchAmount = Number((agg.branchAmount + r.amount).toFixed(2));
  }
  // BRANCH NOTES: one line per loan withholding this run ("WH $50 LOAN
  // FIRSTNAME"), looking up the stylist's deposit location via the export
  // row. Matches the format the operator has been writing manually on
  // daily tabs.
  for (const p of loanPaymentsThisRun) {
    const loc = exportRowLocByStaff.get(p.staffId);
    if (!loc) continue;
    const key = normalizeLocation(loc);
    if (!key) continue;
    const first = (p.firstName.split(' ')[0] || '').toUpperCase();
    const note = `WH $${p.withholding.toFixed(2)} LOAN ${first}`;
    const arr = branchNotesByKey.get(key) || [];
    arr.push(note);
    branchNotesByKey.set(key, arr);
  }
  // Same shape for garnishments ("GARN $26.75 FIRSTNAME"). Garnishment
  // rows carry their own `location` (set to the matched CSV MASTER
  // location upstream), so we don't need the exportRowLocByStaff lookup
  // — but fall back to it for robustness in case a future change drops
  // the location field.
  for (const g of garnishmentPayoutRows) {
    const loc = g.location || exportRowLocByStaff.get(g.staffId);
    if (!loc) continue;
    const key = normalizeLocation(loc);
    if (!key) continue;
    const first = (g.firstName.split(' ')[0] || '').toUpperCase();
    const note = `GARN $${g.amount.toFixed(2)} ${first}`;
    const arr = branchNotesByKey.get(key) || [];
    arr.push(note);
    branchNotesByKey.set(key, arr);
  }
  for (const [key, notes] of branchNotesByKey) {
    ensureAgg(key).branchNotes = joinNotes(notes);
  }

  // Materialize an ordered, template-aligned view for diagnostics + write.
  // Lookup: combine every per-location aggregate whose key equals the
  // template label's normalized form OR starts with `${label} ` (so
  // "Sterling" picks up both 'sterling' from CSV-MASTER-derived BRANCH
  // amounts AND 'sterling warren' from the YOT report). Same combine
  // applies to BRANCH and YOT note strings.
  const findAggForLabel = (label: string): PerLocAgg | undefined => {
    const key = normalizeLocation(label);
    if (!key) return undefined;
    let found = false;
    const combined: PerLocAgg = { branchAmount: 0, branchNotes: '', yotAmount: 0, yotNotes: '' };
    const branchNoteParts: string[] = [];
    const yotNoteParts: string[] = [];
    for (const [k, v] of perLocation) {
      if (k === key || k.startsWith(`${key} `)) {
        found = true;
        combined.branchAmount = Number((combined.branchAmount + v.branchAmount).toFixed(2));
        combined.yotAmount = Number((combined.yotAmount + v.yotAmount).toFixed(2));
        if (v.branchNotes) branchNoteParts.push(v.branchNotes);
        if (v.yotNotes) yotNoteParts.push(v.yotNotes);
      }
    }
    if (!found) return undefined;
    combined.branchNotes = joinNotes(branchNoteParts);
    combined.yotNotes = joinNotes(yotNoteParts);
    return combined;
  };
  const branchMasterPerLocation = branchMasterTemplate.locationLabels.map((label) => {
    const agg = findAggForLabel(label);
    return {
      location: label,
      branchAmount: agg?.branchAmount ?? 0,
      branchNotes: agg?.branchNotes || '',
      yotAmount: agg?.yotAmount ?? 0,
      yotNotes: agg?.yotNotes || '',
    };
  });

  if (args.dryRun) {
    console.error(`[dry-run] skipping BRANCH MASTER daily tab write: would delete + recreate '${branchMasterTabName}' on sheet ${args.sheetId} with ${branchMasterPerLocation.length} locations`);
  } else {
    deleteTabIfExists(args.sheetId, args.account, branchMasterTabName);
    addTab(args.sheetId, args.account, branchMasterTabName);
    writeDailyTabContent({
      spreadsheetId: args.sheetId,
      account: args.account,
      tabName: branchMasterTabName,
      template: branchMasterTemplate,
      resolved: branchMasterPerLocation,
      date: args.date,
    });
    // Move the new tab to position `branchMasterIndex + 1` so the most
    // recent daily tab sits immediately to the right of BRANCH MASTER and
    // the rest of the daily tabs shift down (matches the operator's
    // historical ordering: newest day on the left of the daily block).
    // Best-effort — log a warning and continue if anything fails; the tab
    // is already created with correct content.
    try {
      const info = gogJsonForAccount(args.account, ['sheets', 'metadata', args.sheetId]);
      const sheets: any[] = info?.sheets || [];
      const newTab = sheets.find((s) => s?.properties?.title === branchMasterTabName);
      const branchMaster = sheets.find((s) => s?.properties?.title === BRANCH_MASTER_TAB);
      if (newTab && branchMaster) {
        await moveTabToIndex({
          spreadsheetId: args.sheetId,
          account: args.account,
          sheetId: Number(newTab.properties.sheetId),
          newIndex: Number(branchMaster.properties.index) + 1,
        });
      }
    } catch (err: any) {
      console.error(`[warn] failed to reposition '${branchMasterTabName}' tab (manual drag required): ${err?.message || err}`);
    }
  }

  const csvPath = path.join(args.outputDir, `branch-deposits-${args.date}.csv`);
  const diagnosticsPath = path.join(args.outputDir, `branch-deposits-${args.date}.diagnostics.json`);
  const disbursementsPath = path.join(args.outputDir, `disbursements-${args.date}.csv`);

  writeFileSync(csvPath, toCsv(exportRows), 'utf8');
  writeFileSync(disbursementsPath, toDisbursementsCsv(exportRows, args.date), 'utf8');
  writeFileSync(diagnosticsPath, JSON.stringify({
    date: args.date,
    source: 'csv-master',
    sourceLabel: CSV_MASTER_TAB,
    generatedAt: new Date().toISOString(),
    reportRowCount: report.rows.length,
    masterRowCount: masterRows.length,
    exportRowCount: exportRows.length,
    reportRowsWithPositiveAmountButNoBranchMatch: unmatchedReport,
    fuzzyMatchedRows,
    garnishmentRuleCount: garnishmentRules.size,
    garnishmentAdjustedRowCount: garnishmentPayoutRows.length,
    garnishmentPayoutRows,
    loanRuleCount: activeLoans.length,
    loanWithholdingCount: loanPaymentsThisRun.length,
    loanPaymentRows: loanPaymentsThisRun,
    loansPaidOffToday,
    branchMasterTabName,
    branchMasterPerLocation,
    negativeRebates,
  } satisfies MatchDiagnostics, null, 2), 'utf8');

  const typoRows = fuzzyMatchedRows.filter((r) => r.matchKind === 'typo');
  const inScopeUnmatchedRows = unmatchedReport.filter((r) => r.inScope);
  const unmatchedInScope = inScopeUnmatchedRows.length;
  const unmatchedOutOfScope = unmatchedReport.length - unmatchedInScope;
  const watchdogEmailSection = buildWatchdogEmailSection({
    typoRows,
    inScopeUnmatched: inScopeUnmatchedRows,
    loansPaidOff: loansPaidOffToday,
  });

  // Email the disbursements CSV to Miranda (or wherever --test-recipient
  // redirects). Suppressed on dry-run or --skip-email. Failure is logged but
  // doesn't fail the whole export — the CSV is still on disk and the
  // watchdog can surface any issues.
  const recipient = args.testRecipient || DEFAULT_DISPURSEMENTS_RECIPIENT;
  const totalAmount = exportRows.reduce((s, r) => s + r.amount, 0);
  const subject = `HMX Disbursements ${args.date} — ${exportRows.length} deposits, $${totalAmount.toFixed(2)}`;
  const body = `Disbursements file for ${args.date} is attached.

  Deposits: ${exportRows.length}
  Total: $${totalAmount.toFixed(2)}
  Garnishments applied: ${garnishmentPayoutRows.length}
  Loan withholdings: ${loanPaymentsThisRun.length}${loansPaidOffToday.length ? `
  Loans paid off today: ${loansPaidOffToday.length}` : ''}

Sourced from CSV MASTER on the Branch Daily Totals sheet, with garnishment + loan deductions already applied. Auto-generated by the nightly Branch deposit export.${watchdogEmailSection}`;

  let emailStatus: 'sent' | 'skipped' | 'failed' = 'skipped';
  let failureAlertStatus: 'sent' | 'skipped' | 'failed' | 'not-needed' = 'not-needed';
  if (args.dryRun || args.skipEmail) {
    console.error(`[${args.dryRun ? 'dry-run' : 'skip-email'}] would email ${disbursementsPath} to ${recipient}: ${subject}`);
  } else {
    try {
      emailDisbursementsCsv(disbursementsPath, args.account, recipient, subject, body);
      emailStatus = 'sent';
    } catch (err: any) {
      emailStatus = 'failed';
      const errMsg = err?.message || String(err);
      console.error(`disbursements email to ${recipient} failed: ${errMsg}`);
      const delivered = sendDisbursementsFailureAlert(args.account, recipient, args.date, disbursementsPath, errMsg);
      failureAlertStatus = delivered ? 'sent' : (recipient === DISPURSEMENTS_FAILURE_ALERT_TO ? 'skipped' : 'failed');
    }
  }

  console.log(JSON.stringify({
    ok: true,
    date: args.date,
    source: 'csv-master',
    sourceLabel: CSV_MASTER_TAB,
    csvPath,
    diagnosticsPath,
    disbursementsPath,
    disbursementsRecipient: recipient,
    disbursementsEmailStatus: emailStatus,
    disbursementsFailureAlertStatus: failureAlertStatus,
    exportRowCount: exportRows.length,
    masterRowCount: masterRows.length,
    supportedLocationCount: supportedLocations.size,
    unmatchedPositiveReportRowCount: unmatchedReport.length,
    unmatchedInScopeCount: unmatchedInScope,
    unmatchedOutOfScopeCount: unmatchedOutOfScope,
    fuzzyMatchedRowCount: fuzzyMatchedRows.length,
    garnishmentRuleCount: garnishmentRules.size,
    garnishmentAdjustedRowCount: garnishmentPayoutRows.length,
    loanRuleCount: activeLoans.length,
    loanWithholdingCount: loanPaymentsThisRun.length,
    loansPaidOffTodayCount: loansPaidOffToday.length,
    branchMasterTabName,
    negativeRebateCount: negativeRebates.length,
    negativeRebateMatchedCount: negativeRebates.filter((r) => r.matched).length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
