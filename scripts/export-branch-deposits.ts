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
//   - the group's roster tab on the Branch Daily Totals sheet → roster of
//     staff known to Branch (staffId, first, last, location). Which tab is
//     selected by --group (default corp → "CORP CSV MASTER"); see
//     src/disbursements/group-config.ts.
//
// We iterate YOT positives and look each up in CSV MASTER. A match emits
// an export row with the YOT bank-to-bank amount minus any garnishment;
// the transaction id is rebuilt in the format Branch has been receiving
// (<LastName><StaffId><AmountInteger><M/D/YYYY><Location>). When YOT pays
// someone
// who isn't on CSV MASTER, the watchdog appends a placeholder row to the
// sheet and emails RJ.
//
// Per-day tabs: the BRANCH MASTER daily tab (Branch Daily Totals sheet) and
// a CSV mirror tab (Branch DISPURSEMENTS sheet) are both recreated per run,
// named M/D/YY. The mirror tab carries the group's dispursementsTabPrefix
// (empty for corp) so groups that keep both on ONE spreadsheet don't have
// the second write delete the first write's tab.

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { runStaffCashoutReport } from '../src/reports/run-staff-cashout';
import type { StaffCashoutRow } from '../src/reports/reports/staff-cashout';
import * as sheetsApi from '../src/sheets/google-sheets';
import { sendGmail } from '../src/mail/google-mailer';
import { normalizeLocation, normalizeText } from '../src/disbursements/normalize';
import { otherGroupConfigs, resolveGroupConfig, type DisbursementGroupConfig } from '../src/disbursements/group-config';
import { findRosterCollisions, type RosterCollision, type RosterEntry } from '../src/disbursements/roster-collisions';

type Args = {
  date: string;
  teamId: string;
  organisationId: number;
  /** Which distribution group this run serves. Selects roster tab,
   *  spreadsheets, recipients, filenames, and garnishment/loan flags. */
  group: DisbursementGroupConfig;
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
  groupId: string;
  crossGroupCollisions: RosterCollision[];
  /** 'failed' means the other group's roster could not be read this run, so
   *  the collision list is empty by degradation, not by absence of overlap. */
  crossGroupCollisionCheckStatus: 'ok' | 'failed';
  generatedAt: string;
  reportRowCount: number;
  masterRowCount: number;
  exportRowCount: number;
  // Stylists dropped from the CSVs because deductions took their net
  // payout to $0 — kept here (and flagged in the email) for visibility.
  zeroNetOmittedRows: ExportRow[];
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
  // Delivery outcome — lets the watchdog tell a real, sent run apart from a
  // dry-run or a failed/skipped send. A dry-run leaves identical CSV +
  // diagnostics files on disk but never emails Miranda or writes the live
  // sheets, so without these fields a stale dry-run masks a missed send.
  dryRun: boolean;
  skipEmail: boolean;
  disbursementsRecipient: string;
  disbursementsEmailStatus: 'sent' | 'skipped' | 'failed';
  disbursementsFailureAlertStatus: 'sent' | 'skipped' | 'failed' | 'not-needed';
  dispursementsTabStatus: 'written' | 'failed' | 'skipped-dry-run';
};

