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
  account: string;
  outputDir: string;
};

type SheetMetadata = {
  sheets?: Array<{
    properties?: {
      title?: string;
    };
  }>;
};

type SheetValuesResponse = {
  values?: string[][];
};

type BranchDailyRow = {
  staffId: string;
  firstName: string;
  lastName: string;
  type: 'Deposit';
  transactionId: string;
  location: string;
  sourceAmount: string;
};

type ExportRow = {
  staffId: string;
  firstName: string;
  lastName: string;
  type: 'Deposit';
  amount: number;
  transactionId: string;
  location: string;
  matchedReportName: string;
  matchedReportLocation: string | null;
};

type MatchDiagnostics = {
  date: string;
  branchSheetTab: string;
  generatedAt: string;
  reportRowCount: number;
  branchRowCount: number;
  exportRowCount: number;
  unmatchedBranchRows: BranchDailyRow[];
  reportRowsWithPositiveAmountButNoBranchMatch: Array<{
    staffName: string | null;
    locationName: string | null;
    bankToBankAmount: number;
  }>;
  skippedNonPositiveReportMatches: Array<{
    staffId: string;
    firstName: string;
    lastName: string;
    transactionId: string;
    location: string;
    amount: number | null;
  }>;
};

const DEFAULT_SHEET_ID = '1jIFWOMmvMVbGULUbDpEqV2e6CsXy_DzhBrCorV9H-EA';
const DEFAULT_ACCOUNT = 'govna.assistant@gmail.com';
const DEFAULT_TEAM_ID = 'hmx-marketing-team';
const DEFAULT_ORGANISATION_ID = 11082;
const DEFAULT_OUTPUT_DIR = '/Users/hairmx/hmx-reports';
const NEW_YORK_TZ = 'America/New_York';

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
    account: map.get('account') || DEFAULT_ACCOUNT,
    outputDir: expandHome(map.get('outputDir') || DEFAULT_OUTPUT_DIR),
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

function isoToShortUs(dateIso: string): string {
  const [year, month, day] = dateIso.split('-').map(Number);
  return `${month}/${day}/${String(year).slice(-2)}`;
}

