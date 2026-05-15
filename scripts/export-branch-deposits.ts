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

import { mkdirSync, writeFileSync } from 'node:fs';
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
  // rewrite, LOANS cell updates are all skipped). Useful for verifying
  // a date's behavior against the live sheet state without touching it.
  dryRun: boolean;
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
};

const DEFAULT_SHEET_ID = '1jIFWOMmvMVbGULUbDpEqV2e6CsXy_DzhBrCorV9H-EA';
const DEFAULT_GARNISHMENTS_SHEET_ID = '1pvwN3h0X9ZsdhpH024zue9DlE4NaZiuzTia5NMoEn6c';
const DEFAULT_ACCOUNT = 'govna.assistant@gmail.com';
const DEFAULT_TEAM_ID = 'hmx-marketing-team';
const DEFAULT_ORGANISATION_ID = 11082;
const DEFAULT_OUTPUT_DIR = '/Users/hairmx/hmx-reports';
const NEW_YORK_TZ = 'America/New_York';
const CSV_MASTER_TAB = 'CSV MASTER';

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
    .replace(/\bmi\b|\boh\b|\bpa\b/g, '')
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

function toSheetValues(rows: GarnishmentPayoutRow[]): string[][] {
  return [
    ['STAFF ID', 'FIRST NAME', 'LAST NAME', 'TYPE', 'AMOUNT', 'TRANSACTION ID', 'LOCATION', 'DATE'],
    ...rows.map((row) => [
      row.staffId,
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
  const response = gogJsonForAccount(account, ['sheets', 'get', sheetId, `'${CSV_MASTER_TAB}'!A1:G500`]) as SheetValuesResponse;
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
  const response = gogJsonForAccount(account, ['sheets', 'get', sheetId, 'GARNISHMENTS!A1:H1200']) as SheetValuesResponse;
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
  const response = gogJsonForAccount(account, ['sheets', 'get', sheetId, `'GARNISHMENTS PAYOUTS'!A1:H1200`]) as SheetValuesResponse;
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
  const response = gogJsonForAccount(account, ['sheets', 'get', sheetId, `'LOANS'!A1:J500`]) as SheetValuesResponse;
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
  const response = gogJsonForAccount(account, ['sheets', 'get', sheetId, `'LOAN PAYMENTS'!A1:I1200`]) as SheetValuesResponse;
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
      r.staffId,
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

  for (const yotRow of report.rows) {
    const rawAmount = Number(yotRow.bankToBankAmount || 0);
    if (rawAmount <= 0) continue;

    const match = matchYotRowToMaster(yotRow, masterIndexes);
    if (!match) {
      unmatchedReport.push({
        staffName: yotRow.staffName,
        locationName: yotRow.locationName,
        bankToBankAmount: rawAmount,
        inScope: supportedLocations.has(normalizeLocation(yotRow.locationName)),
      });
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
    const garnishmentAmount = garnishmentPercent ? Number((rawAmount * garnishmentPercent).toFixed(2)) : 0;
    const postGarnishment = Number((rawAmount - garnishmentAmount).toFixed(2));

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

    exportRows.push({
      staffId: match.row.staffId,
      firstName: match.row.firstName,
      lastName: match.row.lastName,
      type: 'Deposit',
      amount: adjustedAmount,
      originalAmount: rawAmount,
      garnishmentPercent,
      garnishmentAmount,
      transactionId,
      location: yotRow.locationName || match.row.location || '',
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
        transactionId: buildTransactionId(match.row.lastName, match.row.staffId, garnishmentAmount),
        location: yotRow.locationName || match.row.location || '',
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

  const csvPath = path.join(args.outputDir, `branch-deposits-${args.date}.csv`);
  const diagnosticsPath = path.join(args.outputDir, `branch-deposits-${args.date}.diagnostics.json`);

  writeFileSync(csvPath, toCsv(exportRows), 'utf8');
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
  } satisfies MatchDiagnostics, null, 2), 'utf8');

  const unmatchedInScope = unmatchedReport.filter((r) => r.inScope).length;
  const unmatchedOutOfScope = unmatchedReport.length - unmatchedInScope;
  console.log(JSON.stringify({
    ok: true,
    date: args.date,
    source: 'csv-master',
    sourceLabel: CSV_MASTER_TAB,
    csvPath,
    diagnosticsPath,
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
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