const DEFAULT_GARNISHMENTS_SHEET_ID = '1pvwN3h0X9ZsdhpH024zue9DlE4NaZiuzTia5NMoEn6c';
const DEFAULT_ACCOUNT = 'govna.assistant@gmail.com';
const DEFAULT_TEAM_ID = 'hmx-marketing-team';
const DEFAULT_ORGANISATION_ID = 11082;
const DEFAULT_OUTPUT_DIR = '/Users/hairmx/hmx-reports';
const NEW_YORK_TZ = 'America/New_York';
// Template tab on each group's daily-totals sheet. Holds two side-by-side
// tables (BRANCH at cols A-C, YOT at cols E-G) keyed by location name in
// the group's location rows plus a TOTAL row. We read it once per run to
// learn the location list + TOTAL formula shape, then write a fresh per-day
// copy. The row geometry lives in the group config (branchMaster*Row).
const BRANCH_MASTER_TAB = 'BRANCH MASTER';
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

  const group = resolveGroupConfig(map.get('group'));

  return {
    date,
    teamId: map.get('teamId') || DEFAULT_TEAM_ID,
    organisationId,
    group,
    // The spreadsheet holding BRANCH MASTER + the per-day BRANCH MASTER tabs.
    // Defaults to the group's daily-totals sheet (for corp that is the same
    // id this flag has always defaulted to); --sheetId still overrides.
    // NOTE: --sheetId no longer redirects the roster read. The roster always
    // comes from args.group.rosterSheetId / rosterTab, so pointing --sheetId
    // at a scratch copy redirects only the BRANCH MASTER template read and
    // the per-day tab writes — the roster is still read from the live sheet.
    sheetId: map.get('sheetId') || group.dailyTotalsSheetId,
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
  // The running group's roster tab. Named explicitly in the prose so an
  // hmx-group run never tells the operator to add a stylist to CORP's
  // roster — doing so would create a cross-roster collision and get that
  // stylist excluded from BOTH groups' payouts.
  rosterTab: string;
}): string {
  const sections: string[] = [];
  const roster = args.rosterTab;

  if (args.typoRows.length) {
    const lines = args.typoRows.map((r) => `- ${roster} row ${r.csvMasterRowNumber} has "${r.csvMasterName}"; YOT has "${r.reportName}" (${r.locationName || '?'}). The export paid them via fuzzy match. Please fix the spelling on ${roster}.`);
    sections.push(`${roster} spelling drift vs YOT:\n${lines.join('\n')}`);
  }

  if (args.inScopeUnmatched.length) {
    const lines = args.inScopeUnmatched.map((r) => `- ${r.staffName || '?'} @ ${r.locationName || '?'} earned $${r.bankToBankAmount} today (YOT bank-to-bank). They aren't on ${roster}, so they were not in tonight's deposit CSV. Action: pay them manually for today's amount, then add them to ${roster} (with their Branch STAFF ID) so tomorrow's export covers them.`);
    sections.push(`Missing from ${roster} (manual payout for today):\n${lines.join('\n')}`);
  }

  if (args.loansPaidOff.length) {
    const lines = args.loansPaidOff.map((l) => `- ${l.firstName} ${l.lastName} (staff id ${l.staffId}) finished a $${l.totalAmount.toFixed(2)} loan today (LOANS row ${l.loanRow}). Archive the row to a "PAID …" tab when convenient.`);
    sections.push(`Loans paid off today:\n${lines.join('\n')}`);
  }

  if (!sections.length) return '';
  return `\n\nWatchdog messages:\n${sections.join('\n\n')}`;
}

async function emailDisbursementsCsv(filePath: string, account: string, recipients: string | string[], subject: string, body: string): Promise<void> {
  await sendGmail({
    from: account,
    to: recipients,
    subject,
    text: body,
    attachments: [{ filename: path.basename(filePath), path: filePath }],
  });
}