function gogJson(args: string[]): any {
  const out = execFileSync('gog', [...args, '--account', DEFAULT_ACCOUNT, '--json', '--no-input'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(out);
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

function fuzzyFirstNameMatch(a: string, b: string): boolean {
  const aa = firstToken(a);
  const bb = firstToken(b);
  if (!aa || !bb) return false;
  return aa === bb || aa.startsWith(bb) || bb.startsWith(aa);
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
      Number.isInteger(row.amount) ? String(row.amount) : String(row.amount),
      row.transactionId,
      row.location,
    ].map(formatCsvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function parseSheetTabDateCandidates(title: string): string[] {
  const clean = title.trim();
  const sameMonthRange = clean.match(/^(\d{1,2})\/(\d{1,2})-(\d{1,2})\/(\d{2,4})$/)
    || clean.match(/^(\d{1,2})\/(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (sameMonthRange) {
    const [, monthRaw, startDayRaw, endDayRaw, yearRaw] = sameMonthRange;
    const month = Number(monthRaw);
    const startDay = Number(startDayRaw);
    const endDay = Number(endDayRaw);
    const year = Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw);
    return rangeDates(year, month, startDay, year, month, endDay);
  }

  const crossMonthRange = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})-(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (crossMonthRange) {
    const [, startMonthRaw, startDayRaw, startYearRaw, endMonthRaw, endDayRaw, endYearRaw] = crossMonthRange;
    const startYear = Number(startYearRaw.length === 2 ? `20${startYearRaw}` : startYearRaw);
    const endYear = Number(endYearRaw.length === 2 ? `20${endYearRaw}` : endYearRaw);
    return rangeDates(startYear, Number(startMonthRaw), Number(startDayRaw), endYear, Number(endMonthRaw), Number(endDayRaw));
  }

  const single = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (single) {
    const [, monthRaw, dayRaw, yearRaw] = single;
    const year = Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw);
    return [isoDate(year, Number(monthRaw), Number(dayRaw))];
  }

  return [];
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function rangeDates(startYear: number, startMonth: number, startDay: number, endYear: number, endMonth: number, endDay: number): string[] {
  const result: string[] = [];
  const cursor = new Date(Date.UTC(startYear, startMonth - 1, startDay));
  const end = new Date(Date.UTC(endYear, endMonth - 1, endDay));
  while (cursor <= end) {
    result.push(isoDate(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate()));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function resolveSheetTabForDate(sheetId: string, account: string, targetDateIso: string): string {
  const metadata = gogJsonForAccount(account, ['sheets', 'metadata', sheetId]) as SheetMetadata;
  const directLabel = isoToShortUs(targetDateIso);
  for (const sheet of metadata.sheets || []) {
    const title = sheet.properties?.title?.trim();
    if (!title) continue;
    if (title === directLabel) return title;
    if (parseSheetTabDateCandidates(title).includes(targetDateIso)) return title;
  }
  throw new Error(`Could not find a Branch Daily Totals tab for ${targetDateIso}`);
}

function parseBranchDailyRows(values: string[][]): BranchDailyRow[] {
  const rows: BranchDailyRow[] = [];
  let currentHeaderLocation = '';
  for (const row of values) {
    const colA = String(row[0] || '').trim();
    const colD = String(row[3] || '').trim();
    if (!colA && !colD) continue;
    if (colA === 'STAFF ID') {
      currentHeaderLocation = String(row[6] || '').trim();
      continue;
    }
    if (colD.toUpperCase() === 'TOTAL') continue;
    if (!colA) continue;

    rows.push({
      staffId: colA,
      firstName: String(row[1] || '').trim(),
      lastName: String(row[2] || '').trim(),
      type: 'Deposit',
      sourceAmount: String(row[4] || '').trim(),
      transactionId: String(row[5] || '').trim(),
      location: String(row[9] || row[6] || currentHeaderLocation || '').trim(),
    });
  }
  return rows;
}

function branchRowQuality(row: BranchDailyRow): number {
  let score = 0;
  if (row.sourceAmount) score += 50;
  if (row.sourceAmount && row.transactionId.includes(row.sourceAmount)) score += 20;
  if (row.transactionId) score += 10;
  if (row.location) score += 5;
  if (row.firstName && row.lastName) score += 2;
  return score;
}

function dedupeBranchRows(rows: BranchDailyRow[]): BranchDailyRow[] {
  const byKey = new Map<string, BranchDailyRow>();
  for (const row of rows) {
    const key = `${row.staffId}|${normalizeLocation(row.location)}`;
    const current = byKey.get(key);
    if (!current || branchRowQuality(row) > branchRowQuality(current)) {
      byKey.set(key, row);
    }
  }

  const deduped = [...byKey.values()];
  const staffIdsWithExplicitAmounts = new Set(
    deduped.filter((row) => row.sourceAmount).map((row) => row.staffId),
  );

  return deduped.filter((row) => !staffIdsWithExplicitAmounts.has(row.staffId) || Boolean(row.sourceAmount));
}

function loadBranchDailyRows(sheetId: string, account: string, tabTitle: string): BranchDailyRow[] {
  const response = gogJsonForAccount(account, ['sheets', 'get', sheetId, `'${tabTitle}'!A1:J1200`]) as SheetValuesResponse;
  return dedupeBranchRows(parseBranchDailyRows(response.values || []));
}

function buildReportIndexes(rows: StaffCashoutRow[]) {
  const byExactName = new Map<string, StaffCashoutRow[]>();
  const byLastName = new Map<string, StaffCashoutRow[]>();

  for (const row of rows) {
    const name = normalizeText(row.staffName);
    if (!name) continue;
    if (!byExactName.has(name)) byExactName.set(name, []);
    byExactName.get(name)!.push(row);

    const split = splitName(row.staffName || '');
    if (split.last) {
      if (!byLastName.has(split.last)) byLastName.set(split.last, []);
      byLastName.get(split.last)!.push(row);
    }
  }

  return { byExactName, byLastName };
}

function scoreReportCandidate(branch: BranchDailyRow, report: StaffCashoutRow): number {
  let score = 0;
  const branchName = normalizeText(`${branch.firstName} ${branch.lastName}`);
  const reportName = normalizeText(report.staffName);
  if (branchName === reportName) score += 100;

  const branchParts = splitName(`${branch.firstName} ${branch.lastName}`);
  const reportParts = splitName(report.staffName || '');
  if (branchParts.last && branchParts.last === reportParts.last) score += 20;
  if (fuzzyFirstNameMatch(branchParts.first, reportParts.first)) score += 10;
  if (normalizeLocation(branch.location) && normalizeLocation(branch.location) === normalizeLocation(report.locationName)) score += 5;
  return score;
}

function matchBranchRowToReport(branch: BranchDailyRow, rows: StaffCashoutRow[], indexes: ReturnType<typeof buildReportIndexes>): StaffCashoutRow | null {
  const exactKey = normalizeText(`${branch.firstName} ${branch.lastName}`);
  const exactHits = indexes.byExactName.get(exactKey) || [];
  if (exactHits.length === 1) return exactHits[0]!;
  if (exactHits.length > 1) {
    return [...exactHits].sort((a, b) => scoreReportCandidate(branch, b) - scoreReportCandidate(branch, a))[0] || null;
  }

  const branchParts = splitName(`${branch.firstName} ${branch.lastName}`);
  const lastHits = indexes.byLastName.get(branchParts.last) || [];
  const fuzzyHits = lastHits.filter((candidate) => fuzzyFirstNameMatch(branchParts.first, splitName(candidate.staffName || '').first));
  if (!fuzzyHits.length) return null;
  return [...fuzzyHits].sort((a, b) => scoreReportCandidate(branch, b) - scoreReportCandidate(branch, a))[0] || null;
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

  const tabTitle = resolveSheetTabForDate(args.sheetId, args.account, args.date);
  const branchRows = loadBranchDailyRows(args.sheetId, args.account, tabTitle);
  const reportIndexes = buildReportIndexes(report.rows);
  const matchedReportRows = new Set<StaffCashoutRow>();

  const exportRows: ExportRow[] = [];
  const unmatchedBranchRows: BranchDailyRow[] = [];
  const skippedNonPositiveReportMatches: MatchDiagnostics['skippedNonPositiveReportMatches'] = [];

  for (const branchRow of branchRows) {
    const match = matchBranchRowToReport(branchRow, report.rows, reportIndexes);
    if (!match) {
      unmatchedBranchRows.push(branchRow);
      continue;
    }
    matchedReportRows.add(match);

    const amount = match.bankToBankAmount;
    if (amount == null || amount <= 0) {
      skippedNonPositiveReportMatches.push({
        staffId: branchRow.staffId,
        firstName: branchRow.firstName,
        lastName: branchRow.lastName,
        transactionId: branchRow.transactionId,
        location: branchRow.location,
        amount,
      });
      continue;
    }

    exportRows.push({
      staffId: branchRow.staffId,
      firstName: branchRow.firstName,
      lastName: branchRow.lastName,
      type: 'Deposit',
      amount,
      transactionId: branchRow.transactionId,
      location: branchRow.location,
      matchedReportName: match.staffName || '',
      matchedReportLocation: match.locationName,
    });
  }

  exportRows.sort((a, b) => a.location.localeCompare(b.location) || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));

  const coveredLocations = new Set(branchRows.map((row) => normalizeLocation(row.location)).filter(Boolean));
  const unmatchedPositiveReportRows = report.rows
    .filter((row) => (row.bankToBankAmount || 0) > 0)
    .filter((row) => {
      const location = normalizeLocation(row.locationName);
      return !coveredLocations.size || coveredLocations.has(location);
    })
    .filter((row) => !matchedReportRows.has(row))
    .map((row) => ({
      staffName: row.staffName,
      locationName: row.locationName,
      bankToBankAmount: row.bankToBankAmount || 0,
    }));

  const csvPath = path.join(args.outputDir, `branch-deposits-${args.date}.csv`);
  const diagnosticsPath = path.join(args.outputDir, `branch-deposits-${args.date}.diagnostics.json`);

  writeFileSync(csvPath, toCsv(exportRows), 'utf8');
  writeFileSync(diagnosticsPath, JSON.stringify({
    date: args.date,
    branchSheetTab: tabTitle,
    generatedAt: new Date().toISOString(),
    reportRowCount: report.rows.length,
    branchRowCount: branchRows.length,
    exportRowCount: exportRows.length,
    unmatchedBranchRows,
    reportRowsWithPositiveAmountButNoBranchMatch: unmatchedPositiveReportRows,
    skippedNonPositiveReportMatches,
  } satisfies MatchDiagnostics, null, 2), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    date: args.date,
    branchSheetTab: tabTitle,
    csvPath,
    diagnosticsPath,
    exportRowCount: exportRows.length,
    unmatchedBranchRowCount: unmatchedBranchRows.length,
    unmatchedPositiveReportRowCount: unmatchedPositiveReportRows.length,
    skippedNonPositiveReportMatchCount: skippedNonPositiveReportMatches.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