// Fallback path: when the disbursements email to the configured recipient
// fails (auth expired, attachment too big, address bounces, etc.), we
// notify RJ directly so the failure doesn't get buried in cron stdout.
// Returns whether the fallback itself delivered — both `false` outcomes
// (e.g., gog auth entirely broken) just end up in stderr.
async function sendDisbursementsFailureAlert(
  account: string,
  intendedRecipient: string,
  date: string,
  disbursementsPath: string,
  errorMessage: string,
  emailSubjectPrefix: string,
): Promise<boolean> {
  if (intendedRecipient === DISPURSEMENTS_FAILURE_ALERT_TO) {
    // Don't alert RJ that the email to RJ failed — they'll just see stdout.
    return false;
  }
  const subject = `[${emailSubjectPrefix}] Disbursements email to ${intendedRecipient} FAILED for ${date}`;
  const body = `The nightly disbursements email failed to deliver to ${intendedRecipient}.

Date: ${date}
Error: ${errorMessage}

The CSV is still on disk:
  ${disbursementsPath}

To re-run the whole export (idempotent on sheet writes):
  cd ~/kitchen-plugin-yot && npx tsx scripts/export-branch-deposits.ts --date=${date}
`;
  try {
    await sendGmail({
      from: account,
      to: DISPURSEMENTS_FAILURE_ALERT_TO,
      subject,
      text: body,
    });
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

// Branch's TRANSACTION ID convention: lastName + staffId + integer amount
// (truncated, not rounded — matches what operators typed historically)
// + payout date + location. The date used to be the literal "12/30/1899"
// (Sheets' epoch placeholder copied from the old hand-maintained tabs),
// which made the id collide whenever the same stylist netted the same
// whole-dollar amount again — Branch rejects duplicate transaction ids.
// The real payout date (same M/D/YYYY shape) fixes cross-day collisions;
// the location (spaces stripped) fixes same-day split-shift collisions
// where one stylist deposits at two shops.
function buildTransactionId(lastName: string, staffId: string, amount: number, dateIso: string, location: string): string {
  return `${lastName}${staffId}${Math.floor(amount)}${formatTransactionDate(dateIso)}${location.replace(/\s+/g, '')}`;
}

// M/D/YYYY (no zero-padding, four-digit year) — same shape as the old
// "12/30/1899" literal the ids carried before the date was real.
function formatTransactionDate(dateIso: string): string {
  const m = dateIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid ISO date: ${dateIso}`);
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
}

async function loadCsvMasterRows(sheetId: string, tabName: string, _account: string): Promise<MasterRow[]> {
  // FORMATTED_VALUE preserves the cell's display string — critical for
  // staff IDs typed with leading zeros (e.g. "0731" for Miranda Bender)
  // which UNFORMATTED_VALUE would return as the number 731 and silently
  // drop the leading zero on the way into the export CSV.
  const values = await sheetsApi.getValues(sheetId, `'${tabName}'!A1:G500`);
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

async function loadGarnishmentRules(sheetId: string, _account: string): Promise<Map<string, GarnishmentRule>> {
  const rows = await sheetsApi.getValues(sheetId, 'GARNISHMENTS!A1:H1200');
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

async function loadExistingGarnishmentPayoutRows(sheetId: string, _account: string): Promise<GarnishmentPayoutRow[]> {
  const rows = await sheetsApi.getValues(sheetId, `'GARNISHMENTS PAYOUTS'!A1:H1200`);
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

async function rewriteGarnishmentPayoutSheet(sheetId: string, _account: string, rows: GarnishmentPayoutRow[]) {
  const values = toSheetValues(rows);
  await sheetsApi.clearValues(sheetId, `'GARNISHMENTS PAYOUTS'!A:Z`);
  await sheetsApi.updateValues(sheetId, `'GARNISHMENTS PAYOUTS'!A1:H${Math.max(rows.length + 1, 1)}`, values, 'USER_ENTERED');
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

async function loadActiveLoans(sheetId: string, _account: string): Promise<Loan[]> {
  const values = await sheetsApi.getValues(sheetId, `'LOANS'!A1:J500`);
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

async function loadExistingLoanPayments(sheetId: string, _account: string): Promise<LoanPaymentRow[]> {
  const values = await sheetsApi.getValues(sheetId, `'LOAN PAYMENTS'!A1:I1200`);
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

async function rewriteLoanPaymentsSheet(sheetId: string, _account: string, rows: LoanPaymentRow[]) {
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
  await sheetsApi.clearValues(sheetId, `'LOAN PAYMENTS'!A:Z`);
  await sheetsApi.updateValues(sheetId, `'LOAN PAYMENTS'!A1:I${Math.max(values.length, 1)}`, values, 'USER_ENTERED');
}

// Writes one loan's TOTAL PAID (col H) + REMAINING BAL. (col J) back to the
// LOANS sheet. Per-row writes — we expect a handful of affected rows per
// run (~10 active loans max), so the chattiness is fine.
async function updateLoanCellsForRow(sheetId: string, _account: string, rowNumber: number, totalPaid: number, remainingBalance: number) {
  await sheetsApi.updateValues(sheetId, `'LOANS'!H${rowNumber}`, [[`$${totalPaid.toFixed(2)}`]], 'USER_ENTERED');
  await sheetsApi.updateValues(sheetId, `'LOANS'!J${rowNumber}`, [[`$${remainingBalance.toFixed(2)}`]], 'USER_ENTERED');
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

async function loadBranchMasterTemplate(sheetId: string, cfg: DisbursementGroupConfig, _account: string): Promise<BranchMasterTemplate> {
  const values = await sheetsApi.getValues(sheetId, `'${BRANCH_MASTER_TAB}'!A1:G${cfg.branchMasterTotalRow}`);
  const header = values[1] || [];
  const locationLabels: string[] = [];
  for (let r = cfg.branchMasterFirstLocationRow - 1; r <= cfg.branchMasterLastLocationRow - 1; r++) {
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

async function getSheetIdByTitle(spreadsheetId: string, _account: string, title: string): Promise<number | null> {
  return sheetsApi.sheetIdByTitle(spreadsheetId, title);
}

async function deleteTabIfExists(spreadsheetId: string, account: string, title: string): Promise<void> {
  const id = await getSheetIdByTitle(spreadsheetId, account, title);
  if (id == null) return;
  await sheetsApi.deleteTab(spreadsheetId, id);
}

async function addTab(spreadsheetId: string, _account: string, title: string): Promise<number> {
  return sheetsApi.addTab(spreadsheetId, title);
}

// Reorder a freshly-created tab. The service account calls the Sheets API's
// batchUpdate directly — no more refresh-token export / OAuth exchange.
async function moveTabToIndex(args: {
  spreadsheetId: string;
  account: string;
  sheetId: number;
  newIndex: number;
}): Promise<void> {
  await sheetsApi.moveTab(args.spreadsheetId, args.sheetId, args.newIndex);
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

async function writeDailyTabContent(args: {
  spreadsheetId: string;
  account: string;
  tabName: string;
  template: BranchMasterTemplate;
  resolved: ResolvedLocationRow[];
  date: string;
  cfg: DisbursementGroupConfig;
}): Promise<void> {
  const { spreadsheetId, tabName, template, resolved, date, cfg } = args;
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
  // Blank spacer rows between the last location row and TOTAL (preserve
  // template shape).
  while (grid.length < cfg.branchMasterTotalRow - 1) {
    grid.push(['', '', '', '', '', '', '']);
  }
  // TOTAL row with SUM formulas matching the template.
  const sumRangeBranch = `B${cfg.branchMasterFirstLocationRow}:B${cfg.branchMasterLastLocationRow}`;
  const sumRangeYot = `F${cfg.branchMasterFirstLocationRow}:F${cfg.branchMasterLastLocationRow}`;
  grid.push(['', 'TOTAL', `=SUM(${sumRangeBranch})`, '', '', 'TOTAL', `=SUM(${sumRangeYot})`]);

  await sheetsApi.updateValues(spreadsheetId, `'${tabName}'!A1:G${cfg.branchMasterTotalRow}`, grid, 'USER_ENTERED');
}

// Mirrors the disbursements CSV onto a per-day tab ("M/D/YY") on the Branch
// DISPURSEMENTS sheet — same rows, same column order as the CSV BLANK MASTER
// template. The operator maintained these tabs by hand through 5/19/26; this
// resumes them automatically. Delete + recreate makes re-runs idempotent
// (same pattern as the BRANCH MASTER daily tab). RAW input keeps
// leading-zero staff ids (e.g. "0731") as text instead of letting Sheets
// coerce them to numbers and drop the zero.
async function writeDispursementsDailyTab(args: {
  spreadsheetId: string;
  templateTab: string;
  account: string;
  tabName: string;
  rows: ExportRow[];
  date: string;
}): Promise<void> {
  const { spreadsheetId, templateTab } = args;
  const disbursementDate = nextDayIso(args.date);
  const values: (string | number)[][] = [
    ['ID', 'First Name', 'Last Name', 'Type', 'Amount', 'Transaction ID', 'Location', 'Disbursement Date (YYYY-MM-DD)', 'Description'],
    ...args.rows.map((row) => [
      row.staffId,
      row.firstName,
      row.lastName,
      row.type,
      row.amount,
      row.transactionId,
      row.location,
      disbursementDate,
      '',
    ]),
  ];
  await deleteTabIfExists(spreadsheetId, args.account, args.tabName);
  await addTab(spreadsheetId, args.account, args.tabName);
  await sheetsApi.updateValues(spreadsheetId, `'${args.tabName}'!A1:I${values.length}`, values, 'RAW');
  // Position right of the CSV BLANK MASTER template (newest day first),
  // matching where the operator kept the hand-made daily tabs. Best-effort —
  // the tab already has correct content if the move fails.
  try {
    const tabs = await sheetsApi.listTabs(spreadsheetId);
    const newTab = tabs.find((t) => t.title === args.tabName);
    const template = tabs.find((t) => t.title === templateTab);
    if (newTab && template) {
      await moveTabToIndex({
        spreadsheetId,
        account: args.account,
        sheetId: newTab.sheetId,
        newIndex: template.index + 1,
      });
    }
  } catch (err: any) {
    console.error(`[warn] failed to reposition '${args.tabName}' tab on Branch DISPURSEMENTS (manual drag required): ${err?.message || err}`);
  }
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
  const masterRows = await loadCsvMasterRows(args.group.rosterSheetId, args.group.rosterTab, args.account);
  const garnishmentRules = args.group.garnishmentsEnabled
    ? await loadGarnishmentRules(args.garnishmentsSheetId, args.account)
    : new Map<string, GarnishmentRule>();
  const activeLoans = args.group.loansEnabled
    ? await loadActiveLoans(args.garnishmentsSheetId, args.account)
    : [];
  const existingLoanPayments = args.group.loansEnabled
    ? await loadExistingLoanPayments(args.garnishmentsSheetId, args.account)
    : [];
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

  // Cross-roster safety: a stylist on two groups' rosters would be paid by
  // both nightly runs. Exclude them here and surface them in diagnostics +
  // the watchdog email so a human resolves the ambiguity. Never abort — that
  // would stop payroll for everyone correctly rostered.
  const ownRoster: RosterEntry[] = masterRows.map((r) => ({
    staffId: r.staffId, firstName: r.firstName, lastName: r.lastName, location: r.location,
  }));
  const crossGroupCollisions: RosterCollision[] = [];
  // Fail open. This read touches a tab THIS run does not otherwise depend on
  // (the other group's roster); a rename, a permissions change, or a
  // transient Sheets error must not stop payroll for everyone on our own
  // roster. On failure we proceed with no collisions and record the degraded
  // state in diagnostics so the watchdog/operator can see the check was skipped.
  let crossGroupCollisionCheckStatus: 'ok' | 'failed' = 'ok';
  try {
    for (const other of otherGroupConfigs(args.group.id)) {
      const otherRows = await loadCsvMasterRows(other.rosterSheetId, other.rosterTab, args.account);
      crossGroupCollisions.push(...findRosterCollisions(ownRoster, otherRows.map((r) => ({
        staffId: r.staffId, firstName: r.firstName, lastName: r.lastName, location: r.location,
      }))));
    }
  } catch (err: any) {
    crossGroupCollisionCheckStatus = 'failed';
    crossGroupCollisions.length = 0;
    console.error(`[warn] cross-roster collision check failed: ${err?.message || err} — proceeding without it`);
  }
  const collidingStaffIds = new Set(crossGroupCollisions.filter((c) => c.kind === 'staff-id').map((c) => c.value));
  const collidingLocations = new Set(crossGroupCollisions.filter((c) => c.kind === 'location').map((c) => c.value));
  for (const c of crossGroupCollisions) console.error(`[collision] ${c.detail}`);

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
  // Tracks stylists whose bankToBank was negative for the day — the
  // stylist OWES the shop that amount (e.g. rebate/void absorbed by the
  // shop on their behalf). Drives the BRANCH MASTER daily tab YOT NOTES
  // ("FIRSTNAME OWES $X") only — we do NOT emit a disbursement row,
  // garnishment, or loan withholding, since there is no payment going
  // out to act on. Recovery of the obligation happens outside this
  // pipeline.
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
        // Tracked in negativeRebates instead of unmatchedReport — there's
        // no positive payment to chase, so the watchdog's "pay manually"
        // alert doesn't apply. YOT NOTES on the BRANCH MASTER daily tab
        // will still annotate the obligation.
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

    // Cross-roster exclusion. Placed here — as soon as the stylist is
    // identified — rather than just before exportRows.push, so a colliding
    // stylist produces NO side effects at all: no loan withholding recorded
    // against their LOANS row, no LOAN PAYMENTS row, no garnishment payout
    // row. Skipping later would deduct from a deposit that never gets paid.
    // Consequence of skipping this early: a colliding stylist with a negative
    // bank-to-bank amount also loses their "FIRSTNAME OWES $X" YOT NOTES
    // annotation on the BRANCH MASTER daily tab — accepted, since the
    // collision itself is reported and needs manual handling anyway.
    if (collidingStaffIds.has(String(match.row.staffId).trim()) || collidingLocations.has(normalizeLocation(match.row.location))) {
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

    if (isRebate) {
      // Stylist owes the shop $baseAmount. Annotate BRANCH MASTER YOT
      // NOTES only — no disbursement, garnishment, or loan withholding
      // (no payment is going out for those to act on).
      const csvLocation = match.row.location || yotRow.locationName || null;
      negativeRebates.push({
        staffName: `${match.row.firstName} ${match.row.lastName}`.trim() || yotRow.staffName || '?',
        locationName: csvLocation,
        rebateAmount: baseAmount,
        matched: true,
      });
      continue;
    }

    // Use CSV MASTER's location (column G on the Branch Daily Totals
    // sheet) as the canonical location string. YOT's report appends the
    // state abbreviation (e.g. "Brighton MI") which doesn't match the
    // sheet's location field downstream consumers join against.
    // matchedReportLocation keeps the raw YOT string for traceability in
    // the watchdog log; only `location` (the field that flows to the CSV)
    // gets normalized. Hoisted above the loan loop because transaction ids
    // (deposit, garnishment, and loan rows alike) embed the location.
    const csvLocation = match.row.location || yotRow.locationName || '';

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
        transactionId: buildTransactionId(loan.lastName, loan.staffId, actual, args.date, csvLocation),
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
    const transactionId = buildTransactionId(match.row.lastName, match.row.staffId, adjustedAmount, args.date, csvLocation);

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
    });

    if (garnishmentAmount > 0) {
      garnishmentPayoutRows.push({
        staffId: match.row.staffId,
        firstName: match.row.firstName,
        lastName: match.row.lastName,
        type: 'GARNISHMENT',
        amount: garnishmentAmount,
        transactionId: buildTransactionId(match.row.lastName, match.row.staffId, garnishmentAmount, args.date, csvLocation),
        location: csvLocation,
        date: args.date,
      });
    }
  }

  exportRows.sort((a, b) => a.location.localeCompare(b.location) || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));

  const priorGarnishmentPayoutRows = args.group.garnishmentsEnabled
    ? await loadExistingGarnishmentPayoutRows(args.garnishmentsSheetId, args.account)
    : [];
  const existingGarnishmentPayoutRows = priorGarnishmentPayoutRows.filter((row) => row.date !== args.date);
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
    if (args.group.garnishmentsEnabled) {
      await rewriteGarnishmentPayoutSheet(args.garnishmentsSheetId, args.account, rewrittenGarnishmentPayoutRows);
    }
    if (args.group.loansEnabled) {
      await rewriteLoanPaymentsSheet(args.garnishmentsSheetId, args.account, rewrittenLoanPayments);
      for (const [rowNumber, vals] of finalCellByRow) {
        await updateLoanCellsForRow(args.garnishmentsSheetId, args.account, rowNumber, vals.totalPaid, vals.remainingBalance);
      }
    }
  }

  // Build per-location aggregates for the BRANCH MASTER daily tab.
  //   - YOT column = sum of bankToBankAmount (signed) for ALL stylists at
  //     the location from the cashout report — i.e., commission already
  //     net of any -negative- bank-to-bank entries.
  //   - BRANCH column = sum of exportRows.amount for the location (already
  //     net of garnishment + loan withholding). Rebate (negative
  //     bankToBank) stylists do NOT produce an exportRow, so they don't
  //     contribute to BRANCH — they only show up as a YOT NOTES annotation.
  //   - BRANCH NOTES = per-loan annotations ("WH $X LOAN FIRSTNAME").
  //   - YOT NOTES = per-rebate annotations ("FIRSTNAME OWES $X").
  const branchMasterTemplate = await loadBranchMasterTemplate(args.sheetId, args.group, args.account);
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
    const note = `${first} OWES $${r.rebateAmount.toFixed(2)}`;
    const arr = yotNotesByKey.get(key) || [];
    arr.push(note);
    yotNotesByKey.set(key, arr);
  }
  for (const [key, notes] of yotNotesByKey) {
    ensureAgg(key).yotNotes = joinNotes(notes);
  }

  // BRANCH side: aggregate exportRows.amount. exportRows only contains
  // positive-bankToBank stylists (post-deduction), so BRANCH per location
  // matches the disbursements CSV per-location subtotal — what Branch
  // actually pays out for the day. Rebate stylists are tracked in
  // negativeRebates / YOT NOTES only and never reach this loop.
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
    await deleteTabIfExists(args.sheetId, args.account, branchMasterTabName);
    await addTab(args.sheetId, args.account, branchMasterTabName);
    await writeDailyTabContent({
      spreadsheetId: args.sheetId,
      account: args.account,
      tabName: branchMasterTabName,
      template: branchMasterTemplate,
      resolved: branchMasterPerLocation,
      date: args.date,
      cfg: args.group,
    });
    // Move the new tab to position `branchMasterIndex + 1` so the most
    // recent daily tab sits immediately to the right of BRANCH MASTER and
    // the rest of the daily tabs shift down (matches the operator's
    // historical ordering: newest day on the left of the daily block).
    // Best-effort — log a warning and continue if anything fails; the tab
    // is already created with correct content.
    try {
      const tabs = await sheetsApi.listTabs(args.sheetId);
      const newTab = tabs.find((t) => t.title === branchMasterTabName);
      const branchMaster = tabs.find((t) => t.title === BRANCH_MASTER_TAB);
      if (newTab && branchMaster) {
        await moveTabToIndex({
          spreadsheetId: args.sheetId,
          account: args.account,
          sheetId: newTab.sheetId,
          newIndex: branchMaster.index + 1,
        });
      }
    } catch (err: any) {
      console.error(`[warn] failed to reposition '${branchMasterTabName}' tab (manual drag required): ${err?.message || err}`);
    }
  }

  const csvPath = path.join(args.outputDir, `${args.group.filePrefix}branch-deposits-${args.date}.csv`);
  const diagnosticsPath = path.join(args.outputDir, `${args.group.filePrefix}branch-deposits-${args.date}.diagnostics.json`);
  const disbursementsPath = path.join(args.outputDir, `${args.group.filePrefix}disbursements-${args.date}.csv`);

  // Stylists whose net payout hits $0 after garnishment + loan withholding
  // are omitted from both CSVs — Branch shouldn't process a $0 deposit row.
  // They stay in exportRows up to this point so their loan/garnishment
  // BRANCH NOTES still land on the daily tab, and they're called out in the
  // disbursements email + diagnostics so the omission is visible.
  const zeroNetRows = exportRows.filter((r) => r.amount <= 0);
  const depositRows = exportRows.filter((r) => r.amount > 0);

  writeFileSync(csvPath, toCsv(depositRows), 'utf8');
  writeFileSync(disbursementsPath, toDisbursementsCsv(depositRows, args.date), 'utf8');

  // Mirror the disbursements CSV onto a per-day tab on the Branch
  // DISPURSEMENTS sheet. Failure here shouldn't block the email to Miranda
  // — the CSV is already on disk — so log + report status instead of
  // throwing.
  let dispursementsTabStatus: 'written' | 'failed' | 'skipped-dry-run' = 'skipped-dry-run';
  // Prefixed for groups whose CSV-mirror shares a spreadsheet with the
  // BRANCH MASTER daily tabs — writing both under the same M/D/YY name would
  // make the second write delete + recreate the first one's tab.
  const dispursementsTabName = `${args.group.dispursementsTabPrefix}${branchMasterTabName}`;
  if (args.dryRun) {
    console.error(`[dry-run] skipping Branch DISPURSEMENTS daily tab write: would delete + recreate '${dispursementsTabName}' on sheet ${args.group.dispursementsSheetId} with ${depositRows.length} rows`);
  } else {
    try {
      await writeDispursementsDailyTab({
        spreadsheetId: args.group.dispursementsSheetId,
        templateTab: args.group.dispursementsTemplateTab,
        account: args.account,
        tabName: dispursementsTabName,
        rows: depositRows,
        date: args.date,
      });
      dispursementsTabStatus = 'written';
    } catch (err: any) {
      dispursementsTabStatus = 'failed';
      console.error(`[warn] failed to write '${dispursementsTabName}' tab on Branch DISPURSEMENTS: ${err?.message || err}`);
    }
  }
  // NB: the diagnostics JSON is written AFTER the email step below, so it can
  // record the real delivery outcome (disbursementsEmailStatus / dryRun). The
  // watchdog relies on those fields to tell a sent run from a dry-run.

  const typoRows = fuzzyMatchedRows.filter((r) => r.matchKind === 'typo');
  const inScopeUnmatchedRows = unmatchedReport.filter((r) => r.inScope);
  const unmatchedInScope = inScopeUnmatchedRows.length;
  const unmatchedOutOfScope = unmatchedReport.length - unmatchedInScope;
  const watchdogEmailSection = buildWatchdogEmailSection({
    typoRows,
    inScopeUnmatched: inScopeUnmatchedRows,
    loansPaidOff: loansPaidOffToday,
    rosterTab: args.group.rosterTab,
  });

  // Email the disbursements CSV to Miranda (or wherever --test-recipient
  // redirects). Suppressed on dry-run or --skip-email. Failure is logged but
  // doesn't fail the whole export — the CSV is still on disk and the
  // watchdog can surface any issues.
  const recipient = args.testRecipient || args.group.emailTo;
  const sendTo: string | string[] = args.testRecipient ? recipient : [recipient, ...args.group.emailCc];
  const totalAmount = depositRows.reduce((s, r) => s + r.amount, 0);
  // Per-stylist note when deductions zeroed out a payout — Miranda should
  // know the stylist worked but was intentionally left off the CSV.
  const zeroNetEmailSection = zeroNetRows.length ? `

Omitted from the CSV — net $0 after deductions (no deposit to process):
${zeroNetRows.map((r) => {
    const loanWithheld = Number((r.originalAmount - r.garnishmentAmount - r.amount).toFixed(2));
    const parts = [
      r.garnishmentAmount > 0 ? `garnishment $${r.garnishmentAmount.toFixed(2)}` : null,
      loanWithheld > 0 ? `loan withheld $${loanWithheld.toFixed(2)}` : null,
    ].filter(Boolean).join(', ');
    return `- ${r.firstName} ${r.lastName} (${r.location}) — earned $${r.originalAmount.toFixed(2)}; ${parts || 'deductions consumed the full amount'}`;
  }).join('\n')}` : '';
  // Cross-roster collisions silently remove stylists (or a whole location's
  // stylists) from the CSV. Surface them here so the omission is visible in
  // the same email that carries the file, not only in stderr + diagnostics.
  const collisionEmailSection = crossGroupCollisions.length ? `

Excluded — on more than one group's roster (not in this CSV):
${crossGroupCollisions.map((c) => `- ${c.detail}`).join('\n')}
These were excluded to prevent the same person being paid twice on the same night, once by each group's run. They need manual handling: remove the duplicate from whichever roster is wrong, and pay today's amount by hand if it is owed.` : '';
  const subject = `${args.group.emailSubjectPrefix} Disbursements ${args.date} — ${depositRows.length} deposits, $${totalAmount.toFixed(2)}`;
  const body = `Disbursements file for ${args.date} is attached.

  Deposits: ${depositRows.length}
  Total: $${totalAmount.toFixed(2)}
  Garnishments applied: ${garnishmentPayoutRows.length}
  Loan withholdings: ${loanPaymentsThisRun.length}${loansPaidOffToday.length ? `
  Loans paid off today: ${loansPaidOffToday.length}` : ''}${zeroNetRows.length ? `
  Omitted ($0 net after deductions): ${zeroNetRows.length}` : ''}${crossGroupCollisions.length ? `
  Excluded (roster collision): ${crossGroupCollisions.length}` : ''}${zeroNetEmailSection}${collisionEmailSection}

Sourced from ${args.group.rosterTab} on the Branch Daily Totals sheet${args.group.garnishmentsEnabled || args.group.loansEnabled ? ', with garnishment + loan deductions already applied' : ''}. Auto-generated by the nightly Branch deposit export.${watchdogEmailSection}`;

  let emailStatus: 'sent' | 'skipped' | 'failed' = 'skipped';
  let failureAlertStatus: 'sent' | 'skipped' | 'failed' | 'not-needed' = 'not-needed';
  if (args.dryRun || args.skipEmail) {
    const displayRecipients = Array.isArray(sendTo) ? sendTo.join(', ') : sendTo;
    console.error(`[${args.dryRun ? 'dry-run' : 'skip-email'}] would email ${disbursementsPath} to ${displayRecipients}: ${subject}`);
  } else {
    try {
      await emailDisbursementsCsv(disbursementsPath, args.account, sendTo, subject, body);
      emailStatus = 'sent';
    } catch (err: any) {
      emailStatus = 'failed';
      const errMsg = err?.message || String(err);
      console.error(`disbursements email to ${recipient} failed: ${errMsg}`);
      const delivered = await sendDisbursementsFailureAlert(args.account, recipient, args.date, disbursementsPath, errMsg, args.group.emailSubjectPrefix);
      failureAlertStatus = delivered ? 'sent' : (recipient === DISPURSEMENTS_FAILURE_ALERT_TO ? 'skipped' : 'failed');
    }
  }

  // Written last so the delivery outcome (email status, dry-run) is captured.
  writeFileSync(diagnosticsPath, JSON.stringify({
    date: args.date,
    source: 'csv-master',
    sourceLabel: args.group.rosterTab,
    groupId: args.group.id,
    crossGroupCollisions,
    crossGroupCollisionCheckStatus,
    generatedAt: new Date().toISOString(),
    reportRowCount: report.rows.length,
    masterRowCount: masterRows.length,
    exportRowCount: depositRows.length,
    zeroNetOmittedRows: zeroNetRows,
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
    dryRun: args.dryRun,
    skipEmail: args.skipEmail,
    disbursementsRecipient: recipient,
    disbursementsEmailStatus: emailStatus,
    disbursementsFailureAlertStatus: failureAlertStatus,
    dispursementsTabStatus,
  } satisfies MatchDiagnostics, null, 2), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    date: args.date,
    source: 'csv-master',
    sourceLabel: args.group.rosterTab,
    groupId: args.group.id,
    crossGroupCollisionCount: crossGroupCollisions.length,
    crossGroupCollisionCheckStatus,
    csvPath,
    diagnosticsPath,
    disbursementsPath,
    disbursementsRecipient: recipient,
    disbursementsEmailStatus: emailStatus,
    disbursementsFailureAlertStatus: failureAlertStatus,
    exportRowCount: depositRows.length,
    zeroNetOmittedCount: zeroNetRows.length,
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
    dispursementsTabStatus,
    negativeRebateCount: negativeRebates.length,
    negativeRebateMatchedCount: negativeRebates.filter((r) => r.matched).length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
