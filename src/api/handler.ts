// Request router for kitchen-plugin-yot.
// Kitchen invokes handleRequest({ path, method, query, headers, body }, ctx)
// and expects { status, data } back.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { and, eq, sql } from 'drizzle-orm';
import { initializeDatabase } from '../db';
import * as schema from '../db/schema';
import { listAppointmentsForRequest } from './list-appointments';
import { stylistsByLocationForRange } from './stylists-by-location';
import { buildAppointmentLookupsForRows } from './appointment-lookups';
import { characterizeClientPaging, extractAppointmentsRangeRows, fetchAppointmentsRange, fetchBusiness, fetchClients, fetchLocationServices, fetchLocationStaff, fetchLocations, fetchStaffProfile, ping } from '../drivers/yot-client';
import { runStaffCashoutReport } from '../reports/run-staff-cashout';
import { listStaffCashoutFacts, syncStaffCashoutFromReport } from '../reports/sync-staff-cashout';
import { syncPromotionUsageRange } from '../reports/sync-promotion-usage';
import { syncRevenueFactsRangeFromDailyRevenueSummary } from '../reports/sync-revenue-facts';
import { reportRegistry } from '../reports/report-registry';
import { createReportClient } from '../reports/client';
import type { KitchenPluginContext } from './types-kitchen';
import type {
  ApiError,
  AppointmentDetailRecord,
  AppointmentRecord,
  ClientDetailRecord,
  ClientRecord,
  ExportManifestRecord,
  LocationDetailRecord,
  LocationRecord,
  PromotionUsageQueryResponse,
  RelationshipSummary,
  ServiceDetailRecord,
  ServiceRecord,
  StylistDetailRecord,
  StylistRecord,
  SyncRunRecord,
  YotConfig,
} from '../types';

export type PluginRequest = {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
};

export type PluginResponse = {
  status?: number;
  headers?: Record<string, string>;
  data?: unknown;
};

function apiError(status: number, error: string, message: string, details?: unknown): PluginResponse {
  const payload: ApiError = { error, message, details };
  return { status, data: payload };
}

function getTeamId(req: PluginRequest): string {
  return req.query.team || req.query.teamId || req.headers['x-team-id'] || 'default';
}

function parsePagination(query: Record<string, string | undefined>) {
  const limit = Math.min(parseInt(query.limit || '50', 10) || 50, 500);
  const offset = parseInt(query.offset || '0', 10) || 0;
  return { limit, offset };
}

function readYotConfig(teamId: string): YotConfig | null {
  const { db } = initializeDatabase(teamId);
  const rows = db
    .select()
    .from(schema.pluginConfig)
    .where(and(eq(schema.pluginConfig.teamId, teamId), eq(schema.pluginConfig.key, 'yot')))
    .all();
  if (!rows.length) return null;
  try {
    const parsed = JSON.parse(rows[0].value);
    if (!parsed?.apiKey) return null;
    return { apiKey: String(parsed.apiKey), baseUrl: parsed.baseUrl ? String(parsed.baseUrl) : undefined };
  } catch {
    return null;
  }
}

function cleanString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeFullName(item: Record<string, any> | null | undefined): string | null {
  if (!item) return null;
  const direct = cleanString(item.name);
  if (direct) return direct;
  const composed = [cleanString(item.givenName ?? item.firstName), cleanString(item.otherName), cleanString(item.surname ?? item.lastName)]
    .filter(Boolean)
    .join(' ')
    .trim();
  return composed || null;
}

function safeJsonParseArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJsonParse(value: string | null): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}


type RelationshipLinkAccumulator = { id: string; label: string; appointmentCount: number; lastAppointmentAt: string | null };

type RelationshipComputation = RelationshipSummary;

type RevenueGrain = 'day' | 'week' | 'month';
type RevenueFactRow = schema.RevenueFact & { locationName: string | null };
type PayoutFactRow = {
  date: string;
  locationName: string;
  staffName: string;
  staffId: string | null;
  bankToBankAmount: number | null;
  originalPayoutAmount: number | null;
  garnishmentPercent: number | null;
  garnishmentAmount: number;
  loanPaymentAmount: number;
  netPayoutAmount: number | null;
  lastUpdatedAt: string;
};

type ExportCsvRow = {
  staffId: string;
  firstName: string;
  lastName: string;
  type: 'Deposit';
  amount: number;
  transactionId: string;
  location: string;
};

type PayoutExportDiagnostics = {
  date: string;
  generatedAt: string;
  garnishmentPayoutRows?: Array<{
    staffId: string;
    firstName: string;
    lastName: string;
    type: 'GARNISHMENT';
    amount: number;
    transactionId: string;
    location: string;
    date: string;
  }>;
  loanPaymentRows?: Array<{
    staffId: string;
    date: string;
    firstName: string;
    lastName: string;
    loanAmount: number;
    totalPaid: number;
    withholding: number;
    day: string;
    transactionId: string;
  }>;
};
type PayoutLocationTotalRow = {
  date: string;
  locationName: string;
  branchTotal: number;
  originalPayoutTotal: number;
  garnishmentTotal: number;
  loanPaymentTotal: number;
  stylistCount: number;
  lastUpdatedAt: string | null;
};
type RevenuePeriodAccumulator = {
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  label: string;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
  appointmentCount: number;
  uniqueClientCount: number;
  locationIds: Set<string>;
  dayKeys: Set<string>;
  lastUpdatedAt: string | null;
};
type RevenueLocationAccumulator = {
  locationId: string;
  locationName: string | null;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
  appointmentCount: number;
  uniqueClientCount: number;
  dayKeys: Set<string>;
  lastUpdatedAt: string | null;
  // Per-location totals from the DSS Totals report. Sums are valid across any
  // window (additive). Ratio fields hold the last-seen non-null value — only
  // meaningful when the window is a single day (which is the daily-ops case).
  salesCount: number;
  cashSales: number;
  totalSales: number;
  commissionTotal: number;
  commissionNet: number;
  grossIncome: number;
  servicesPerSale: number | null;
  avgSaleValue: number | null;
  pctCostOfSale: number | null;
};
type PromotionUsageRow = schema.PromotionUsage & {
  locationName: string | null;
  promotionName: string | null;
  promotionCode: string | null;
  date: string | null;
  usageCount: number;
};
type PromotionSummaryAccumulator = {
  promotionId: string;
  promotionName: string | null;
  promotionCode: string | null;
  usageCount: number;
  locationIds: Set<string>;
  dayKeys: Set<string>;
  lastUsedAt: string | null;
};
type PromotionMatrixAccumulator = {
  rowKey: string;
  date: string;
  locationId: string;
  locationName: string | null;
  totalUsageCount: number;
  promotionCounts: Record<string, number>;
};

const REPORTS_TIME_ZONE = 'America/New_York';
const DEFAULT_REVENUE_ORGANISATION_ID = 11082;
const PAYOUT_EXPORT_DIR = '/Users/hairmx/hmx-reports';

function mostRecentIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function toRelationshipLinks(items: Map<string, RelationshipLinkAccumulator>) {
  return Array.from(items.values())
    .sort((a, b) => {
      if (b.appointmentCount !== a.appointmentCount) return b.appointmentCount - a.appointmentCount;
      return String(a.label || '').localeCompare(String(b.label || ''));
    })
    .slice(0, 8);
}

function asNumber(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toDateOnlyInput(value: unknown): string | null {
  const text = cleanString(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text.slice(0, 10);
  return null;
}

function parseDateOnlyToUtc(value: string): Date {
  const [year, month, day] = value.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year || 0, (month || 1) - 1, day || 1));
}

function formatUtcDateOnly(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

function addDaysToDateOnly(value: string, days: number): string {
  const date = parseDateOnlyToUtc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatUtcDateOnly(date);
}

function startOfWeekDateOnly(value: string): string {
  const date = parseDateOnlyToUtc(value);
  const dayOfWeek = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayOfWeek);
  return formatUtcDateOnly(date);
}

function endOfWeekDateOnly(value: string): string {
  return addDaysToDateOnly(startOfWeekDateOnly(value), 6);
}

function startOfMonthDateOnly(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

function endOfMonthDateOnly(value: string): string {
  const date = parseDateOnlyToUtc(startOfMonthDateOnly(value));
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return formatUtcDateOnly(date);
}

function dateOnlyNow(timeZone = REPORTS_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get('year')}-${byType.get('month')}-${byType.get('day')}`;
}

function toIsoDayStart(value: string): string {
  return `${value}T00:00:00.000Z`;
}

function parseRevenueGrain(value: string | undefined): RevenueGrain {
  return value === 'week' || value === 'month' ? value : 'day';
}

function periodBoundsForDate(value: string, grain: RevenueGrain): { periodKey: string; periodStart: string; periodEnd: string; label: string } {
  if (grain === 'week') {
    const periodStart = startOfWeekDateOnly(value);
    const periodEnd = endOfWeekDateOnly(value);
    return { periodKey: periodStart, periodStart, periodEnd, label: `${periodStart} → ${periodEnd}` };
  }
  if (grain === 'month') {
    const periodStart = startOfMonthDateOnly(value);
    const periodEnd = endOfMonthDateOnly(value);
    return { periodKey: periodStart.slice(0, 7), periodStart, periodEnd, label: periodStart.slice(0, 7) };
  }
  return { periodKey: value, periodStart: value, periodEnd: value, label: value };
}

function clampDays(value: number, fallback: number, max = 366): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), max));
}

/**
 * Compute a self-healing date range for a date-windowed sync. Queries the
 * actual cache table for MAX(date_column) per resource — that's the true
 * "data through" date, not a sync timestamp. Returns a window from that
 * date through yesterday (inclusive on both ends; re-syncing the boundary
 * day is safe due to upsert and catches partial-day gaps).
 *
 * Why not use sync_state.last_success_at? That records when a sync FINISHED,
 * not what date range the sync COVERED. A sync at 02:00 yesterday that only
 * pulled "yesterday's data" updates last_success_at to yesterday — but if
 * the prior week's syncs all failed silently, the real cache gap goes back
 * much further. Querying the data directly is the truth.
 *
 * First-run fallback (table empty) uses `fallbackDays` (default 30).
 */
function autoResumeRange(teamId: string, resource: string, fallbackDays = 30) {
  const { db } = initializeDatabase(teamId);
  const yesterday = addDaysToDateOnly(dateOnlyNow(), -1);
  const todayEnd = `${dateOnlyNow()}T23:59:59`;

  let maxDate: string | null = null;
  try {
    const stmt = (() => {
      switch (resource) {
        case 'revenue_facts':
          return sql`SELECT MAX(date) AS d FROM revenue_facts WHERE team_id = ${teamId}`;
        case 'staff_cashout_facts':
          return sql`SELECT MAX(date) AS d FROM staff_cashout_facts WHERE team_id = ${teamId}`;
        case 'promotion_usage':
          return sql`SELECT MAX(SUBSTR(used_at, 1, 10)) AS d FROM promotion_usage WHERE team_id = ${teamId}`;
        case 'appointments':
          // Clamp to today's end so future bookings don't fool us into thinking we're already current
          return sql`SELECT MAX(SUBSTR(COALESCE(start_at, starts_at), 1, 10)) AS d
                     FROM appointments
                     WHERE team_id = ${teamId} AND COALESCE(start_at, starts_at) <= ${todayEnd}`;
        default:
          return null;
      }
    })();
    if (stmt) {
      const row = db.all(stmt)[0] as any;
      const candidate = row?.d ? String(row.d).slice(0, 10) : null;
      if (candidate && /^\d{4}-\d{2}-\d{2}$/.test(candidate)) maxDate = candidate;
    }
  } catch { /* fall through to first-run */ }

  if (maxDate) {
    // Already current (rare): the cache holds yesterday's data, so just re-sync yesterday as a no-op safety
    if (maxDate >= yesterday) {
      return { startDate: yesterday, endDate: yesterday, lookbackDays: 1, mode: 'current' as const };
    }
    // Resume from maxDate (re-sync the boundary day — safe due to upsert) through yesterday
    const lookbackDays = Math.min(
      Math.ceil((Date.parse(`${yesterday}T00:00:00Z`) - Date.parse(`${maxDate}T00:00:00Z`)) / 86400000) + 1,
      365
    );
    return { startDate: maxDate, endDate: yesterday, lookbackDays, mode: 'data-resume' as const };
  }

  // First run / empty table: backfill the last N days
  return {
    startDate: addDaysToDateOnly(yesterday, -(fallbackDays - 1)),
    endDate: yesterday,
    lookbackDays: fallbackDays,
    mode: 'first-run' as const,
  };
}

function resolveRevenueDateRange(rows: RevenueFactRow[], requestedStart: string | null, requestedEnd: string | null) {
  const dates = rows.map((row) => row.date).filter(Boolean).sort();
  const minDate = dates[0] || null;
  const maxDate = dates[dates.length - 1] || null;
  if (!minDate || !maxDate) {
    return { minDate, maxDate, startDate: requestedStart, endDate: requestedEnd };
  }

  let startDate = requestedStart;
  let endDate = requestedEnd;
  const defaultEndDate = maxDate > addDaysToDateOnly(dateOnlyNow(), -1) ? addDaysToDateOnly(dateOnlyNow(), -1) : maxDate;
  if (!endDate) endDate = defaultEndDate;
  if (!startDate) startDate = minDate > addDaysToDateOnly(endDate, -89) ? minDate : addDaysToDateOnly(endDate, -89);
  if (startDate > endDate) {
    const tmp = startDate;
    startDate = endDate;
    endDate = tmp;
  }
  return { minDate, maxDate, startDate, endDate };
}

function listRevenueFacts(db: ReturnType<typeof initializeDatabase>['db'], teamId: string, filters: { locationId?: string | null; startDate?: string | null; endDate?: string | null } = {}): RevenueFactRow[] {
  const nameByLocationId = new Map<string, string | null>();
  const locations = db.select().from(schema.locations).where(eq(schema.locations.teamId, teamId)).all() as schema.Location[];
  for (const row of locations) nameByLocationId.set(row.id, row.name ?? null);

  let rows = db.select().from(schema.revenueFacts).where(eq(schema.revenueFacts.teamId, teamId)).all() as schema.RevenueFact[];
  if (filters.locationId) rows = rows.filter((row) => row.locationId === filters.locationId);
  if (filters.startDate) rows = rows.filter((row) => row.date >= filters.startDate!);
  if (filters.endDate) rows = rows.filter((row) => row.date <= filters.endDate!);
  return rows.map((row) => ({ ...row, locationName: nameByLocationId.get(row.locationId) ?? null }));
}

function normalizeMatchText(value: string | null | undefined): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[’']/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeMatchLocation(value: string | null | undefined): string {
  return normalizeMatchText(value)
    .replace(/\bmi\b|\boh\b|\bpa\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function parseExportCsv(text: string): ExportCsvRow[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => {
    const [staffId = '', firstName = '', lastName = '', type = 'Deposit', amount = '0', transactionId = '', location = ''] = parseCsvRow(line);
    return {
      staffId: String(staffId).trim(),
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      type: 'Deposit' as const,
      amount: Number(String(amount).replace(/[$,]/g, '').trim() || '0') || 0,
      transactionId: String(transactionId).trim(),
      location: String(location).trim(),
    };
  }).filter((row) => row.staffId || row.transactionId || row.location);
}

function readPayoutExportForDate(date: string): { rows: PayoutFactRow[]; generatedAt: string | null } {
  const csvPath = path.join(PAYOUT_EXPORT_DIR, `branch-deposits-${date}.csv`);
  const diagnosticsPath = path.join(PAYOUT_EXPORT_DIR, `branch-deposits-${date}.diagnostics.json`);
  if (!existsSync(csvPath)) return { rows: [], generatedAt: null };

  const csvRows = parseExportCsv(readFileSync(csvPath, 'utf8'));
  const diagnostics = existsSync(diagnosticsPath)
    ? JSON.parse(readFileSync(diagnosticsPath, 'utf8')) as PayoutExportDiagnostics
    : null;
  const generatedAt = diagnostics?.generatedAt || `${date}T00:00:00.000Z`;
  // Garnishments: keyed by staffId + normalized location. The diagnostics
  // payout row's transactionId encodes the garnishment amount, while the
  // CSV row's transactionId encodes the net amount — they're deliberately
  // different transactions, so joining on transactionId always missed.
  // Sum garnishments per (staffId, location) and apply the total to the
  // first matching CSV row; subsequent rows for the same stylist/location
  // pair (rare) see 0.
  const garnishmentRows = diagnostics?.garnishmentPayoutRows || [];
  const garnishmentByKey = new Map<string, number>();
  for (const row of garnishmentRows) {
    const key = `${row.staffId}::${normalizeMatchLocation(row.location)}`;
    const prior = garnishmentByKey.get(key) || 0;
    garnishmentByKey.set(key, Number((prior + asNumber(row.amount)).toFixed(2)));
  }

  // Loan withholdings: indexed by staffId since loan rows don't carry a
  // location (they're per-stylist-per-day). The exporter only applies a
  // loan to one of the stylist's YOT rows (the first with capacity), so
  // attaching the full withholding to the first CSV row keyed by staffId
  // matches the actual deduction. Subsequent CSV rows for the same
  // stylist (split-shift across locations) get 0.
  const loanRows = diagnostics?.loanPaymentRows || [];
  const loanRemainingByStaff = new Map<string, number>();
  for (const row of loanRows) {
    const prior = loanRemainingByStaff.get(row.staffId) || 0;
    loanRemainingByStaff.set(row.staffId, Number((prior + asNumber(row.withholding)).toFixed(2)));
  }

  return {
    generatedAt,
    rows: csvRows.map((row) => {
      const key = `${row.staffId}::${normalizeMatchLocation(row.location)}`;
      const garnishmentAmount = garnishmentByKey.get(key) || 0;
      if (garnishmentAmount > 0) garnishmentByKey.set(key, 0);
      const loanPaymentAmount = row.staffId ? (loanRemainingByStaff.get(row.staffId) || 0) : 0;
      if (row.staffId && loanPaymentAmount > 0) loanRemainingByStaff.set(row.staffId, 0);
      const originalPayoutAmount = Number((row.amount + garnishmentAmount + loanPaymentAmount).toFixed(2));
      const garnishmentPercent = garnishmentAmount > 0 && originalPayoutAmount > 0
        ? Number((garnishmentAmount / originalPayoutAmount).toFixed(4))
        : null;
      return {
        date,
        locationName: row.location,
        staffName: [row.firstName, row.lastName].filter(Boolean).join(' ').trim(),
        staffId: row.staffId || null,
        bankToBankAmount: row.amount,
        originalPayoutAmount,
        garnishmentPercent,
        garnishmentAmount,
        loanPaymentAmount,
        netPayoutAmount: row.amount,
        lastUpdatedAt: generatedAt,
      } satisfies PayoutFactRow;
    }),
  };
}

function listPayoutFactsFromExports(filters: { startDate?: string | null; endDate?: string | null; locationName?: string | null } = {}): { rows: PayoutFactRow[]; lastExportedAt: string | null } {
  const startDate = filters.startDate ? String(filters.startDate).slice(0, 10) : null;
  const endDate = filters.endDate ? String(filters.endDate).slice(0, 10) : null;
  if (!startDate || !endDate) return { rows: [], lastExportedAt: null };

  const rows: PayoutFactRow[] = [];
  let lastExportedAt: string | null = null;
  for (let cursor = startDate; cursor <= endDate; cursor = addDaysToDateOnly(cursor, 1)) {
    const loaded = readPayoutExportForDate(cursor);
    lastExportedAt = mostRecentIso(lastExportedAt, loaded.generatedAt);
    rows.push(...loaded.rows);
  }

  const filtered = filters.locationName
    ? rows.filter((row) => row.locationName === filters.locationName)
    : rows;

  filtered.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    if (a.locationName !== b.locationName) return a.locationName.localeCompare(b.locationName);
    return (b.netPayoutAmount || 0) - (a.netPayoutAmount || 0) || a.staffName.localeCompare(b.staffName);
  });

  return { rows: filtered, lastExportedAt };
}

function resolvePluginFile(startDir: string, relativePath: string): string | null {
  let cursor = startDir;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(cursor, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function computePayoutTotals(rows: PayoutFactRow[]) {
  let payoutTotal = 0;
  let originalPayoutTotal = 0;
  let garnishmentTotal = 0;
  let loanPaymentTotal = 0;
  let lastUpdatedAt: string | null = null;
  const dates = new Set<string>();
  const branches = new Set<string>();
  const stylists = new Set<string>();
  for (const row of rows) {
    payoutTotal += asNumber(row.netPayoutAmount);
    originalPayoutTotal += asNumber(row.originalPayoutAmount);
    garnishmentTotal += asNumber(row.garnishmentAmount);
    loanPaymentTotal += asNumber(row.loanPaymentAmount);
    if (row.date) dates.add(row.date);
    if (row.locationName) branches.add(row.locationName);
    if (row.staffName) stylists.add(`${row.date}::${row.locationName}::${row.staffName}`);
    lastUpdatedAt = mostRecentIso(lastUpdatedAt, row.lastUpdatedAt || null);
  }
  return {
    payoutTotal,
    originalPayoutTotal,
    garnishmentTotal,
    loanPaymentTotal,
    rowCount: rows.length,
    dayCount: dates.size,
    branchCount: branches.size,
    stylistCount: stylists.size,
    lastUpdatedAt,
  };
}

function buildPayoutLocationTotals(rows: PayoutFactRow[]): PayoutLocationTotalRow[] {
  const buckets = new Map<string, PayoutLocationTotalRow>();
  for (const row of rows) {
    const key = `${row.date}::${row.locationName}`;
    const bucket = buckets.get(key) || {
      date: row.date,
      locationName: row.locationName,
      branchTotal: 0,
      originalPayoutTotal: 0,
      garnishmentTotal: 0,
      loanPaymentTotal: 0,
      stylistCount: 0,
      lastUpdatedAt: null,
    };
    bucket.branchTotal += asNumber(row.netPayoutAmount);
    bucket.originalPayoutTotal += asNumber(row.originalPayoutAmount);
    bucket.garnishmentTotal += asNumber(row.garnishmentAmount);
    bucket.loanPaymentTotal += asNumber(row.loanPaymentAmount);
    bucket.stylistCount += 1;
    bucket.lastUpdatedAt = mostRecentIso(bucket.lastUpdatedAt, row.lastUpdatedAt || null);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return a.locationName.localeCompare(b.locationName);
  });
}

function computeRevenueTotals(rows: RevenueFactRow[]) {
  let grossAmount = 0;
  let discountAmount = 0;
  let netAmount = 0;
  let appointmentCount = 0;
  let uniqueClientCount = 0;
  let lastUpdatedAt: string | null = null;
  const locationIds = new Set<string>();
  for (const row of rows) {
    grossAmount += asNumber(row.grossAmount);
    discountAmount += asNumber(row.discountAmount);
    netAmount += asNumber(row.netAmount);
    appointmentCount += asNumber(row.appointmentCount);
    uniqueClientCount += asNumber(row.uniqueClientCount);
    if (row.locationId) locationIds.add(row.locationId);
    lastUpdatedAt = mostRecentIso(lastUpdatedAt, row.lastUpdatedAt || null);
  }
  return {
    grossAmount,
    discountAmount,
    netAmount,
    appointmentCount,
    uniqueClientCount,
    rowCount: rows.length,
    locationCount: locationIds.size,
    lastUpdatedAt,
  };
}

function buildRevenueByPeriod(rows: RevenueFactRow[], grain: RevenueGrain) {
  const buckets = new Map<string, RevenuePeriodAccumulator>();
  for (const row of rows) {
    const bounds = periodBoundsForDate(row.date, grain);
    const bucket = buckets.get(bounds.periodKey) || {
      periodKey: bounds.periodKey,
      periodStart: bounds.periodStart,
      periodEnd: bounds.periodEnd,
      label: bounds.label,
      grossAmount: 0,
      discountAmount: 0,
      netAmount: 0,
      appointmentCount: 0,
      uniqueClientCount: 0,
      locationIds: new Set<string>(),
      dayKeys: new Set<string>(),
      lastUpdatedAt: null,
    };
    bucket.grossAmount += asNumber(row.grossAmount);
    bucket.discountAmount += asNumber(row.discountAmount);
    bucket.netAmount += asNumber(row.netAmount);
    bucket.appointmentCount += asNumber(row.appointmentCount);
    bucket.uniqueClientCount += asNumber(row.uniqueClientCount);
    bucket.locationIds.add(row.locationId);
    bucket.dayKeys.add(row.date);
    bucket.lastUpdatedAt = mostRecentIso(bucket.lastUpdatedAt, row.lastUpdatedAt || null);
    buckets.set(bounds.periodKey, bucket);
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.periodStart === b.periodStart ? String(a.label).localeCompare(String(b.label)) : String(b.periodStart).localeCompare(String(a.periodStart)))
    .map((bucket) => ({
      periodKey: bucket.periodKey,
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      label: bucket.label,
      grossAmount: bucket.grossAmount,
      discountAmount: bucket.discountAmount,
      netAmount: bucket.netAmount,
      appointmentCount: bucket.appointmentCount,
      uniqueClientCount: bucket.uniqueClientCount,
      locationCount: bucket.locationIds.size,
      dayCount: bucket.dayKeys.size,
      lastUpdatedAt: bucket.lastUpdatedAt,
    }));
}

function buildRevenueByLocation(rows: RevenueFactRow[]) {
  const buckets = new Map<string, RevenueLocationAccumulator>();
  for (const row of rows) {
    const key = row.locationId;
    const bucket = buckets.get(key) || {
      locationId: row.locationId,
      locationName: row.locationName ?? row.locationId,
      grossAmount: 0,
      discountAmount: 0,
      netAmount: 0,
      appointmentCount: 0,
      uniqueClientCount: 0,
      dayKeys: new Set<string>(),
      lastUpdatedAt: null,
      salesCount: 0,
      cashSales: 0,
      totalSales: 0,
      commissionTotal: 0,
      commissionNet: 0,
      grossIncome: 0,
      servicesPerSale: null,
      avgSaleValue: null,
      pctCostOfSale: null,
    };
    bucket.grossAmount += asNumber(row.grossAmount);
    bucket.discountAmount += asNumber(row.discountAmount);
    bucket.netAmount += asNumber(row.netAmount);
    bucket.appointmentCount += asNumber(row.appointmentCount);
    bucket.uniqueClientCount += asNumber(row.uniqueClientCount);
    bucket.salesCount += asNumber((row as any).salesCount);
    bucket.cashSales += asNumber((row as any).cashSales);
    bucket.totalSales += asNumber((row as any).totalSales);
    bucket.commissionTotal += asNumber((row as any).commissionTotal);
    bucket.commissionNet += asNumber((row as any).commissionNet);
    bucket.grossIncome += asNumber((row as any).grossIncome);
    if ((row as any).servicesPerSale != null) bucket.servicesPerSale = Number((row as any).servicesPerSale);
    if ((row as any).avgSaleValue != null) bucket.avgSaleValue = Number((row as any).avgSaleValue);
    if ((row as any).pctCostOfSale != null) bucket.pctCostOfSale = Number((row as any).pctCostOfSale);
    bucket.dayKeys.add(row.date);
    bucket.lastUpdatedAt = mostRecentIso(bucket.lastUpdatedAt, row.lastUpdatedAt || null);
    if (!bucket.locationName && row.locationName) bucket.locationName = row.locationName;
    buckets.set(key, bucket);
  }
  return Array.from(buckets.values())
    .sort((a, b) => {
      if (b.grossAmount !== a.grossAmount) return b.grossAmount - a.grossAmount;
      return String(a.locationName || a.locationId).localeCompare(String(b.locationName || b.locationId));
    })
    .map((bucket) => ({
      locationId: bucket.locationId,
      locationName: bucket.locationName,
      grossAmount: bucket.grossAmount,
      discountAmount: bucket.discountAmount,
      netAmount: bucket.netAmount,
      appointmentCount: bucket.appointmentCount,
      uniqueClientCount: bucket.uniqueClientCount,
      dayCount: bucket.dayKeys.size,
      lastUpdatedAt: bucket.lastUpdatedAt,
      salesCount: bucket.salesCount || null,
      cashSales: bucket.cashSales || null,
      totalSales: bucket.totalSales || null,
      commissionTotal: bucket.commissionTotal || null,
      commissionNet: bucket.commissionNet || null,
      grossIncome: bucket.grossIncome || null,
      servicesPerSale: bucket.servicesPerSale,
      avgSaleValue: bucket.avgSaleValue,
      pctCostOfSale: bucket.pctCostOfSale,
    }));
}

function buildRevenueByPeriodLocation(rows: RevenueFactRow[], grain: RevenueGrain) {
  const buckets = new Map<string, {
    periodKey: string;
    periodStart: string;
    periodEnd: string;
    label: string;
    locationId: string;
    locationName: string | null;
    grossAmount: number;
    discountAmount: number;
    netAmount: number;
    appointmentCount: number;
    uniqueClientCount: number;
  }>();
  for (const row of rows) {
    const bounds = periodBoundsForDate(row.date, grain);
    const key = `${bounds.periodKey}::${row.locationId}`;
    const bucket = buckets.get(key) || {
      periodKey: bounds.periodKey,
      periodStart: bounds.periodStart,
      periodEnd: bounds.periodEnd,
      label: bounds.label,
      locationId: row.locationId,
      locationName: row.locationName ?? row.locationId,
      grossAmount: 0,
      discountAmount: 0,
      netAmount: 0,
      appointmentCount: 0,
      uniqueClientCount: 0,
    };
    bucket.grossAmount += asNumber(row.grossAmount);
    bucket.discountAmount += asNumber(row.discountAmount);
    bucket.netAmount += asNumber(row.netAmount);
    bucket.appointmentCount += asNumber(row.appointmentCount);
    bucket.uniqueClientCount += asNumber(row.uniqueClientCount);
    if (!bucket.locationName && row.locationName) bucket.locationName = row.locationName;
    buckets.set(key, bucket);
  }
  return Array.from(buckets.values());
}

function listPromotionUsageRows(db: ReturnType<typeof initializeDatabase>['db'], teamId: string, filters: { locationId?: string | null; startDate?: string | null; endDate?: string | null } = {}): PromotionUsageRow[] {
  const locations = db.select().from(schema.locations).where(eq(schema.locations.teamId, teamId)).all() as schema.Location[];
  const promotions = db.select().from(schema.promotions).where(eq(schema.promotions.teamId, teamId)).all() as schema.Promotion[];
  const locationNameById = new Map<string, string | null>(locations.map((row) => [row.id, row.name ?? null]));
  const promotionById = new Map<string, schema.Promotion>(promotions.map((row) => [row.id, row]));

  let rows = db.select().from(schema.promotionUsage).where(eq(schema.promotionUsage.teamId, teamId)).all() as schema.PromotionUsage[];
  if (filters.locationId) rows = rows.filter((row) => row.locationId === filters.locationId);

  return rows
    .map((row) => {
      const raw = safeJsonParse(row.raw) as Record<string, unknown> | null;
      const promotion = promotionById.get(row.promotionId);
      const date = toDateOnlyInput(raw?.date || row.usedAt);
      const usageCount = Number(raw?.usageCount);
      return {
        ...row,
        locationName: row.locationId ? (locationNameById.get(row.locationId) ?? null) : null,
        promotionName: cleanString(raw?.promotionName) || promotion?.name || null,
        promotionCode: cleanString(raw?.promotionCode) || promotion?.code || null,
        date,
        usageCount: Number.isFinite(usageCount) ? usageCount : 1,
      };
    })
    .filter((row) => Boolean(row.date))
    .filter((row) => (!filters.startDate || row.date! >= filters.startDate) && (!filters.endDate || row.date! <= filters.endDate));
}

function resolvePromotionDateRange(rows: PromotionUsageRow[], requestedStart: string | null, requestedEnd: string | null) {
  const dates = rows.map((row) => row.date).filter(Boolean).sort() as string[];
  const minDate = dates[0] || null;
  const maxDate = dates[dates.length - 1] || null;
  if (!minDate || !maxDate) {
    return { minDate, maxDate, startDate: requestedStart, endDate: requestedEnd };
  }

  let startDate = requestedStart;
  let endDate = requestedEnd;
  const defaultEndDate = maxDate > addDaysToDateOnly(dateOnlyNow(), -1) ? addDaysToDateOnly(dateOnlyNow(), -1) : maxDate;
  if (!endDate) endDate = defaultEndDate;
  if (!startDate) startDate = minDate > addDaysToDateOnly(endDate, -89) ? minDate : addDaysToDateOnly(endDate, -89);
  if (startDate > endDate) {
    const tmp = startDate;
    startDate = endDate;
    endDate = tmp;
  }
  return { minDate, maxDate, startDate, endDate };
}

function computePromotionTotals(rows: PromotionUsageRow[]) {
  let usageCount = 0;
  let lastUpdatedAt: string | null = null;
  const promotionIds = new Set<string>();
  const locationIds = new Set<string>();
  const dayKeys = new Set<string>();
  for (const row of rows) {
    usageCount += row.usageCount;
    promotionIds.add(row.promotionId);
    if (row.locationId) locationIds.add(row.locationId);
    if (row.date) dayKeys.add(row.date);
    lastUpdatedAt = mostRecentIso(lastUpdatedAt, row.syncedAt || null);
  }
  return {
    usageCount,
    promotionCount: promotionIds.size,
    locationCount: locationIds.size,
    dayCount: dayKeys.size,
    rowCount: rows.length,
    lastUpdatedAt,
  };
}

function buildPromotionSummaries(rows: PromotionUsageRow[]) {
  const buckets = new Map<string, PromotionSummaryAccumulator>();
  for (const row of rows) {
    const bucket = buckets.get(row.promotionId) || {
      promotionId: row.promotionId,
      promotionName: row.promotionName,
      promotionCode: row.promotionCode,
      usageCount: 0,
      locationIds: new Set<string>(),
      dayKeys: new Set<string>(),
      lastUsedAt: null,
    };
    bucket.usageCount += row.usageCount;
    if (row.locationId) bucket.locationIds.add(row.locationId);
    if (row.date) bucket.dayKeys.add(row.date);
    if (!bucket.promotionName && row.promotionName) bucket.promotionName = row.promotionName;
    if (!bucket.promotionCode && row.promotionCode) bucket.promotionCode = row.promotionCode;
    bucket.lastUsedAt = mostRecentIso(bucket.lastUsedAt, row.usedAt || null);
    buckets.set(row.promotionId, bucket);
  }

  return Array.from(buckets.values())
    .sort((a, b) => {
      if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
      return String(a.promotionName || a.promotionCode || a.promotionId).localeCompare(String(b.promotionName || b.promotionCode || b.promotionId));
    })
    .map((bucket) => ({
      promotionId: bucket.promotionId,
      promotionName: bucket.promotionName,
      promotionCode: bucket.promotionCode,
      usageCount: bucket.usageCount,
      locationCount: bucket.locationIds.size,
      dayCount: bucket.dayKeys.size,
      lastUsedAt: bucket.lastUsedAt,
    }));
}

function buildPromotionMatrix(rows: PromotionUsageRow[], summaries: ReturnType<typeof buildPromotionSummaries>) {
  const matrix = new Map<string, PromotionMatrixAccumulator>();
  for (const row of rows) {
    if (!row.date || !row.locationId) continue;
    const rowKey = `${row.date}::${row.locationId}`;
    const bucket = matrix.get(rowKey) || {
      rowKey,
      date: row.date,
      locationId: row.locationId,
      locationName: row.locationName,
      totalUsageCount: 0,
      promotionCounts: {},
    };
    bucket.totalUsageCount += row.usageCount;
    bucket.promotionCounts[row.promotionId] = (bucket.promotionCounts[row.promotionId] || 0) + row.usageCount;
    matrix.set(rowKey, bucket);
  }

  return {
    matrixColumns: summaries.map((row) => ({
      promotionId: row.promotionId,
      promotionName: row.promotionName,
      promotionCode: row.promotionCode,
    })),
    matrixRows: Array.from(matrix.values()).sort((a, b) => {
      if (a.date !== b.date) return String(b.date).localeCompare(String(a.date));
      return String(a.locationName || a.locationId).localeCompare(String(b.locationName || b.locationId));
    }),
  };
}

function computeRevenueSummary(db: ReturnType<typeof initializeDatabase>['db'], teamId: string, locationId: string | null) {
  if (!locationId) {
    return {
      available: false,
      source: 'none' as const,
      grossAmount: null,
      discountAmount: null,
      netAmount: null,
      appointmentCount: 0,
      lastUpdatedAt: null,
      note: 'Revenue needs a location-scoped local source.',
    };
  }

  const facts = db.select().from(schema.revenueFacts)
    .where(and(eq(schema.revenueFacts.teamId, teamId), eq(schema.revenueFacts.locationId, locationId))).all() as schema.RevenueFact[];
  if (facts.length) {
    let grossAmount = 0;
    let discountAmount = 0;
    let netAmount = 0;
    let appointmentCount = 0;
    let lastUpdatedAt: string | null = null;
    for (const row of facts) {
      grossAmount += row.grossAmount || 0;
      discountAmount += row.discountAmount || 0;
      netAmount += row.netAmount || 0;
      appointmentCount += row.appointmentCount || 0;
      lastUpdatedAt = mostRecentIso(lastUpdatedAt, row.lastUpdatedAt || null);
    }
    return { available: true, source: 'revenue_facts' as const, grossAmount, discountAmount, netAmount, appointmentCount, lastUpdatedAt, note: null };
  }

  const appointments = db.select().from(schema.appointments)
    .where(and(eq(schema.appointments.teamId, teamId), eq(schema.appointments.locationId, locationId))).all() as schema.Appointment[];
  const withAmounts = appointments.filter((row) => row.netAmount != null || row.grossAmount != null || row.total != null);
  if (withAmounts.length) {
    let grossAmount = 0;
    let discountAmount = 0;
    let netAmount = 0;
    let lastUpdatedAt: string | null = null;
    for (const row of withAmounts) {
      grossAmount += row.grossAmount ?? row.total ?? 0;
      discountAmount += row.discountAmount ?? 0;
      netAmount += row.netAmount ?? row.total ?? row.grossAmount ?? 0;
      lastUpdatedAt = mostRecentIso(lastUpdatedAt, row.updatedAtRemote || row.syncedAt || null);
    }
    return { available: true, source: 'appointments' as const, grossAmount, discountAmount, netAmount, appointmentCount: withAmounts.length, lastUpdatedAt, note: null };
  }

  return {
    available: false,
    source: 'none' as const,
    grossAmount: null,
    discountAmount: null,
    netAmount: null,
    appointmentCount: appointments.length,
    lastUpdatedAt: appointments.reduce((latest, row) => mostRecentIso(latest, row.updatedAtRemote || row.syncedAt || null), null as string | null),
    note: appointments.length ? 'Appointments are linked, but this cache does not yet include money fields for them.' : 'No local revenue rows found for this location yet.',
  };
}

function buildRelationshipSummary(db: ReturnType<typeof initializeDatabase>['db'], teamId: string, focus: { clientId?: string | null; stylistId?: string | null; locationId?: string | null }): RelationshipComputation {
  const lookups = buildAppointmentLookups(db, teamId);
  let appointments = db.select().from(schema.appointments).where(eq(schema.appointments.teamId, teamId)).all() as schema.Appointment[];
  if (focus.clientId) appointments = appointments.filter((row) => row.clientId === focus.clientId);
  if (focus.locationId) appointments = appointments.filter((row) => row.locationId === focus.locationId);
  if (focus.stylistId) appointments = appointments.filter((row) => cleanString(row.stylistId ?? row.staffId) === focus.stylistId);

  const clients = new Map<string, RelationshipLinkAccumulator>();
  const stylists = new Map<string, RelationshipLinkAccumulator>();
  const locations = new Map<string, RelationshipLinkAccumulator>();
  let lastAppointmentAt: string | null = null;
  let recentAppointmentCount = 0;
  const recentCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  for (const row of appointments) {
    const startsAt = cleanString(row.startAt ?? row.startsAt);
    if (startsAt && startsAt >= recentCutoff) recentAppointmentCount++;
    lastAppointmentAt = mostRecentIso(lastAppointmentAt, startsAt);

    if (row.clientId) {
      const client = lookups.clientsById.get(row.clientId);
      const existing = clients.get(row.clientId) || { id: row.clientId, label: client?.fullName ?? client?.firstName ?? row.clientName ?? row.clientId, appointmentCount: 0, lastAppointmentAt: null };
      existing.appointmentCount += 1;
      existing.lastAppointmentAt = mostRecentIso(existing.lastAppointmentAt, startsAt);
      clients.set(row.clientId, existing);
    }

    const stylist = findAppointmentStylist(row, lookups);
    const stylistKey = stylist?.id || cleanString(row.stylistId ?? row.staffId);
    if (stylistKey) {
      const existing = stylists.get(stylistKey) || { id: stylistKey, label: stylist?.fullName ?? normalizeFullName(stylist as any) ?? row.stylistId ?? row.staffId ?? stylistKey, appointmentCount: 0, lastAppointmentAt: null };
      existing.appointmentCount += 1;
      existing.lastAppointmentAt = mostRecentIso(existing.lastAppointmentAt, startsAt);
      stylists.set(stylistKey, existing);
    }

    if (row.locationId) {
      const location = lookups.locationsById.get(row.locationId);
      const existing = locations.get(row.locationId) || { id: row.locationId, label: location?.name ?? row.locationId, appointmentCount: 0, lastAppointmentAt: null };
      existing.appointmentCount += 1;
      existing.lastAppointmentAt = mostRecentIso(existing.lastAppointmentAt, startsAt);
      locations.set(row.locationId, existing);
    }
  }

  return {
    appointmentCount: appointments.length,
    uniqueClientCount: clients.size,
    uniqueStylistCount: stylists.size,
    uniqueLocationCount: locations.size,
    lastAppointmentAt,
    recentAppointmentCount,
    clients: toRelationshipLinks(clients),
    stylists: toRelationshipLinks(stylists),
    locations: toRelationshipLinks(locations),
    revenue: focus.locationId ? computeRevenueSummary(db, teamId, focus.locationId) : null,
  };
}

function mapClientRecord(row: schema.Client): ClientRecord {
  return {
    id: row.id,
    privateId: row.privateId ?? null,
    firstName: row.firstName ?? null,
    otherName: row.otherName ?? null,
    lastName: row.lastName ?? null,
    fullName: row.fullName ?? null,
    email: row.emailAddress ?? row.email ?? null,
    phone: row.mobilePhone ?? row.homePhone ?? row.businessPhone ?? row.phone ?? null,
    homePhone: row.homePhone ?? null,
    mobilePhone: row.mobilePhone ?? null,
    businessPhone: row.businessPhone ?? null,
    birthday: row.birthday ?? null,
    gender: row.gender ?? null,
    active: row.active ?? null,
    street: row.street ?? null,
    suburb: row.suburb ?? null,
    state: row.state ?? null,
    postcode: row.postcode ?? null,
    country: row.country ?? null,
    sourceLocationId: row.sourceLocationId ?? null,
    tags: safeJsonParseArray(row.tags),
    lastVisitAt: row.lastVisitAt ?? null,
    totalVisits: row.totalVisits ?? null,
    totalSpend: row.totalSpend ?? null,
    syncedAt: row.syncedAt,
  };
}

function mapClientDetailRecord(row: schema.Client, relationships?: RelationshipSummary | null): ClientDetailRecord {
  return {
    ...mapClientRecord(row),
    address: row.address ?? null,
    createdAtRemote: row.createdAtRemote ?? null,
    relationships: relationships ?? null,
    raw: safeJsonParse(row.raw ?? null),
  };
}

function mapLocationRecord(row: schema.Location): LocationRecord {
  return {
    id: row.id,
    name: row.name ?? null,
    emailAddress: row.emailAddress ?? null,
    businessPhone: row.businessPhone ?? null,
    mobilePhone: row.mobilePhone ?? null,
    canBookOnline: row.canBookOnline ?? null,
    active: row.active ?? null,
    street: row.street ?? null,
    suburb: row.suburb ?? null,
    state: row.state ?? null,
    postcode: row.postcode ?? null,
    country: row.country ?? null,
    franchiseId: row.franchiseId ?? null,
    franchiseName: row.franchiseName ?? null,
    syncedAt: row.syncedAt,
  };
}

function mapLocationDetailRecord(row: schema.Location, relationships?: RelationshipSummary | null): LocationDetailRecord {
  return {
    ...mapLocationRecord(row),
    relationships: relationships ?? null,
    raw: safeJsonParse(row.raw ?? null),
  };
}

function mapStylistRecord(row: schema.Stylist): StylistRecord {
  return {
    id: row.id,
    stylistId: row.privateId ?? null,
    locationId: row.locationId ?? null,
    privateId: row.privateId ?? null,
    givenName: row.givenName ?? null,
    surname: row.surname ?? null,
    fullName: row.fullName ?? null,
    initial: row.initial ?? null,
    jobTitle: row.jobTitle ?? null,
    jobDescription: row.jobDescription ?? null,
    emailAddress: row.emailAddress ?? null,
    mobilePhone: row.mobilePhone ?? null,
    active: row.active ?? null,
    sourceLocationId: row.sourceLocationId ?? null,
    serviceCategoryNames: safeJsonParseArray(row.serviceCategoryNames ?? null),
    serviceIds: safeJsonParseArray(row.serviceIds ?? null),
    serviceNames: safeJsonParseArray(row.serviceNames ?? null),
    syncedAt: row.syncedAt,
  };
}

function mapStylistDetailRecord(row: schema.Stylist, relationships?: RelationshipSummary | null): StylistDetailRecord {
  return {
    ...mapStylistRecord(row),
    relationships: relationships ?? null,
    profileRaw: safeJsonParse(row.profileRaw ?? null),
    raw: safeJsonParse(row.raw ?? null),
  };
}

function mapAppointmentRecord(row: schema.Appointment): AppointmentRecord {
  const serviceCategoryName = row.categoryName ?? null;
  return {
    id: row.id,
    appointmentId: row.appointmentId ?? null,
    internalId: row.internalId ?? null,
    locationId: row.locationId ?? null,
    locationName: null,
    clientId: row.clientId ?? null,
    clientName: row.clientName ?? null,
    clientPhone: row.clientPhone ?? null,
    staffId: row.staffId ?? null,
    stylistId: row.stylistId ?? null,
    stylistName: null,
    serviceId: row.serviceId ?? null,
    serviceName: row.serviceNameRaw ?? null,
    serviceNameRaw: row.serviceNameRaw ?? null,
    serviceCategoryName,
    startsAt: row.startAt ?? row.startsAt ?? null,
    endsAt: row.endAt ?? row.endsAt ?? null,
    durationMinutes: row.durationMinutes ?? null,
    status: row.status ?? null,
    statusCode: row.statusCode ?? null,
    statusDescription: row.statusDescription ?? null,
    categoryId: row.categoryId ?? null,
    categoryName: row.categoryName ?? null,
    descriptionText: row.descriptionText ?? null,
    clientNotes: row.clientNotes ?? null,
    total: row.total ?? null,
    createdAtRemote: row.createdAtRemote ?? null,
    updatedAtRemote: row.updatedAtRemote ?? null,
    syncedAt: row.syncedAt,
  };
}

type AppointmentLookupMaps = {
  locationsById: Map<string, schema.Location>;
  stylistsByScopedPrivateId: Map<string, schema.Stylist>;
  stylistsByPrivateId: Map<string, schema.Stylist>;
  clientsById: Map<string, schema.Client>;
  servicesByScopedPrivateId: Map<string, schema.Service>;
  servicesByPrivateId: Map<string, schema.Service>;
};

function buildAppointmentLookups(db: ReturnType<typeof initializeDatabase>['db'], teamId: string): AppointmentLookupMaps {
  const locationsById = new Map<string, schema.Location>();
  for (const row of db.select().from(schema.locations).where(eq(schema.locations.teamId, teamId)).all() as schema.Location[]) {
    locationsById.set(row.id, row);
  }

  const stylistsByScopedPrivateId = new Map<string, schema.Stylist>();
  const stylistsByPrivateId = new Map<string, schema.Stylist>();
  for (const row of db.select().from(schema.stylists).where(eq(schema.stylists.teamId, teamId)).all() as schema.Stylist[]) {
    const privateId = cleanString(row.privateId);
    if (!privateId) continue;
    if (row.locationId) stylistsByScopedPrivateId.set(`${row.locationId}:${privateId}`, row);
    if (!stylistsByPrivateId.has(privateId)) stylistsByPrivateId.set(privateId, row);
  }

  const clientsById = new Map<string, schema.Client>();
  for (const row of db.select().from(schema.clients).where(eq(schema.clients.teamId, teamId)).all() as schema.Client[]) {
    clientsById.set(row.id, row);
  }

  const servicesByScopedPrivateId = new Map<string, schema.Service>();
  const servicesByPrivateId = new Map<string, schema.Service>();
  for (const row of db.select().from(schema.services).where(eq(schema.services.teamId, teamId)).all() as schema.Service[]) {
    const privateId = cleanString(row.privateId);
    if (!privateId) continue;
    if (row.locationId) servicesByScopedPrivateId.set(`${row.locationId}:${privateId}`, row);
    if (!servicesByPrivateId.has(privateId)) servicesByPrivateId.set(privateId, row);
  }

  return {
    locationsById,
    stylistsByScopedPrivateId,
    stylistsByPrivateId,
    clientsById,
    servicesByScopedPrivateId,
    servicesByPrivateId,
  };
}

function findAppointmentStylist(row: schema.Appointment, lookups: AppointmentLookupMaps): schema.Stylist | null {
  const privateId = cleanString(row.stylistId ?? row.staffId);
  if (!privateId) return null;
  if (row.locationId) {
    const scoped = lookups.stylistsByScopedPrivateId.get(`${row.locationId}:${privateId}`);
    if (scoped) return scoped;
  }
  return lookups.stylistsByPrivateId.get(privateId) || null;
}

function findAppointmentService(row: schema.Appointment, lookups: AppointmentLookupMaps): schema.Service | null {
  const privateId = cleanString(row.serviceId);
  if (!privateId) return null;
  if (row.locationId) {
    const scoped = lookups.servicesByScopedPrivateId.get(`${row.locationId}:${privateId}`);
    if (scoped) return scoped;
  }
  return lookups.servicesByPrivateId.get(privateId) || null;
}

function mapAppointmentRecordWithLookups(row: schema.Appointment, lookups: AppointmentLookupMaps): AppointmentRecord {
  const base = mapAppointmentRecord(row);
  const location = row.locationId ? lookups.locationsById.get(row.locationId) : null;
  const stylist = findAppointmentStylist(row, lookups);
  const client = row.clientId ? lookups.clientsById.get(row.clientId) : null;
  const service = findAppointmentService(row, lookups);
  return {
    ...base,
    locationName: location?.name ?? null,
    clientName: base.clientName || client?.fullName || null,
    clientPhone: base.clientPhone || client?.mobilePhone || client?.phone || client?.homePhone || client?.businessPhone || null,
    stylistName: stylist?.fullName ?? normalizeFullName(stylist as any) ?? null,
    serviceName: service?.name ?? base.serviceNameRaw ?? null,
    serviceCategoryName: service?.categoryName ?? base.serviceCategoryName,
  };
}

function mapAppointmentDetailRecord(row: schema.Appointment, lookups: AppointmentLookupMaps): AppointmentDetailRecord {
  const base = mapAppointmentRecordWithLookups(row, lookups);
  return {
    ...base,
    serviceNameNorm: row.serviceNameNorm ?? null,
    descriptionHtml: row.descriptionHtml ?? null,
    referrer: row.referrer ?? null,
    promotionCode: row.promotionCode ?? null,
    arrivalNote: row.arrivalNote ?? null,
    reminderSent: row.reminderSent ?? null,
    cancelledFlag: row.cancelledFlag ?? null,
    onlineBooking: row.onlineBooking ?? null,
    newClient: row.newClient ?? null,
    isClass: row.isClass ?? null,
    processingLength: row.processingLength ?? null,
    grossAmount: row.grossAmount ?? null,
    discountAmount: row.discountAmount ?? null,
    netAmount: row.netAmount ?? null,
    createdBy: row.createdBy ?? null,
    updatedBy: row.updatedBy ?? null,
    raw: safeJsonParse(row.raw ?? null),
  };
}

function mapSyncRun(row: schema.SyncRun): SyncRunRecord {
  return {
    id: row.id,
    resource: row.resource,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? null,
    rowsSeen: row.rowsSeen ?? null,
    rowsWritten: row.rowsWritten ?? null,
    pageCount: row.pageCount ?? null,
    notes: row.notes ?? null,
    error: row.error ?? null,
  };
}

function mapServiceRecord(row: schema.Service): ServiceRecord {
  return {
    id: row.id,
    serviceId: row.privateId ?? (row.id.includes(':') ? row.id.split(':').slice(1).join(':') : row.id),
    locationId: row.locationId ?? null,
    name: row.name ?? null,
    categoryId: row.categoryId ?? null,
    categoryName: row.categoryName ?? null,
    durationMinutes: row.durationMinutes ?? null,
    lengthDisplay: row.lengthDisplay ?? null,
    price: row.price ?? null,
    priceDisplay: row.priceDisplay ?? null,
    active: row.active ?? null,
    staffPriceCount: row.staffPriceCount ?? null,
    syncedAt: row.syncedAt,
  };
}

function mapServiceDetailRecord(row: schema.Service): ServiceDetailRecord {
  return {
    ...mapServiceRecord(row),
    localId: row.id,
    description: row.description ?? null,
    staffPriceOverrides: safeJsonParse(row.staffPriceOverrides ?? null),
    raw: safeJsonParse(row.raw ?? null),
  };
}

function parseDurationMinutes(value: unknown): number | null {
  const text = cleanString(value);
  if (!text) return null;
  let total = 0;
  const hourMatch = text.match(/(\d+)\s*hr/i);
  const minuteMatch = text.match(/(\d+)\s*min/i);
  if (hourMatch) total += Number(hourMatch[1]) * 60;
  if (minuteMatch) total += Number(minuteMatch[1]);
  return total > 0 ? total : null;
}

function normalizeNameForLookup(value: unknown): string | null {
  const text = cleanString(value);
  return text ? text.replace(/\s+/g, ' ').trim().toLowerCase() : null;
}

function stripHtml(value: unknown): string | null {
  const text = cleanString(value);
  if (!text) return null;
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
  return plain || null;
}

function localIsoFromParts(item: Record<string, any>, hourKey: 'startHour' | 'endHour', minuteKey: 'startMinute' | 'endMinute'): string | null {
  const year = Number(item?.year);
  const month = Number(item?.month);
  const day = Number(item?.day);
  const hour = Number(item?.[hourKey]);
  const minute = Number(item?.[minuteKey]);
  if (![year, month, day, hour, minute].every((n) => Number.isFinite(n))) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

function computeDurationMinutes(item: Record<string, any>): number | null {
  const startHour = Number(item?.startHour);
  const startMinute = Number(item?.startMinute);
  const endHour = Number(item?.endHour);
  const endMinute = Number(item?.endMinute);
  if (![startHour, startMinute, endHour, endMinute].every((n) => Number.isFinite(n))) return null;
  return (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
}

function collectStylistProfileDetails(profile: Record<string, any> | null): { categoryNames: string[]; serviceIds: string[]; serviceNames: string[] } {
  const categoryNames = new Set<string>();
  const serviceIds = new Set<string>();
  const serviceNames = new Set<string>();
  const categories = Array.isArray(profile?.serviceCategories) ? profile.serviceCategories : [];
  for (const category of categories) {
    const categoryName = cleanString(category?.categoryName ?? category?.category);
    if (categoryName) categoryNames.add(categoryName);
    const services = Array.isArray(category?.services) ? category.services : [];
    for (const service of services) {
      const serviceId = cleanString(service?.serviceId);
      const serviceName = cleanString(service?.serviceName ?? service?.name);
      if (serviceId) serviceIds.add(serviceId);
      if (serviceName) serviceNames.add(serviceName);
    }
  }
  return {
    categoryNames: Array.from(categoryNames),
    serviceIds: Array.from(serviceIds),
    serviceNames: Array.from(serviceNames),
  };
}

function parseBooleanFilter(value: string | undefined): boolean | null {
  if (value == null || value === '') return null;
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'active'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'inactive'].includes(normalized)) return false;
  return null;
}

const NUMERIC_SORT_FIELDS = new Set(['totalVisits', 'totalSpend']);
const DATE_SORT_FIELDS = new Set(['lastVisitAt', 'syncedAt', 'createdAtRemote']);
const STRING_SORT_FIELDS = new Set(['fullName', 'firstName', 'lastName']);

function parseSort(query: Record<string, string | undefined>): { field: string; direction: 'asc' | 'desc' } {
  const allowed = new Set<string>([
    ...STRING_SORT_FIELDS,
    ...DATE_SORT_FIELDS,
    ...NUMERIC_SORT_FIELDS,
  ]);
  const field = allowed.has(String(query.sort || '')) ? String(query.sort) : 'syncedAt';
  const direction = String(query.direction || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
  return { field, direction };
}

function upsertSyncState(db: ReturnType<typeof initializeDatabase>['db'], teamId: string, resource: string, values: { lastSyncedAt?: string | null; lastSuccessAt?: string | null; lastError?: string | null; rowCount?: number | null }) {
  db.run(sql`INSERT INTO sync_state (team_id, resource, last_synced_at, last_success_at, last_error, row_count)
             VALUES (${teamId}, ${resource}, ${values.lastSyncedAt ?? null}, ${values.lastSuccessAt ?? null}, ${values.lastError ?? null}, ${values.rowCount ?? null})
             ON CONFLICT(team_id, resource) DO UPDATE SET
               last_synced_at = ${values.lastSyncedAt ?? null},
               last_success_at = COALESCE(${values.lastSuccessAt ?? null}, last_success_at),
               last_error = ${values.lastError ?? null},
               row_count = COALESCE(${values.rowCount ?? null}, row_count)`);
}

function writeExportFiles(teamId: string, db: ReturnType<typeof initializeDatabase>['db']): ExportManifestRecord {
  const exportedAt = new Date().toISOString();
  const stamp = exportedAt.replace(/[:.]/g, '-');
  const dir = path.join(process.env.HOME || '', '.openclaw', 'kitchen', 'plugins', 'yot', 'exports', teamId, stamp);
  mkdirSync(dir, { recursive: true });

  const files: Array<{ name: string; rows: number }> = [];
  const datasets: Array<{ name: string; rows: unknown[] }> = [
    { name: 'clients.json', rows: db.select().from(schema.clients).where(eq(schema.clients.teamId, teamId)).all() },
    { name: 'locations.json', rows: db.select().from(schema.locations).where(eq(schema.locations.teamId, teamId)).all() },
    { name: 'stylists.json', rows: db.select().from(schema.stylists).where(eq(schema.stylists.teamId, teamId)).all() },
    { name: 'appointments.json', rows: db.select().from(schema.appointments).where(eq(schema.appointments.teamId, teamId)).all() },
    { name: 'services.json', rows: db.select().from(schema.services).where(eq(schema.services.teamId, teamId)).all() },
    { name: 'sync-state.json', rows: db.select().from(schema.syncState).where(eq(schema.syncState.teamId, teamId)).all() },
    { name: 'sync-runs.json', rows: db.select().from(schema.syncRuns).where(eq(schema.syncRuns.teamId, teamId)).all() },
  ];

  for (const dataset of datasets) {
    writeFileSync(path.join(dir, dataset.name), `${JSON.stringify(dataset.rows, null, 2)}\n`, 'utf8');
    files.push({ name: dataset.name, rows: dataset.rows.length });
  }

  const manifest: ExportManifestRecord = { teamId, exportedAt, directory: dir, files };
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export async function handleRequest(req: PluginRequest, _ctx: KitchenPluginContext): Promise<PluginResponse> {
  const teamId = getTeamId(req);

  if (req.path === '/ping' && req.method === 'GET') {
    const config = readYotConfig(teamId);
    if (!config) return { status: 200, data: { ok: true, yotConfigured: false } };
    const result = await ping(config);
    return { status: 200, data: { ok: true, yotConfigured: true, yot: result } };
  }

  if (req.path === '/health' && req.method === 'GET') {
    const config = readYotConfig(teamId);
    const { db, sqlite } = initializeDatabase(teamId);
    // Graceful count helper: if a table doesn't exist yet (e.g. a new
    // resource whose migration hasn't run in this DB), return 0 instead of
    // crashing /health.
    const safeCount = (table: string): number => {
      try {
        const row: any = sqlite.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE team_id = ?`).get(teamId);
        return Number(row?.c || 0);
      } catch {
        return 0;
      }
    };
    const syncRows = (() => {
      try { return db.select().from(schema.syncState).where(eq(schema.syncState.teamId, teamId)).all(); }
      catch { return []; }
    })();
    const counts = {
      clients: safeCount('clients'),
      locations: safeCount('locations'),
      stylists: safeCount('stylists'),
      appointments: safeCount('appointments'),
      services: safeCount('services'),
      promotions: safeCount('promotions'),
      promotion_usage: safeCount('promotion_usage'),
      revenue_facts: (() => {
        // revenue_facts is keyed on team_id as well but doesn't scope by ID;
        // reuse the helper for consistency.
        return safeCount('revenue_facts');
      })(),
    };
    // Migration status: read __yot_migrations and report the highest applied
    // filename (which is also our schema version marker since filenames are
    // numerically prefixed: 0001_, 0002_, 0003_...).
    let migrations: { version: string | null; applied: string[] } = { version: null, applied: [] };
    try {
      const rows: any[] = sqlite.prepare('SELECT name FROM __yot_migrations ORDER BY name ASC').all();
      const applied = rows.map((r) => r.name as string);
      migrations = { version: applied[applied.length - 1] || null, applied };
    } catch {
      migrations = { version: null, applied: [] };
    }
    // Per-resource last_success_at for dashboard freshness checks.
    const lastSuccessByResource: Record<string, string | null> = {};
    for (const resource of schema.SYNC_RESOURCES) {
      const row = syncRows.find((r: schema.SyncRun | any) => r.resource === resource);
      lastSuccessByResource[resource] = row?.lastSuccessAt ?? null;
    }
    return {
      status: 200,
      data: {
        ok: true,
        teamId,
        yotConfigured: Boolean(config),
        dbMode: `yot-${teamId}.db`,
        migrations,
        counts,
        lastSuccessByResource,
        syncState: syncRows,
      },
    };
  }

  if (req.path === '/config' && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const rows = db.select().from(schema.pluginConfig).where(eq(schema.pluginConfig.teamId, teamId)).all();
      const config: Record<string, unknown> = {};
      for (const row of rows) {
        try { config[row.key] = JSON.parse(row.value); } catch { config[row.key] = row.value; }
      }
      return { status: 200, data: { config } };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read config');
    }
  }

  if (req.path === '/config' && req.method === 'POST') {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const { db } = initializeDatabase(teamId);
      const now = new Date().toISOString();
      for (const [key, value] of Object.entries(body)) {
        const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
        const existing = db.select().from(schema.pluginConfig)
          .where(and(eq(schema.pluginConfig.teamId, teamId), eq(schema.pluginConfig.key, key))).all();
        if (existing.length) {
          db.update(schema.pluginConfig).set({ value: valueStr, updatedAt: now })
            .where(and(eq(schema.pluginConfig.teamId, teamId), eq(schema.pluginConfig.key, key))).run();
        } else {
          db.insert(schema.pluginConfig).values({ teamId, key, value: valueStr, updatedAt: now }).run();
        }
      }
      return { status: 200, data: { ok: true, keys: Object.keys(body) } };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to save config');
    }
  }

  if (req.path === '/business' && req.method === 'GET') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');
    try {
      const data = await fetchBusiness(config);
      return { status: 200, data };
    } catch (error: any) {
      return apiError(502, 'YOT_ERROR', error?.message || String(error));
    }
  }

  if (req.path === '/revenue' && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const grain = parseRevenueGrain(req.query.grain);
      const locationId = cleanString(req.query.locationId || req.query.location);
      const allRows = listRevenueFacts(db, teamId, { locationId });
      const requestedStart = toDateOnlyInput(req.query.startDate || req.query.dateFrom || req.query.start);
      const requestedEnd = toDateOnlyInput(req.query.endDate || req.query.dateTo || req.query.end);
      const range = resolveRevenueDateRange(allRows, requestedStart, requestedEnd);
      const rows = allRows.filter((row) => (!range.startDate || row.date >= range.startDate) && (!range.endDate || row.date <= range.endDate));
      return {
        status: 200,
        data: {
          grain,
          locationId,
          startDate: range.startDate,
          endDate: range.endDate,
          availableRange: {
            minDate: range.minDate,
            maxDate: range.maxDate,
          },
          totals: computeRevenueTotals(rows),
          byPeriod: buildRevenueByPeriod(rows, grain),
          byLocation: buildRevenueByLocation(rows),
          byPeriodLocation: buildRevenueByPeriodLocation(rows, grain),
        },
      };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read revenue facts');
    }
  }

  if (req.path === '/revenue/sync' && req.method === 'POST') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');
    try {
      const requestedStart = toDateOnlyInput(req.query.startDate || req.query.dateFrom || req.query.start);
      const requestedEnd = toDateOnlyInput(req.query.endDate || req.query.dateTo || req.query.end);
      const explicitDays = req.query.days != null;
      const noExplicit = !requestedStart && !requestedEnd && !explicitDays;
      let startDate: string;
      let endDate: string;
      if (noExplicit) {
        const auto = autoResumeRange(teamId, 'revenue_facts');
        startDate = auto.startDate;
        endDate = auto.endDate;
      } else {
        const days = clampDays(parseInt(req.query.days || '1', 10), 1);
        const includeToday = parseBooleanFilter(req.query.includeToday) === true;
        const anchorEnd = includeToday ? dateOnlyNow() : addDaysToDateOnly(dateOnlyNow(), -1);
        endDate = requestedEnd || anchorEnd;
        startDate = requestedStart || addDaysToDateOnly(endDate, -(days - 1));
      }
      const organisationId = Number(cleanString(req.query.organisationId || req.query.org) || String(DEFAULT_REVENUE_ORGANISATION_ID));
      if (!Number.isFinite(organisationId)) return apiError(400, 'BAD_REQUEST', 'organisationId must be a number');
      const locationIdText = cleanString(req.query.locationId || req.query.location);
      const staffIdText = cleanString(req.query.staffId || req.query.staff);
      const dayOfWeekText = cleanString(req.query.dayOfWeek);
      const locationId = locationIdText ? Number(locationIdText) : null;
      const staffId = staffIdText ? Number(staffIdText) : null;
      const dayOfWeek = dayOfWeekText ? Number(dayOfWeekText) : null;
      if (locationIdText && !Number.isFinite(locationId)) return apiError(400, 'BAD_REQUEST', 'locationId must be numeric');
      if (staffIdText && !Number.isFinite(staffId)) return apiError(400, 'BAD_REQUEST', 'staffId must be numeric');
      if (dayOfWeekText && !Number.isFinite(dayOfWeek)) return apiError(400, 'BAD_REQUEST', 'dayOfWeek must be numeric');

      const result = await syncRevenueFactsRangeFromDailyRevenueSummary({
        teamId,
        startDateIso: toIsoDayStart(startDate),
        endDateIso: toIsoDayStart(endDate),
        organisationId,
        locationId,
        staffId,
        dayOfWeek,
      });
      return { status: 200, data: { ok: true, ...result } };
    } catch (error: any) {
      return apiError(502, 'YOT_ERROR', error?.message || 'Failed to sync revenue facts');
    }
  }

  // ─── Monthly Performance Summary ────────────────────────────────────────
  // GET /monthly-performance?yearMonth=YYYY-MM (default = current month, UTC)
  // → returns { yearMonth, locations: [...], totals: {...} } from cache.
  if (req.path === '/monthly-performance' && req.method === 'GET') {
    try {
      const { db, sqlite } = initializeDatabase(teamId);
      const yearMonth = cleanString(req.query.yearMonth || req.query.month) || new Date().toISOString().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(yearMonth)) return apiError(400, 'BAD_REQUEST', 'yearMonth must be YYYY-MM');
      const locations = db.select().from(schema.locations).where(eq(schema.locations.teamId, teamId)).all() as schema.Location[];
      const nameById = new Map<string, string | null>(locations.map((l) => [l.id, l.name ?? null]));
      type MpsRow = {
        locationId: string;
        yearMonth: string;
        appointments: number | null;
        cancelled: number | null;
        noShows: number | null;
        onlineBookings: number | null;
        newClients: number | null;
        totalClients: number | null;
        salesCount: number | null;
        salesPerDay: number | null;
        voucherCount: number | null;
        productSales: number | null;
        serviceSales: number | null;
        totalSales: number | null;
        yoyAmount: number | null;
        yoyPct: number | null;
        lastUpdatedAt: string | null;
      };
      const rows = sqlite.prepare(
        `SELECT location_id AS locationId, year_month AS yearMonth,
          appointments, cancelled, no_shows AS noShows, online_bookings AS onlineBookings,
          new_clients AS newClients, total_clients AS totalClients,
          sales_count AS salesCount, sales_per_day AS salesPerDay, voucher_count AS voucherCount,
          product_sales AS productSales, service_sales AS serviceSales, total_sales AS totalSales,
          yoy_amount AS yoyAmount, yoy_pct AS yoyPct, last_updated_at AS lastUpdatedAt
         FROM monthly_performance_facts WHERE team_id = ? AND year_month = ?
         ORDER BY total_sales DESC`,
      ).all(teamId, yearMonth) as MpsRow[];
      const enriched = rows.map((r) => ({ ...r, locationName: nameById.get(r.locationId) ?? null }));
      const lastUpdatedAt = enriched.reduce<string | null>((acc, r) => mostRecentIso(acc, r.lastUpdatedAt || null), null);
      return { status: 200, data: { ok: true, yearMonth, locationCount: enriched.length, lastUpdatedAt, locations: enriched } };
    } catch (error: any) {
      return apiError(500, 'INTERNAL', error?.message || 'Failed to read monthly performance facts');
    }
  }

  // POST /monthly-performance/sync?yearMonth=YYYY-MM
  // Pulls the YOT MonthlyPerformanceSummary report for the given month and
  // upserts per-location facts. Sync is per-location-resolved by name.
  if (req.path === '/monthly-performance/sync' && req.method === 'POST') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');
    try {
      const yearMonth = cleanString(req.query.yearMonth || req.query.month) || new Date().toISOString().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(yearMonth)) return apiError(400, 'BAD_REQUEST', 'yearMonth must be YYYY-MM');
      const [yearStr, monthStr] = yearMonth.split('-');
      const year = Number(yearStr); const month = Number(monthStr);
      const startDate = `${yearMonth}-01`;
      const endDate = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      const organisationId = Number(cleanString(req.query.organisationId || req.query.org) || String(DEFAULT_REVENUE_ORGANISATION_ID));
      if (!Number.isFinite(organisationId)) return apiError(400, 'BAD_REQUEST', 'organisationId must be a number');

      const params = {
        startDateIso: `${startDate}T00:00:00`,
        endDateIso: `${endDate}T00:00:00`,
        organisationId,
        locationId: null,
        staffId: null,
      };
      const client = createReportClient(config);
      const r = reportRegistry.monthlyPerformanceSummary;
      const defs = await client.getParameters(r.reportType, r.buildParameterDiscovery(params, config.apiKey));
      const inst = await client.createInstance(r.reportType, r.buildInstanceParams(params));
      const doc = await client.createDocument(inst, r.preferredFormat);
      await client.waitForDocument(inst, doc.documentId);
      const file = await client.fetchDocument(inst, doc.documentId);
      const parsed = r.parseDocument(file.buffer, defs);

      const { db, sqlite } = initializeDatabase(teamId);
      const locations = db.select().from(schema.locations).where(eq(schema.locations.teamId, teamId)).all() as schema.Location[];
      const lookup = new Map<string, schema.Location[]>();
      for (const loc of locations) {
        const key = normalizeNameForLookup(loc.name);
        if (!key) continue;
        const bucket = lookup.get(key) || [];
        bucket.push(loc); lookup.set(key, bucket);
      }
      function resolveLocationId(name: string): string | null {
        const key = normalizeNameForLookup(name);
        if (!key) return null;
        const matches = lookup.get(key) || [];
        if (matches.length === 1) return matches[0]!.id;
        return matches.find((l) => cleanString(l.name) === cleanString(name))?.id || null;
      }

      const upsert = sqlite.prepare(
        `INSERT INTO monthly_performance_facts (
          team_id, location_id, year_month,
          appointments, cancelled, no_shows, online_bookings, new_clients, total_clients,
          sales_count, sales_per_day, voucher_count,
          product_sales, service_sales, total_sales,
          yoy_amount, yoy_pct, last_updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (team_id, location_id, year_month) DO UPDATE SET
          appointments = excluded.appointments,
          cancelled = excluded.cancelled,
          no_shows = excluded.no_shows,
          online_bookings = excluded.online_bookings,
          new_clients = excluded.new_clients,
          total_clients = excluded.total_clients,
          sales_count = excluded.sales_count,
          sales_per_day = excluded.sales_per_day,
          voucher_count = excluded.voucher_count,
          product_sales = excluded.product_sales,
          service_sales = excluded.service_sales,
          total_sales = excluded.total_sales,
          yoy_amount = excluded.yoy_amount,
          yoy_pct = excluded.yoy_pct,
          last_updated_at = excluded.last_updated_at`,
      );

      const startedAt = new Date().toISOString();
      let rowsWritten = 0; let unmatched = 0;
      for (const row of parsed.rows) {
        if (row.rowKind !== 'monthDetail' || !row.locationName) continue;
        const locationId = resolveLocationId(row.locationName);
        if (!locationId) { unmatched += 1; continue; }
        upsert.run(
          teamId, locationId, yearMonth,
          row.appointments, row.cancelled, row.noShows, row.onlineBookings, row.newClients, row.totalClients,
          row.salesCount, row.salesPerDay, row.voucherCount,
          row.productSales, row.serviceSales, row.totalSales,
          row.yoyAmount, row.yoyPct, startedAt,
        );
        rowsWritten += 1;
      }
      return { status: 200, data: { ok: true, yearMonth, startDate, endDate, rowsWritten, unmatched, locationCount: parsed.locations.length, startedAt, completedAt: new Date().toISOString() } };
    } catch (error: any) {
      return apiError(502, 'YOT_ERROR', error?.message || 'Failed to sync monthly performance');
    }
  }

  // ─── Weekly Performance (MonthlyPerformanceSummary, on-demand) ─────────
  // GET /weekly-performance?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  // Reuses the MonthlyPerformanceSummary YOT report — it accepts arbitrary
  // date ranges and returns per-(location, month) detail rows. We aggregate
  // per location across whatever month-detail rows fall in the requested
  // range so a week that crosses a month boundary still returns one row
  // per location. Fetched fresh each call (no DB cache yet); takes ~30-60s
  // because it's a Telerik report fetch. Powers /weekly-marketing's new
  // Location Performance Ranking section on the dashboard.
  if (req.path === '/weekly-performance' && req.method === 'GET') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');
    try {
      const startDate = toDateOnlyInput(req.query.startDate || req.query.start);
      const endDate = toDateOnlyInput(req.query.endDate || req.query.end);
      if (!startDate || !endDate) return apiError(400, 'BAD_REQUEST', 'startDate and endDate required (YYYY-MM-DD)');
      const organisationId = Number(cleanString(req.query.organisationId || req.query.org) || String(DEFAULT_REVENUE_ORGANISATION_ID));
      if (!Number.isFinite(organisationId)) return apiError(400, 'BAD_REQUEST', 'organisationId must be a number');

      const params = {
        startDateIso: `${startDate}T00:00:00`,
        endDateIso: `${endDate}T00:00:00`,
        organisationId,
        locationId: null,
        staffId: null,
      };
      const client = createReportClient(config);
      const r = reportRegistry.monthlyPerformanceSummary;
      const defs = await client.getParameters(r.reportType, r.buildParameterDiscovery(params, config.apiKey));
      const inst = await client.createInstance(r.reportType, r.buildInstanceParams(params));
      const doc = await client.createDocument(inst, r.preferredFormat);
      await client.waitForDocument(inst, doc.documentId);
      const file = await client.fetchDocument(inst, doc.documentId);
      const parsed = r.parseDocument(file.buffer, defs);

      // Aggregate per location across any monthDetail rows that fall in the
      // requested range. For week ranges that fit inside one month each
      // location has 1 row; for week ranges that cross a month boundary
      // (e.g. Apr 27 - May 3) each location has 2 rows that we sum.
      type Acc = {
        locationName: string;
        appointments: number; cancelled: number; noShows: number;
        salesCount: number; productSales: number; serviceSales: number;
        totalSales: number; yoyAmount: number;
        // YoY % is already a percent on each row — when a week crosses a
        // month, prefer the latest month's value (last row wins) since
        // there's no clean way to combine two YoY percents.
        yoyPct: number | null;
      };
      const buckets = new Map<string, Acc>();
      for (const row of parsed.rows) {
        if (row.rowKind !== 'monthDetail' || !row.locationName) continue;
        const acc = buckets.get(row.locationName) || {
          locationName: row.locationName,
          appointments: 0, cancelled: 0, noShows: 0,
          salesCount: 0, productSales: 0, serviceSales: 0,
          totalSales: 0, yoyAmount: 0, yoyPct: null,
        };
        acc.appointments += Number(row.appointments || 0);
        acc.cancelled += Number(row.cancelled || 0);
        acc.noShows += Number(row.noShows || 0);
        acc.salesCount += Number(row.salesCount || 0);
        acc.productSales += Number(row.productSales || 0);
        acc.serviceSales += Number(row.serviceSales || 0);
        acc.totalSales += Number(row.totalSales || 0);
        acc.yoyAmount += Number(row.yoyAmount || 0);
        if (row.yoyPct != null) acc.yoyPct = Number(row.yoyPct);
        buckets.set(row.locationName, acc);
      }
      const dayMs = 24 * 60 * 60 * 1000;
      const dayCount = Math.max(1, Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / dayMs) + 1);
      const rows = Array.from(buckets.values()).map((a) => ({
        ...a,
        // Recompute sales/day from the actual day count of the requested
        // range — the report's own salesPerDay is per the response's window.
        salesPerDay: a.salesCount > 0 ? Math.round(a.salesCount / dayCount) : 0,
      })).sort((a, b) => b.totalSales - a.totalSales);
      return { status: 200, data: { ok: true, startDate, endDate, dayCount, rowCount: rows.length, rows } };
    } catch (error: any) {
      return apiError(502, 'YOT_ERROR', error?.message || 'Failed to fetch weekly performance');
    }
  }

  // ─── Staff Performance (StaffPerformance_2121 report) ──────────────────
  // GET /staff-performance?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  // Aggregates per (location, staff) across the requested date range from
  // staff_performance_facts. Sums additive columns; ratios are recomputed
  // from sums. Default range = today (single day) in UTC.
  if (req.path === '/staff-performance' && req.method === 'GET') {
    try {
      const { sqlite } = initializeDatabase(teamId);
      const today = dateOnlyNow();
      const startDate = toDateOnlyInput(req.query.startDate || req.query.start || req.query.date) || today;
      const endDate = toDateOnlyInput(req.query.endDate || req.query.end || req.query.date) || startDate;
      type StaffPerfFact = {
        locationName: string; staffName: string; date: string;
        totalSalesCount: number | null; serviceSold: number | null; servicesValue: number | null;
        servicesPerSale: number | null; productsSold: number | null; productsValue: number | null;
        totalSalesValue: number | null; pointsEarned: number | null; clientsPerPoint: number | null;
        commissionTipsTotal: number | null; avgSaleValue: number | null;
        lastUpdatedAt: string | null;
      };
      const facts = sqlite.prepare(
        `SELECT location_name AS locationName, staff_name AS staffName, date,
          total_sales_count AS totalSalesCount, service_sold AS serviceSold,
          services_value AS servicesValue, services_per_sale AS servicesPerSale,
          products_sold AS productsSold, products_value AS productsValue,
          total_sales_value AS totalSalesValue, points_earned AS pointsEarned,
          clients_per_point AS clientsPerPoint, commission_tips_total AS commissionTipsTotal,
          avg_sale_value AS avgSaleValue, last_updated_at AS lastUpdatedAt
         FROM staff_performance_facts WHERE team_id = ? AND date BETWEEN ? AND ?`,
      ).all(teamId, startDate, endDate) as StaffPerfFact[];

      type Acc = {
        locationName: string; staffName: string;
        totalSalesCount: number; serviceSold: number; servicesValue: number;
        productsSold: number; productsValue: number; totalSalesValue: number;
        pointsEarned: number; commissionTipsTotal: number;
      };
      const buckets = new Map<string, Acc>();
      let lastUpdatedAt: string | null = null;
      for (const f of facts) {
        const key = `${f.locationName}::${f.staffName}`;
        const acc = buckets.get(key) || {
          locationName: f.locationName, staffName: f.staffName,
          totalSalesCount: 0, serviceSold: 0, servicesValue: 0,
          productsSold: 0, productsValue: 0, totalSalesValue: 0,
          pointsEarned: 0, commissionTipsTotal: 0,
        };
        acc.totalSalesCount += Number(f.totalSalesCount || 0);
        acc.serviceSold += Number(f.serviceSold || 0);
        acc.servicesValue += Number(f.servicesValue || 0);
        acc.productsSold += Number(f.productsSold || 0);
        acc.productsValue += Number(f.productsValue || 0);
        acc.totalSalesValue += Number(f.totalSalesValue || 0);
        acc.pointsEarned += Number(f.pointsEarned || 0);
        acc.commissionTipsTotal += Number(f.commissionTipsTotal || 0);
        buckets.set(key, acc);
        lastUpdatedAt = mostRecentIso(lastUpdatedAt, f.lastUpdatedAt);
      }
      const rows = Array.from(buckets.values()).map((a) => ({
        ...a,
        // Recompute ratios from sums so multi-day ranges aggregate correctly.
        servicesPerSale: a.totalSalesCount > 0 ? a.serviceSold / a.totalSalesCount : null,
        avgSaleValue: a.totalSalesCount > 0 ? a.totalSalesValue / a.totalSalesCount : null,
        clientsPerPoint: a.pointsEarned > 0 ? a.totalSalesCount / a.pointsEarned : null,
      })).sort((a, b) => b.totalSalesValue - a.totalSalesValue);
      return { status: 200, data: { ok: true, startDate, endDate, rowCount: rows.length, lastUpdatedAt, rows } };
    } catch (error: any) {
      return apiError(500, 'INTERNAL', error?.message || 'Failed to read staff performance facts');
    }
  }

  // POST /staff-performance/sync?date=YYYY-MM-DD (default today)
  // Pulls the YOT StaffPerformance_2121 report for a single day and upserts
  // per-(location, staff) facts. To sync a range, call once per day.
  if (req.path === '/staff-performance/sync' && req.method === 'POST') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');
    const { db: perfDb } = initializeDatabase(teamId);
    try {
      const date = toDateOnlyInput(req.query.date || req.query.startDate || req.query.start) || dateOnlyNow();
      const organisationId = Number(cleanString(req.query.organisationId || req.query.org) || String(DEFAULT_REVENUE_ORGANISATION_ID));
      if (!Number.isFinite(organisationId)) return apiError(400, 'BAD_REQUEST', 'organisationId must be a number');

      const params = {
        startDateIso: `${date}T00:00:00`,
        endDateIso: `${date}T00:00:00`,
        organisationId,
        locationId: null,
        staffId: null,
      };
      const client = createReportClient(config);
      const r = reportRegistry.staffPerformance;
      const defs = await client.getParameters(r.reportType, r.buildParameterDiscovery(params, config.apiKey));
      const inst = await client.createInstance(r.reportType, r.buildInstanceParams(params));
      const doc = await client.createDocument(inst, r.preferredFormat);
      await client.waitForDocument(inst, doc.documentId);
      const file = await client.fetchDocument(inst, doc.documentId);
      const parsed = r.parseDocument(file.buffer, defs);

      const { sqlite } = initializeDatabase(teamId);
      const startedAt = new Date().toISOString();
      const upsert = sqlite.prepare(
        `INSERT INTO staff_performance_facts (
          team_id, location_name, staff_name, date,
          total_sales_count, service_sold, services_value, services_per_sale,
          average_tip, products_sold, products_value, total_sales_value,
          points_earned, clients_per_point, commission_tips_total, avg_sale_value,
          hours_worked_raw, total_per_hour, last_updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (team_id, location_name, staff_name, date) DO UPDATE SET
          total_sales_count = excluded.total_sales_count,
          service_sold = excluded.service_sold,
          services_value = excluded.services_value,
          services_per_sale = excluded.services_per_sale,
          average_tip = excluded.average_tip,
          products_sold = excluded.products_sold,
          products_value = excluded.products_value,
          total_sales_value = excluded.total_sales_value,
          points_earned = excluded.points_earned,
          clients_per_point = excluded.clients_per_point,
          commission_tips_total = excluded.commission_tips_total,
          avg_sale_value = excluded.avg_sale_value,
          hours_worked_raw = excluded.hours_worked_raw,
          total_per_hour = excluded.total_per_hour,
          last_updated_at = excluded.last_updated_at`,
      );

      // Wipe the day's existing rows first so deletions on YOT side are reflected.
      sqlite.prepare('DELETE FROM staff_performance_facts WHERE team_id = ? AND date = ?').run(teamId, date);
      let rowsWritten = 0;
      for (const row of parsed.rows) {
        if (row.rowKind !== 'staff' || !row.locationName || !row.staffName) continue;
        upsert.run(
          teamId, row.locationName, row.staffName, date,
          row.totalSalesCount, row.serviceSold, row.servicesValue, row.servicesPerSale,
          row.averageTip, row.productsSold, row.productsValue, row.totalSalesValue,
          row.pointsEarned, row.clientsPerPoint, row.commissionTipsTotal, row.avgSaleValue,
          row.hoursWorkedRaw, row.totalPerHour, startedAt,
        );
        rowsWritten += 1;
      }
      const completedAt = new Date().toISOString();
      upsertSyncState(perfDb, teamId, 'staff_performance_facts', {
        lastSyncedAt: completedAt, lastSuccessAt: completedAt, lastError: null, rowCount: rowsWritten,
      });
      return { status: 200, data: { ok: true, date, rowsWritten, locationCount: parsed.locations.length, startedAt, completedAt } };
    } catch (error: any) {
      const now = new Date().toISOString();
      upsertSyncState(perfDb, teamId, 'staff_performance_facts', { lastSyncedAt: now, lastError: error?.message || String(error) });
      return apiError(502, 'YOT_ERROR', error?.message || 'Failed to sync staff performance');
    }
  }

  // ─── Staff Timecards (StaffTimeCardSummary report) ────────────────────
  // GET /staff-timecards?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  // Aggregates staff_timecard_facts over the requested window. Returns
  // per-location stylist rows plus a flagged subset for stylists with
  // more than LATE_THRESHOLD late arrivals.
  if (req.path === '/staff-timecards' && req.method === 'GET') {
    const LATE_THRESHOLD = 4;
    try {
      const { sqlite } = initializeDatabase(teamId);
      const today = dateOnlyNow();
      const firstOfMonth = today.slice(0, 8) + '01';
      const startDate = toDateOnlyInput(req.query.startDate || req.query.start) || firstOfMonth;
      const endDate = toDateOnlyInput(req.query.endDate || req.query.end) || today;

      type ShiftFact = {
        locationName: string | null;
        staffName: string;
        shiftDate: string;
        syncedAt: string;
      };
      const facts = sqlite.prepare(
        `SELECT location_name AS locationName, staff_name AS staffName,
                shift_date AS shiftDate, synced_at AS syncedAt
         FROM staff_timecard_facts
         WHERE team_id = ? AND shift_date BETWEEN ? AND ?`
      ).all(teamId, startDate, endDate) as ShiftFact[];

      // The YOT report is pre-filtered server-side with LateArrivals=-14, so every
      // row coming out of staff_timecard_facts is by definition a late arrival
      // (15+ min past scheduled). No per-row late/on-time recompute is needed —
      // count the rows and take the most recent shift_date as the last-late date.
      type StylistAgg = {
        locationName: string | null;
        staffName: string;
        lateCount: number;
        lastLateDate: string | null;
      };
      const buckets = new Map<string, StylistAgg>();
      let lastSyncedAt: string | null = null;

      for (const f of facts) {
        const key = `${f.locationName ?? ''}::${f.staffName}`;
        const agg = buckets.get(key) || {
          locationName: f.locationName,
          staffName: f.staffName,
          lateCount: 0,
          lastLateDate: null,
        };
        agg.lateCount += 1;
        if (!agg.lastLateDate || f.shiftDate > agg.lastLateDate) {
          agg.lastLateDate = f.shiftDate;
        }
        buckets.set(key, agg);
        if (!lastSyncedAt || f.syncedAt > lastSyncedAt) lastSyncedAt = f.syncedAt;
      }

      // Group by location.
      const locationsMap = new Map<string, { locationName: string; stylists: Array<StylistAgg & { flagged: boolean }> }>();
      for (const agg of buckets.values()) {
        const locKey = agg.locationName ?? '(no location)';
        const bucket = locationsMap.get(locKey) || { locationName: agg.locationName ?? '(no location)', stylists: [] };
        bucket.stylists.push({ ...agg, flagged: agg.lateCount > LATE_THRESHOLD });
        locationsMap.set(locKey, bucket);
      }

      const locations = Array.from(locationsMap.values())
        .sort((a, b) => a.locationName.localeCompare(b.locationName))
        .map((loc) => ({
          ...loc,
          stylists: loc.stylists.sort((a, b) => {
            if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
            if (a.lateCount !== b.lateCount) return b.lateCount - a.lateCount;
            return a.staffName.localeCompare(b.staffName);
          }),
        }));

      const flaggedStylists = Array.from(buckets.values())
        .filter((a) => a.lateCount > LATE_THRESHOLD)
        .sort((a, b) => b.lateCount - a.lateCount)
        .map((a) => ({
          staffName: a.staffName,
          locationName: a.locationName,
          lateCount: a.lateCount,
          lastLateDate: a.lastLateDate,
        }));

      return {
        status: 200,
        data: {
          ok: true,
          scope: { startDate, endDate },
          lateThreshold: LATE_THRESHOLD,
          lastSyncedAt,
          locations,
          flaggedStylists,
        },
      };
    } catch (error: any) {
      return apiError(500, 'INTERNAL', error?.message || 'Failed to read staff timecard facts');
    }
  }

  // POST /staff-timecards/sync?startDate=&endDate=
  // Triggers the sync library. Wraps options in the same way the other
  // /sync endpoints do.
  if (req.path === '/staff-timecards/sync' && req.method === 'POST') {
    const { db } = initializeDatabase(teamId);
    try {
      const today = dateOnlyNow();
      const firstOfMonth = today.slice(0, 8) + '01';
      const startDate = toDateOnlyInput(req.query.startDate || req.query.start) || firstOfMonth;
      const endDate = toDateOnlyInput(req.query.endDate || req.query.end) || today;
      const organisationId = Number(cleanString(req.query.organisationId || req.query.org) || String(DEFAULT_REVENUE_ORGANISATION_ID));
      if (!Number.isFinite(organisationId)) return apiError(400, 'BAD_REQUEST', 'organisationId must be a number');
      const { syncStaffTimecards } = await import('../reports/sync-staff-timecards');
      const result = await syncStaffTimecards({ teamId, startDate, endDate, organisationId });
      const now = new Date().toISOString();
      const rowsWritten = ((result as any)?.rowsInserted || 0) + ((result as any)?.rowsUpdated || 0);
      upsertSyncState(db, teamId, 'staff_timecard_facts', {
        lastSyncedAt: now, lastSuccessAt: now, lastError: null,
        rowCount: rowsWritten || null,
      });
      return { status: 200, data: result };
    } catch (error: any) {
      const now = new Date().toISOString();
      upsertSyncState(db, teamId, 'staff_timecard_facts', { lastSyncedAt: now, lastError: error?.message || String(error) });
      return apiError(500, 'INTERNAL', error?.message || 'Failed to sync staff timecards');
    }
  }

  // ─── Staff Retention (StaffRetentionDay report) ───────────────────────
  // GET /staff-retention?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  // Returns the most-recently-synced retention rows whose period overlaps
  // the requested window. Each row is per (location, staff) and carries
  // counts/percentages for the window plus the trailing-3-month retention.
  if (req.path === '/staff-retention' && req.method === 'GET') {
    try {
      const { sqlite } = initializeDatabase(teamId);
      const today = dateOnlyNow();
      const firstOfMonth = today.slice(0, 8) + '01';
      const startDate = toDateOnlyInput(req.query.startDate || req.query.start) || firstOfMonth;
      const endDate = toDateOnlyInput(req.query.endDate || req.query.end) || today;

      // Match exact window first (the common case after a sync); fall back
      // to the most recent window that contains either endpoint.
      type RetentionRow = {
        periodStart: string;
        periodEnd: string;
        locationName: string;
        staffName: string;
        totalSales: number;
        returnedToStaffCount: number | null;
        returnedToStaffPct: number | null;
        returnedToBusinessCount: number | null;
        returnedToBusinessPct: number | null;
        newClientsCount: number | null;
        newClientsPct: number | null;
        totalRebookedCount: number | null;
        totalRebookedPct: number | null;
        newClientsRebookedCount: number | null;
        newClientsRebookedPct: number | null;
        retentionM1Count: number | null;
        retentionM1Pct: number | null;
        retentionM1Label: string | null;
        retentionM2Count: number | null;
        retentionM2Pct: number | null;
        retentionM2Label: string | null;
        retentionM3Count: number | null;
        retentionM3Pct: number | null;
        retentionM3Label: string | null;
        syncedAt: string;
      };

      const SELECT_RETENTION_COLUMNS = `period_start AS periodStart, period_end AS periodEnd,
                location_name AS locationName, staff_name AS staffName,
                total_sales AS totalSales,
                returned_to_staff_count AS returnedToStaffCount,
                returned_to_staff_pct AS returnedToStaffPct,
                returned_to_business_count AS returnedToBusinessCount,
                returned_to_business_pct AS returnedToBusinessPct,
                new_clients_count AS newClientsCount,
                new_clients_pct AS newClientsPct,
                total_rebooked_count AS totalRebookedCount,
                total_rebooked_pct AS totalRebookedPct,
                new_clients_rebooked_count AS newClientsRebookedCount,
                new_clients_rebooked_pct AS newClientsRebookedPct,
                retention_m1_count AS retentionM1Count,
                retention_m1_pct AS retentionM1Pct,
                retention_m1_label AS retentionM1Label,
                retention_m2_count AS retentionM2Count,
                retention_m2_pct AS retentionM2Pct,
                retention_m2_label AS retentionM2Label,
                retention_m3_count AS retentionM3Count,
                retention_m3_pct AS retentionM3Pct,
                retention_m3_label AS retentionM3Label,
                synced_at AS syncedAt`;

      let rows = sqlite.prepare(
        `SELECT ${SELECT_RETENTION_COLUMNS}
         FROM staff_retention_facts
         WHERE team_id = ? AND period_start = ? AND period_end = ?`,
      ).all(teamId, startDate, endDate) as RetentionRow[];

      let matchedWindow: { startDate: string; endDate: string } | null = rows.length
        ? { startDate, endDate }
        : null;
      let isFallback = false;
      // Stale-window fallback. The nightly sync's window-end advances each
      // day (this-month: 2026-05-01 → today). When YOT returns 0 rows the
      // script keeps the previous good snapshot — but its period_end is
      // pinned to the date of that successful sync. The dashboard's strict
      // exact-match query then sees no data even though we have a valid
      // recent snapshot. Fall back to the latest stored window whose start
      // matches and whose end is on/before the requested end. The dashboard
      // surfaces `isFallback` + the actual matchedWindow so users can see
      // the data is from an earlier snapshot date.
      if (rows.length === 0) {
        const fallback = sqlite.prepare(
          `SELECT period_end AS periodEnd
           FROM staff_retention_facts
           WHERE team_id = ? AND period_start = ? AND period_end <= ?
           ORDER BY period_end DESC
           LIMIT 1`,
        ).get(teamId, startDate, endDate) as { periodEnd: string } | undefined;
        if (fallback) {
          rows = sqlite.prepare(
            `SELECT ${SELECT_RETENTION_COLUMNS}
             FROM staff_retention_facts
             WHERE team_id = ? AND period_start = ? AND period_end = ?`,
          ).all(teamId, startDate, fallback.periodEnd) as RetentionRow[];
          matchedWindow = { startDate, endDate: fallback.periodEnd };
          isFallback = rows.length > 0;
        }
      }
      const hasData = rows.length > 0;

      // Group rows by location
      const locMap = new Map<string, { locationName: string; staff: RetentionRow[] }>();
      let lastSyncedAt: string | null = null;
      const trailingMonthLabels = { m1: null as string | null, m2: null as string | null, m3: null as string | null };
      for (const r of rows) {
        const bucket = locMap.get(r.locationName) || { locationName: r.locationName, staff: [] };
        bucket.staff.push(r);
        locMap.set(r.locationName, bucket);
        if (!lastSyncedAt || r.syncedAt > lastSyncedAt) lastSyncedAt = r.syncedAt;
        if (!trailingMonthLabels.m1 && r.retentionM1Label) trailingMonthLabels.m1 = r.retentionM1Label;
        if (!trailingMonthLabels.m2 && r.retentionM2Label) trailingMonthLabels.m2 = r.retentionM2Label;
        if (!trailingMonthLabels.m3 && r.retentionM3Label) trailingMonthLabels.m3 = r.retentionM3Label;
      }

      const locations = Array.from(locMap.values())
        .sort((a, b) => a.locationName.localeCompare(b.locationName))
        .map((loc) => ({
          locationName: loc.locationName,
          staff: loc.staff.sort((a, b) => (b.totalSales - a.totalSales) || a.staffName.localeCompare(b.staffName)),
        }));

      return {
        status: 200,
        data: {
          ok: true,
          scope: { startDate, endDate },
          matchedWindow,
          isFallback,
          hasData,
          trailingMonthLabels,
          lastSyncedAt,
          locations,
          rowCount: rows.length,
        },
      };
    } catch (error: any) {
      return apiError(500, 'INTERNAL', error?.message || 'Failed to read staff retention facts');
    }
  }

  // GET /new-client-cohort-retention?windowStart=YYYY-MM-DD&windowEnd=YYYY-MM-DD
  // Reads the precomputed `new_client_cohort_retention` table (refreshed
  // nightly via run-new-client-cohort-retention.ts) and maps absolute
  // cohort months to relative M-1/M-2/M-3 buckets based on the requested
  // window's start month.
  if (req.path === '/new-client-cohort-retention' && req.method === 'GET') {
    try {
      const { sqlite } = initializeDatabase(teamId);
      const today = dateOnlyNow();
      const firstOfMonth = today.slice(0, 8) + '01';
      const windowStart = toDateOnlyInput(req.query.windowStart || req.query.start) || firstOfMonth;

      // M-N is the cohort month N months before the window's start month.
      const windowMonth = windowStart.slice(0, 7); // YYYY-MM
      const monthOffset = (ym: string, delta: number): string => {
        const [y, m] = ym.split('-').map(Number);
        const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      };
      const m1 = monthOffset(windowMonth, -1);
      const m2 = monthOffset(windowMonth, -2);
      const m3 = monthOffset(windowMonth, -3);
      const monthList = [m1, m2, m3];

      type Row = {
        scope: 'stylist' | 'location';
        locationId: string;
        locationName: string | null;
        stylistId: string | null;
        stylistName: string | null;
        cohortMonth: string;
        newCount: number;
        returnedCount: number;
        returnedToStylistCount: number | null;
        computedAt: string;
      };
      const placeholders = monthList.map(() => '?').join(',');
      // Join to locations and stylists. Stylists' id format is
      // `<locationId>:<stylistId>`, so we match on the composite key. The
      // dashboard uses stylistName as a first-name-within-location bridge
      // to staff_retention's full staff_name field (e.g. "Kristin" →
      // "Kristin Claybron" at Westland). LEFT JOINs preserve cohort rows
      // when a name lookup misses.
      const rows = sqlite.prepare(`
        SELECT n.scope AS scope, n.location_id AS locationId, l.name AS locationName,
               n.stylist_id AS stylistId, s.full_name AS stylistName,
               n.cohort_month AS cohortMonth, n.new_count AS newCount,
               n.returned_count AS returnedCount,
               n.returned_to_stylist_count AS returnedToStylistCount,
               n.computed_at AS computedAt
        FROM new_client_cohort_retention n
        LEFT JOIN locations l ON l.team_id = n.team_id AND l.id = n.location_id
        LEFT JOIN stylists s ON s.team_id = n.team_id AND s.id = (n.location_id || ':' || n.stylist_id)
        WHERE n.team_id = ?
          AND n.cohort_month IN (${placeholders})
      `).all(teamId, ...monthList) as Row[];

      // Pivot: one record per (scope, locationId, stylistId?) with m1/m2/m3
      // bucket subobjects. Empty bucket = zero counts (cohort had no new
      // clients that month). returnedToStylistCount is nullable on pre-
      // migration-0016 rows; coerce to 0 so the UI can always do math.
      type Bucket = { newCount: number; returnedCount: number; returnedToStylistCount: number };
      type StylistRecord = {
        scope: 'stylist';
        locationId: string;
        locationName: string | null;
        stylistId: string;
        stylistName: string | null;
        m1: Bucket & { month: string };
        m2: Bucket & { month: string };
        m3: Bucket & { month: string };
      };
      type LocationRecord = {
        scope: 'location';
        locationId: string;
        locationName: string | null;
        m1: Bucket & { month: string };
        m2: Bucket & { month: string };
        m3: Bucket & { month: string };
      };
      const stylistMap = new Map<string, StylistRecord>();
      const locationMap = new Map<string, LocationRecord>();
      const blank = (month: string): Bucket & { month: string } => ({ month, newCount: 0, returnedCount: 0, returnedToStylistCount: 0 });

      for (const r of rows) {
        const bucketKey = r.cohortMonth === m1 ? 'm1' : r.cohortMonth === m2 ? 'm2' : 'm3';
        const monthLabel = r.cohortMonth === m1 ? m1 : r.cohortMonth === m2 ? m2 : m3;
        if (r.scope === 'stylist' && r.stylistId) {
          const key = `${r.locationId}::${r.stylistId}`;
          let rec = stylistMap.get(key);
          if (!rec) {
            rec = {
              scope: 'stylist',
              locationId: r.locationId,
              locationName: r.locationName,
              stylistId: r.stylistId,
              stylistName: r.stylistName,
              m1: blank(m1), m2: blank(m2), m3: blank(m3),
            };
            stylistMap.set(key, rec);
          }
          rec[bucketKey] = { month: monthLabel, newCount: r.newCount, returnedCount: r.returnedCount, returnedToStylistCount: r.returnedToStylistCount ?? 0 };
        } else if (r.scope === 'location') {
          let rec = locationMap.get(r.locationId);
          if (!rec) {
            rec = {
              scope: 'location',
              locationId: r.locationId,
              locationName: r.locationName,
              m1: blank(m1), m2: blank(m2), m3: blank(m3),
            };
            locationMap.set(r.locationId, rec);
          }
          rec[bucketKey] = { month: monthLabel, newCount: r.newCount, returnedCount: r.returnedCount, returnedToStylistCount: r.returnedToStylistCount ?? 0 };
        }
      }

      const computedAt = rows.length ? rows.reduce((acc, r) => (r.computedAt > acc ? r.computedAt : acc), rows[0]!.computedAt) : null;
      return {
        status: 200,
        data: {
          windowStart,
          windowMonth,
          months: { m1, m2, m3 },
          computedAt,
          perStylist: Array.from(stylistMap.values()),
          perLocation: Array.from(locationMap.values()),
        },
      };
    } catch (error: any) {
      return apiError(500, 'INTERNAL', error?.message || 'Failed to read new-client cohort retention');
    }
  }

  // POST /new-client-cohort-retention/recompute?startMonth=YYYY-MM&endMonth=YYYY-MM
  // Triggers the local-derived cohort recompute (reads from
  // `appointments`, writes to `new_client_cohort_retention`). Mirrors the
  // staff-retention sync trigger but with no YOT API call — everything's
  // computed off data we already have, so this is fast (<1s for 6 months
  // on a ~100k-row appointments table).
  if (req.path === '/new-client-cohort-retention/recompute' && req.method === 'POST') {
    try {
      const startMonth = (req.query.startMonth as string | undefined) || undefined;
      const endMonth = (req.query.endMonth as string | undefined) || undefined;
      if (startMonth && !/^\d{4}-\d{2}$/.test(startMonth)) return apiError(400, 'BAD_REQUEST', 'startMonth must be YYYY-MM');
      if (endMonth && !/^\d{4}-\d{2}$/.test(endMonth)) return apiError(400, 'BAD_REQUEST', 'endMonth must be YYYY-MM');
      const { computeNewClientCohortRetention } = await import('../reports/compute-new-client-cohort-retention');
      const result = computeNewClientCohortRetention({ teamId, startMonth, endMonth });
      return { status: 200, data: result };
    } catch (error: any) {
      return apiError(500, 'INTERNAL', error?.message || 'Failed to recompute new-client cohort retention');
    }
  }

  // POST /staff-retention/sync?startDate=&endDate=&organisationId=
  if (req.path === '/staff-retention/sync' && req.method === 'POST') {
    const { db } = initializeDatabase(teamId);
    const today = dateOnlyNow();
    const firstOfMonth = today.slice(0, 8) + '01';
    const startDate = toDateOnlyInput(req.query.startDate || req.query.start) || firstOfMonth;
    const endDate = toDateOnlyInput(req.query.endDate || req.query.end) || today;
    try {
      const organisationId = Number(cleanString(req.query.organisationId || req.query.org) || String(DEFAULT_REVENUE_ORGANISATION_ID));
      if (!Number.isFinite(organisationId)) return apiError(400, 'BAD_REQUEST', 'organisationId must be a number');
      const { syncStaffRetention } = await import('../reports/sync-staff-retention');
      const result = await syncStaffRetention({ teamId, startDate, endDate, organisationId });
      const now = new Date().toISOString();
      upsertSyncState(db, teamId, 'staff_retention_facts', {
        lastSyncedAt: now, lastSuccessAt: now, lastError: null,
        rowCount: (result as any)?.rowsWritten ?? (result as any)?.rowsUpserted ?? null,
      });
      return { status: 200, data: result };
    } catch (error: any) {
      const now = new Date().toISOString();
      upsertSyncState(db, teamId, 'staff_retention_facts', { lastSyncedAt: now, lastError: error?.message || String(error) });
      return apiError(500, 'INTERNAL', error?.message || 'Failed to sync staff retention');
    }
  }

  if (req.path === '/promotion-usage' && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const locationId = cleanString(req.query.locationId || req.query.location);
      const allRows = listPromotionUsageRows(db, teamId, { locationId });
      const requestedStart = toDateOnlyInput(req.query.startDate || req.query.dateFrom || req.query.start);
      const requestedEnd = toDateOnlyInput(req.query.endDate || req.query.dateTo || req.query.end);
      const range = resolvePromotionDateRange(allRows, requestedStart, requestedEnd);
      const rows = allRows.filter((row) => (!range.startDate || row.date! >= range.startDate) && (!range.endDate || row.date! <= range.endDate));
      const promotions = buildPromotionSummaries(rows);
      const matrix = buildPromotionMatrix(rows, promotions);
      const data: PromotionUsageQueryResponse = {
        locationId,
        startDate: range.startDate,
        endDate: range.endDate,
        availableRange: {
          minDate: range.minDate,
          maxDate: range.maxDate,
        },
        totals: computePromotionTotals(rows),
        promotions,
        matrixColumns: matrix.matrixColumns,
        matrixRows: matrix.matrixRows,
      };
      return { status: 200, data };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read promotion usage');
    }
  }

  if (req.path === '/promotion-usage/sync' && req.method === 'POST') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');
    try {
      const requestedStart = toDateOnlyInput(req.query.startDate || req.query.dateFrom || req.query.start);
      const requestedEnd = toDateOnlyInput(req.query.endDate || req.query.dateTo || req.query.end);
      const explicitDays = req.query.days != null;
      const noExplicit = !requestedStart && !requestedEnd && !explicitDays;
      let startDate: string;
      let endDate: string;
      if (noExplicit) {
        const auto = autoResumeRange(teamId, 'promotion_usage');
        startDate = auto.startDate;
        endDate = auto.endDate;
      } else {
        const days = clampDays(parseInt(req.query.days || '1', 10), 1);
        const includeToday = parseBooleanFilter(req.query.includeToday) === true;
        const anchorEnd = includeToday ? dateOnlyNow() : addDaysToDateOnly(dateOnlyNow(), -1);
        endDate = requestedEnd || anchorEnd;
        startDate = requestedStart || addDaysToDateOnly(endDate, -(days - 1));
      }
      const locationIdText = cleanString(req.query.locationId || req.query.location);
      const staffIdText = cleanString(req.query.staffId || req.query.staff);
      const locationId = locationIdText ? Number(locationIdText) : null;
      const staffId = staffIdText ? Number(staffIdText) : null;
      if (locationIdText && !Number.isFinite(locationId)) return apiError(400, 'BAD_REQUEST', 'locationId must be numeric');
      if (staffIdText && !Number.isFinite(staffId)) return apiError(400, 'BAD_REQUEST', 'staffId must be numeric');

      const organisationId = Number(cleanString(req.query.organisationId || req.query.org) || String(DEFAULT_REVENUE_ORGANISATION_ID));
      if (!Number.isFinite(organisationId)) return apiError(400, 'BAD_REQUEST', 'organisationId must be a number');

      const result = await syncPromotionUsageRange({
        teamId,
        startDateIso: toIsoDayStart(startDate),
        endDateIso: toIsoDayStart(endDate),
        organisationId,
        locationId,
        staffId,
      });
      return { status: 200, data: { ok: true, ...result } };
    } catch (error: any) {
      return apiError(502, 'YOT_ERROR', error?.message || 'Failed to sync promotion usage');
    }
  }

  if (req.path === '/staff-cashout' && req.method === 'GET') {
    try {
      const { sqlite } = initializeDatabase(teamId);
      const requestedStart = toDateOnlyInput(req.query.startDate || req.query.dateFrom || req.query.start || req.query.date);
      const requestedEnd = toDateOnlyInput(req.query.endDate || req.query.dateTo || req.query.end || req.query.date);
      const anchorEnd = addDaysToDateOnly(dateOnlyNow(), -1);
      const endDate = requestedEnd || anchorEnd;
      const startDate = requestedStart || endDate;
      const locationName = cleanString(req.query.location || req.query.locationName);
      const rows = listStaffCashoutFacts(sqlite, teamId, { startDate, endDate, locationName });
      const lastSyncedAt = (sqlite
        .prepare("SELECT last_synced_at AS lastSyncedAt FROM sync_state WHERE team_id = ? AND resource = 'staff_cashout_facts'")
        .get(teamId) as { lastSyncedAt?: string } | undefined)?.lastSyncedAt || null;
      return { status: 200, data: { startDate, endDate, locationName: locationName || null, rows, lastSyncedAt } };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read staff cashout facts');
    }
  }

  if (req.path === '/payouts' && req.method === 'GET') {
    try {
      const requestedStart = toDateOnlyInput(req.query.startDate || req.query.dateFrom || req.query.start || req.query.date);
      const requestedEnd = toDateOnlyInput(req.query.endDate || req.query.dateTo || req.query.end || req.query.date);
      const anchorEnd = addDaysToDateOnly(dateOnlyNow(), -1);
      const endDate = requestedEnd || anchorEnd;
      const startDate = requestedStart || endDate;
      const locationName = cleanString(req.query.location || req.query.locationName);
      const loaded = listPayoutFactsFromExports({ startDate, endDate, locationName });
      const rows = loaded.rows.filter((row) => asNumber(row.originalPayoutAmount) > 0);
      const locationTotals = buildPayoutLocationTotals(rows);
      const totals = computePayoutTotals(rows);
      return { status: 200, data: { startDate, endDate, locationName: locationName || null, rows, locationTotals, totals, lastSyncedAt: loaded.lastExportedAt } };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read payout export facts');
    }
  }

  if (req.path === '/payouts/sync' && req.method === 'POST') {
    try {
      const requestedStart = toDateOnlyInput(req.query.startDate || req.query.dateFrom || req.query.start || req.query.date);
      const requestedEnd = toDateOnlyInput(req.query.endDate || req.query.dateTo || req.query.end || req.query.date);
      const anchorEnd = addDaysToDateOnly(dateOnlyNow(), -1);
      const endDate = requestedEnd || anchorEnd;
      const startDate = requestedStart || endDate;
      const scriptPath = resolvePluginFile(__dirname, path.join('scripts', 'export-branch-deposits.ts'));
      if (!scriptPath) return apiError(500, 'CONFIG_ERROR', 'Could not locate the branch deposit export script.');

      const results: any[] = [];
      for (let cursor = startDate; cursor <= endDate; cursor = addDaysToDateOnly(cursor, 1)) {
        const out = execFileSync('npx', ['tsx', scriptPath, `--date=${cursor}`, `--teamId=${teamId}`, `--organisationId=${DEFAULT_REVENUE_ORGANISATION_ID}`, `--outputDir=${PAYOUT_EXPORT_DIR}`], {
          encoding: 'utf8',
          maxBuffer: 20 * 1024 * 1024,
        });
        try {
          results.push(JSON.parse(out));
        } catch {
          results.push({ date: cursor, raw: out.trim() });
        }
      }

      return { status: 200, data: { ok: true, startDate, endDate, dayCount: results.length, results } };
    } catch (error: any) {
      return apiError(502, 'EXPORT_ERROR', error?.message || 'Failed to regenerate payout export files');
    }
  }

  if (req.path === '/staff-cashout/sync' && req.method === 'POST') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');
    try {
      const requestedStart = toDateOnlyInput(req.query.startDate || req.query.dateFrom || req.query.start || req.query.date);
      const requestedEnd = toDateOnlyInput(req.query.endDate || req.query.dateTo || req.query.end || req.query.date);
      const noExplicit = !requestedStart && !requestedEnd;
      let startDate: string;
      let endDate: string;
      if (noExplicit) {
        const auto = autoResumeRange(teamId, 'staff_cashout_facts');
        startDate = auto.startDate;
        endDate = auto.endDate;
      } else {
        const anchorEnd = addDaysToDateOnly(dateOnlyNow(), -1);
        endDate = requestedEnd || anchorEnd;
        startDate = requestedStart || endDate;
      }
      const locationIdText = cleanString(req.query.locationId || req.query.location);
      const staffIdText = cleanString(req.query.staffId || req.query.staff);
      const locationId = locationIdText ? Number(locationIdText) : null;
      const staffId = staffIdText ? Number(staffIdText) : null;
      if (locationIdText && !Number.isFinite(locationId)) return apiError(400, 'BAD_REQUEST', 'locationId must be numeric');
      if (staffIdText && !Number.isFinite(staffId)) return apiError(400, 'BAD_REQUEST', 'staffId must be numeric');
      const organisationId = Number(cleanString(req.query.organisationId || req.query.org) || String(DEFAULT_REVENUE_ORGANISATION_ID));
      if (!Number.isFinite(organisationId)) return apiError(400, 'BAD_REQUEST', 'organisationId must be a number');

      const result = await syncStaffCashoutFromReport({
        teamId,
        startDateIso: toIsoDayStart(startDate),
        endDateIso: toIsoDayStart(endDate),
        organisationId,
        locationId,
        staffId,
      });
      return { status: 200, data: { ok: true, startDate: result.startDate, endDate: result.endDate, rowsSeen: result.rowsSeen, rowsWritten: result.rowsWritten } };
    } catch (error: any) {
      return apiError(502, 'YOT_ERROR', error?.message || 'Failed to sync staff cashout');
    }
  }

  if (req.path === '/staff-cashout/run' && req.method === 'POST') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');
    try {
      const requestedStart = toDateOnlyInput(req.query.startDate || req.query.dateFrom || req.query.start);
      const requestedEnd = toDateOnlyInput(req.query.endDate || req.query.dateTo || req.query.end);
      const anchorEnd = addDaysToDateOnly(dateOnlyNow(), -1);
      const endDate = requestedEnd || anchorEnd;
      const startDate = requestedStart || endDate;
      const locationIdText = cleanString(req.query.locationId || req.query.location);
      const staffIdText = cleanString(req.query.staffId || req.query.staff);
      const locationId = locationIdText ? Number(locationIdText) : null;
      const staffId = staffIdText ? Number(staffIdText) : null;
      if (locationIdText && !Number.isFinite(locationId)) return apiError(400, 'BAD_REQUEST', 'locationId must be numeric');
      if (staffIdText && !Number.isFinite(staffId)) return apiError(400, 'BAD_REQUEST', 'staffId must be numeric');
      const organisationId = Number(cleanString(req.query.organisationId || req.query.org) || String(DEFAULT_REVENUE_ORGANISATION_ID));
      if (!Number.isFinite(organisationId)) return apiError(400, 'BAD_REQUEST', 'organisationId must be a number');

      const includeDebugRows = parseBooleanFilter(req.query.debug) === true;
      const result = await runStaffCashoutReport({
        teamId,
        startDateIso: toIsoDayStart(startDate),
        endDateIso: toIsoDayStart(endDate),
        organisationId,
        locationId,
        staffId,
        includeDebugRows,
      });
      return { status: 200, data: { ok: true, startDate, endDate, ...result } };
    } catch (error: any) {
      return apiError(502, 'YOT_ERROR', error?.message || 'Failed to run staff cashout report');
    }
  }

  if (req.path === '/locations' && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const { limit, offset } = parsePagination(req.query);
      const activeFilter = parseBooleanFilter(req.query.active);
      const locationFilter = cleanString(req.query.locationId || req.query.location);
      const stylistFilter = cleanString(req.query.stylistId || req.query.stylist || req.query.staffId);
      const clientFilter = cleanString(req.query.clientId || req.query.client);
      let rows = db.select().from(schema.locations).where(eq(schema.locations.teamId, teamId)).all();
      if (activeFilter !== null) rows = rows.filter((row: schema.Location) => row.active === activeFilter);
      if (locationFilter) rows = rows.filter((row: schema.Location) => row.id === locationFilter);
      if (stylistFilter || clientFilter) {
        const allowedLocationIds = new Set<string>();
        if (stylistFilter) {
          const stylists = db.select().from(schema.stylists).where(eq(schema.stylists.teamId, teamId)).all() as schema.Stylist[];
          for (const stylist of stylists) {
            if (stylist.id === stylistFilter || stylist.privateId === stylistFilter) {
              if (stylist.locationId) allowedLocationIds.add(stylist.locationId);
              if (stylist.sourceLocationId) allowedLocationIds.add(stylist.sourceLocationId);
            }
          }
        }
        if (clientFilter) {
          const clients = db.select().from(schema.clients).where(eq(schema.clients.teamId, teamId)).all() as schema.Client[];
          for (const client of clients) {
            if (client.id === clientFilter && client.sourceLocationId) allowedLocationIds.add(client.sourceLocationId);
          }
        }
        const appointments = db.select().from(schema.appointments).where(eq(schema.appointments.teamId, teamId)).all() as schema.Appointment[];
        for (const appointment of appointments) {
          const stylistMatch = stylistFilter && (appointment.stylistId === stylistFilter || appointment.staffId === stylistFilter);
          const clientMatch = clientFilter && appointment.clientId === clientFilter;
          if ((stylistMatch || clientMatch) && appointment.locationId) allowedLocationIds.add(appointment.locationId);
        }
        rows = rows.filter((row: schema.Location) => allowedLocationIds.has(row.id));
      }
      if (req.query.search) {
        const term = String(req.query.search).toLowerCase();
        rows = rows.filter((row: schema.Location) =>
          [row.name, row.suburb, row.state, row.postcode, row.emailAddress, row.businessPhone, row.mobilePhone]
            .some((value) => String(value || '').toLowerCase().includes(term))
        );
      }
      rows.sort((a: schema.Location, b: schema.Location) => String(a.name || '').localeCompare(String(b.name || '')));
      const total = rows.length;
      return { status: 200, data: { data: rows.slice(offset, offset + limit).map(mapLocationRecord), total, limit, offset } };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read locations');
    }
  }

  const locationMatch = req.path.match(/^\/locations\/([^/]+)$/);
  if (locationMatch && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const rows = db.select().from(schema.locations).where(and(eq(schema.locations.teamId, teamId), eq(schema.locations.id, locationMatch[1]!))).all();
      if (!rows.length) return apiError(404, 'NOT_FOUND', 'Location not found');
      return { status: 200, data: mapLocationDetailRecord(rows[0], buildRelationshipSummary(db, teamId, { locationId: rows[0].id })) };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read location');
    }
  }

  if (req.path === '/locations/sync' && req.method === 'POST') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');

    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    try {
      const { db } = initializeDatabase(teamId);
      db.insert(schema.syncRuns).values({ id: runId, teamId, resource: 'locations', status: 'running', startedAt }).run();
      const raw = await fetchLocations(config);
      const now = new Date().toISOString();
      let upserts = 0;
      for (const item of raw) {
        if (!item?.id) continue;
        const values: schema.NewLocation = {
          id: String(item.id),
          teamId,
          name: cleanString(item.name),
          emailAddress: cleanString(item.emailAddress),
          businessPhone: cleanString(item.businessPhone),
          mobilePhone: cleanString(item.mobilePhone),
          canBookOnline: typeof item.canBookOnline === 'boolean' ? item.canBookOnline : null,
          active: typeof item.active === 'boolean' ? item.active : null,
          street: cleanString(item.street),
          suburb: cleanString(item.suburb),
          state: cleanString(item.state),
          postcode: cleanString(item.postcode),
          country: cleanString(item.country),
          raw: JSON.stringify(item),
          syncedAt: now,
        };
        const existing = db.select().from(schema.locations).where(eq(schema.locations.id, values.id)).all();
        if (existing.length) {
          db.update(schema.locations).set({ ...values }).where(eq(schema.locations.id, values.id)).run();
        } else {
          db.insert(schema.locations).values(values).run();
        }
        upserts++;
      }
      upsertSyncState(db, teamId, 'locations', { lastSyncedAt: now, lastSuccessAt: now, lastError: null, rowCount: upserts });
      db.update(schema.syncRuns).set({ status: 'success', completedAt: now, rowsSeen: raw.length, rowsWritten: upserts, pageCount: 1 }).where(eq(schema.syncRuns.id, runId)).run();
      return { status: 200, data: { ok: true, synced: upserts, startedAt, completedAt: now } };
    } catch (error: any) {
      const errMsg = error?.message || String(error);
      const now = new Date().toISOString();
      try {
        const { db } = initializeDatabase(teamId);
        db.update(schema.syncRuns).set({ status: 'error', completedAt: now, error: errMsg }).where(eq(schema.syncRuns.id, runId)).run();
        upsertSyncState(db, teamId, 'locations', { lastSyncedAt: now, lastError: errMsg });
      } catch {}
      return apiError(502, 'YOT_ERROR', errMsg);
    }
  }

  if (req.path === '/clients' && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const { limit, offset } = parsePagination(req.query);
      const activeFilter = parseBooleanFilter(req.query.active);
      const locationFilter = cleanString(req.query.locationId || req.query.location);
      const clientFilter = cleanString(req.query.clientId || req.query.client);
      const stylistFilter = cleanString(req.query.stylistId || req.query.stylist || req.query.staffId);
      const search = cleanString(req.query.search || req.query.q);
      const { field, direction } = parseSort(req.query);

      let rows = db.select().from(schema.clients).where(eq(schema.clients.teamId, teamId)).all() as schema.Client[];
      if (activeFilter !== null) rows = rows.filter((row) => row.active === activeFilter);
      if (locationFilter) {
        // Match clients with at least one appointment at this location, mirroring
        // the popup's `relationships.uniqueClientCount`. The previous `sourceLocationId`
        // filter under-counted because YOT's home-location field is sparsely populated.
        const appointments = db.select().from(schema.appointments).where(eq(schema.appointments.teamId, teamId)).all() as schema.Appointment[];
        const allowedClientIds = new Set(appointments.filter((row) => row.clientId && row.locationId === locationFilter).map((row) => row.clientId as string));
        rows = rows.filter((row) => allowedClientIds.has(row.id));
      }
      if (clientFilter) rows = rows.filter((row) => row.id === clientFilter || row.privateId === clientFilter);
      if (stylistFilter) {
        const appointments = db.select().from(schema.appointments).where(eq(schema.appointments.teamId, teamId)).all() as schema.Appointment[];
        const allowedClientIds = new Set(appointments.filter((row) => row.clientId && (row.stylistId === stylistFilter || row.staffId === stylistFilter)).map((row) => row.clientId as string));
        rows = rows.filter((row) => allowedClientIds.has(row.id));
      }

      // Recency window filter: `lastVisitNever=1` keeps only clients with no recorded visit.
      // `lastVisitBefore` / `lastVisitAfter` keep clients with a non-null last visit on the
      // matching side of the cutoff (unlike the previous behavior which conflated null with
      // "before"). This lets the UI wire "never" and "within N days" as independent options.
      const lastVisitNever = String(req.query.lastVisitNever || '').toLowerCase();
      if (lastVisitNever === '1' || lastVisitNever === 'true' || lastVisitNever === 'yes') {
        rows = rows.filter((row) => !row.lastVisitAt);
      } else {
        const before = cleanString(req.query.lastVisitBefore);
        const after = cleanString(req.query.lastVisitAfter);
        if (before) rows = rows.filter((row) => !!row.lastVisitAt && row.lastVisitAt <= before);
        if (after) rows = rows.filter((row) => !!row.lastVisitAt && row.lastVisitAt >= after);
      }

      if (search) {
        const term = search.toLowerCase();
        rows = rows.filter((row) =>
          [row.fullName, row.firstName, row.lastName, row.email, row.emailAddress, row.mobilePhone, row.homePhone, row.businessPhone, row.phone]
            .some((value) => String(value || '').toLowerCase().includes(term))
        );
      }

      rows.sort((a, b) => {
        const dir = direction === 'asc' ? 1 : -1;
        const aRaw = (a as any)[field];
        const bRaw = (b as any)[field];
        if (NUMERIC_SORT_FIELDS.has(field)) {
          const aNum = typeof aRaw === 'number' ? aRaw : Number.NEGATIVE_INFINITY;
          const bNum = typeof bRaw === 'number' ? bRaw : Number.NEGATIVE_INFINITY;
          if (aNum === bNum) return 0;
          return (aNum < bNum ? -1 : 1) * dir;
        }
        // String/date compare: treat null/empty as empty string so they sort together at one end.
        const aValue = aRaw == null ? '' : String(aRaw);
        const bValue = bRaw == null ? '' : String(bRaw);
        return aValue.localeCompare(bValue) * dir;
      });

      const total = rows.length;
      return { status: 200, data: { data: rows.slice(offset, offset + limit).map(mapClientRecord), total, limit, offset } };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read clients');
    }
  }

  if (req.path === '/clients/first-seen' && req.method === 'GET') {
    try {
      const { sqlite } = initializeDatabase(teamId);
      const rows = sqlite
        .prepare(`SELECT client_id AS clientId, MIN(starts_at) AS firstAppointmentAt
                  FROM appointments
                  WHERE team_id = ? AND client_id IS NOT NULL
                  GROUP BY client_id`)
        .all(teamId) as Array<{ clientId: string; firstAppointmentAt: string | null }>;
      return { status: 200, data: { rows, total: rows.length } };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to compute first-seen map');
    }
  }

  if (req.path === '/clients/paging-characterization' && req.method === 'GET') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');
    try {
      const locationIdRaw = cleanString(req.query.locationId);
      const result = await characterizeClientPaging(config, {
        locationId: locationIdRaw ? Number(locationIdRaw) : undefined,
        maxPages: parseInt(String(req.query.maxPages || '25'), 10) || 25,
      });
      return { status: 200, data: result };
    } catch (error: any) {
      return apiError(502, 'YOT_ERROR', error?.message || String(error));
    }
  }

  const clientMatch = req.path.match(/^\/clients\/([^/]+)$/);
  if (clientMatch && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const rows = db.select().from(schema.clients).where(and(eq(schema.clients.teamId, teamId), eq(schema.clients.id, clientMatch[1]!))).all();
      if (!rows.length) return apiError(404, 'NOT_FOUND', 'Client not found');
      return { status: 200, data: mapClientDetailRecord(rows[0], buildRelationshipSummary(db, teamId, { clientId: rows[0].id })) };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read client');
    }
  }

  const stylistMatch = req.path.match(/^\/stylists\/([^/]+)$/);
  if (stylistMatch && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const rows = db.select().from(schema.stylists).where(and(eq(schema.stylists.teamId, teamId), eq(schema.stylists.id, stylistMatch[1]!))).all();
      if (!rows.length) return apiError(404, 'NOT_FOUND', 'Stylist not found');
      return { status: 200, data: mapStylistDetailRecord(rows[0], buildRelationshipSummary(db, teamId, { stylistId: rows[0].privateId })) };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read stylist');
    }
  }

  if (req.path === '/stylists' && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const { limit, offset } = parsePagination(req.query);
      const activeFilter = parseBooleanFilter(req.query.active);
      const locationFilter = cleanString(req.query.locationId || req.query.location);
      const stylistFilter = cleanString(req.query.stylistId || req.query.stylist || req.query.staffId);
      const clientFilter = cleanString(req.query.clientId || req.query.client);
      const search = cleanString(req.query.search || req.query.q);

      let rows = db.select().from(schema.stylists).where(eq(schema.stylists.teamId, teamId)).all() as schema.Stylist[];
      if (activeFilter !== null) rows = rows.filter((row) => row.active === activeFilter);
      if (locationFilter) rows = rows.filter((row) => row.locationId === locationFilter || row.sourceLocationId === locationFilter);
      if (stylistFilter) rows = rows.filter((row) => row.id === stylistFilter || row.privateId === stylistFilter);
      if (clientFilter) {
        const appointments = db.select().from(schema.appointments).where(eq(schema.appointments.teamId, teamId)).all() as schema.Appointment[];
        const allowedStylistIds = new Set<string>();
        for (const appointment of appointments) {
          if (appointment.clientId !== clientFilter) continue;
          if (appointment.stylistId) allowedStylistIds.add(appointment.stylistId);
          if (appointment.staffId) allowedStylistIds.add(appointment.staffId);
        }
        rows = rows.filter((row) => allowedStylistIds.has(row.privateId || '') || allowedStylistIds.has(row.id));
      }
      if (search) {
        const term = search.toLowerCase();
        rows = rows.filter((row) =>
          [row.fullName, row.givenName, row.surname, row.emailAddress, row.mobilePhone, row.privateId]
            .some((value) => String(value || '').toLowerCase().includes(term))
        );
      }

      rows.sort((a, b) => String(a.fullName || a.givenName || '').localeCompare(String(b.fullName || b.givenName || '')));
      const total = rows.length;
      return { status: 200, data: { data: rows.slice(offset, offset + limit).map(mapStylistRecord), total, limit, offset } };
    } catch (error: any) {
      if (String(error?.message || '').toLowerCase().includes('no such table')) {
        return { status: 200, data: { data: [], total: 0, limit: parsePagination(req.query).limit, offset: parsePagination(req.query).offset } };
      }
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read stylists');
    }
  }

  if (req.path === '/clients/sync' && req.method === 'POST') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');

    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    try {
      const MAX_PAGES = Math.min(parseInt(String(req.query.maxPages || '200'), 10) || 200, 2000);
      const locationIdRaw = cleanString(req.query.locationId);
      const locationId = locationIdRaw ? Number(locationIdRaw) : undefined;
      const { db } = initializeDatabase(teamId);
      db.insert(schema.syncRuns).values({ id: runId, teamId, resource: 'clients', status: 'running', startedAt, notes: locationIdRaw ? `locationId=${locationIdRaw}` : null }).run();

      const raw: Record<string, any>[] = [];
      let pageCount = 0;
      let stoppedBecause = 'maxPages';
      for (let page = 1; page <= MAX_PAGES; page++) {
        const chunk = await fetchClients(config, { page, locationId });
        pageCount = page;
        if (!chunk.length) {
          stoppedBecause = 'empty-page';
          break;
        }
        raw.push(...chunk);
      }

      const now = new Date().toISOString();
      let upserts = 0;
      for (const item of raw) {
        if (!item?.id && !item?.privateId) continue;
        const values: schema.NewClient = {
          id: String(item.id ?? item.privateId),
          teamId,
          firstName: cleanString(item.givenName ?? item.firstName),
          lastName: cleanString(item.surname ?? item.lastName),
          email: cleanString(item.emailAddress ?? item.email),
          phone: cleanString(item.mobilePhone ?? item.homePhone ?? item.businessPhone ?? item.phone),
          address: null,
          tags: null,
          lastVisitAt: cleanString(item.lastVisitAt),
          totalVisits: typeof item.totalVisits === 'number' ? item.totalVisits : null,
          totalSpend: typeof item.totalSpend === 'number' ? item.totalSpend : null,
          raw: JSON.stringify(item),
          syncedAt: now,
          privateId: cleanString(item.privateId),
          otherName: cleanString(item.otherName),
          fullName: normalizeFullName(item),
          homePhone: cleanString(item.homePhone),
          mobilePhone: cleanString(item.mobilePhone),
          businessPhone: cleanString(item.businessPhone),
          emailAddress: cleanString(item.emailAddress),
          birthday: cleanString(item.birthday),
          gender: cleanString(item.gender),
          active: typeof item.active === 'boolean' ? item.active : null,
          street: cleanString(item.street),
          suburb: cleanString(item.suburb),
          state: cleanString(item.state),
          postcode: cleanString(item.postcode),
          country: cleanString(item.country),
          sourceLocationId: locationIdRaw,
          createdAtRemote: cleanString(item.createdDate ?? item.createdAt),
        };
        const existing = db.select().from(schema.clients).where(eq(schema.clients.id, values.id)).all();
        if (existing.length) {
          db.update(schema.clients).set({ ...values }).where(eq(schema.clients.id, values.id)).run();
        } else {
          db.insert(schema.clients).values(values).run();
        }
        upserts++;
      }

      upsertSyncState(db, teamId, 'clients', { lastSyncedAt: now, lastSuccessAt: now, lastError: null, rowCount: upserts });
      db.update(schema.syncRuns).set({ status: 'success', completedAt: now, rowsSeen: raw.length, rowsWritten: upserts, pageCount, notes: `${locationIdRaw ? `locationId=${locationIdRaw}; ` : ''}stop=${stoppedBecause}` }).where(eq(schema.syncRuns.id, runId)).run();
      return { status: 200, data: { ok: true, synced: upserts, rowsSeen: raw.length, pageCount, stoppedBecause, startedAt, completedAt: now } };
    } catch (error: any) {
      const errMsg = error?.message || String(error);
      const now = new Date().toISOString();
      try {
        const { db } = initializeDatabase(teamId);
        db.update(schema.syncRuns).set({ status: 'error', completedAt: now, error: errMsg }).where(eq(schema.syncRuns.id, runId)).run();
        upsertSyncState(db, teamId, 'clients', { lastSyncedAt: now, lastError: errMsg });
      } catch {}
      return apiError(502, 'YOT_ERROR', errMsg);
    }
  }

  if (req.path === '/stylists/sync' && req.method === 'POST') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');

    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    try {
      const { db } = initializeDatabase(teamId);
      db.insert(schema.syncRuns).values({ id: runId, teamId, resource: 'stylists', status: 'running', startedAt }).run();
      const locations = await fetchLocations(config);
      const activeLocations = locations.filter((item) => item?.id != null && item?.active !== false);
      const now = new Date().toISOString();
      let rowsSeen = 0;
      let rowsWritten = 0;
      for (const location of activeLocations) {
        const locationId = String(location.id);
        const raw = await fetchLocationStaff(config, Number(location.id), { services: true });
        rowsSeen += raw.length;
        for (const item of raw) {
          if (item?.id == null) continue;
          const stylistId = String(item.id);
          let profile: Record<string, any> | null = null;
          try {
            profile = await fetchStaffProfile(config, Number(item.id));
          } catch {}
          const profileDetails = collectStylistProfileDetails(profile);
          const values: schema.NewStylist = {
            id: `${locationId}:${stylistId}`,
            teamId,
            locationId,
            privateId: stylistId,
            givenName: cleanString(profile?.givenName ?? profile?.firstName ?? item.givenName ?? item.firstName),
            surname: cleanString(profile?.surname ?? profile?.lastName ?? item.surname ?? item.lastName),
            fullName: normalizeFullName(profile ?? item),
            initial: cleanString(item.initial ?? profile?.initial),
            jobTitle: cleanString(profile?.jobTitle ?? item.jobTitle),
            jobDescription: cleanString(profile?.jobDescription ?? item.jobDescription),
            emailAddress: cleanString(profile?.emailAddress ?? item.emailAddress),
            mobilePhone: cleanString(profile?.mobilePhone ?? item.mobilePhone),
            active: typeof item.active === 'boolean' ? item.active : null,
            sourceLocationId: locationId,
            serviceCategoryNames: JSON.stringify(profileDetails.categoryNames),
            serviceIds: JSON.stringify(profileDetails.serviceIds),
            serviceNames: JSON.stringify(profileDetails.serviceNames),
            profileRaw: profile ? JSON.stringify(profile) : null,
            raw: JSON.stringify(item),
            syncedAt: now,
          };
          const existing = db.select().from(schema.stylists).where(eq(schema.stylists.id, values.id)).all();
          if (existing.length) {
            db.update(schema.stylists).set({ ...values }).where(eq(schema.stylists.id, values.id)).run();
          } else {
            db.insert(schema.stylists).values(values).run();
          }
          rowsWritten++;
        }
      }
      upsertSyncState(db, teamId, 'stylists', { lastSyncedAt: now, lastSuccessAt: now, lastError: null, rowCount: rowsWritten });
      db.update(schema.syncRuns).set({ status: 'success', completedAt: now, rowsSeen, rowsWritten, pageCount: activeLocations.length, notes: `locations=${activeLocations.length}` }).where(eq(schema.syncRuns.id, runId)).run();
      return { status: 200, data: { ok: true, synced: rowsWritten, rowsSeen, locationCount: activeLocations.length, startedAt, completedAt: now } };
    } catch (error: any) {
      const errMsg = error?.message || String(error);
      const now = new Date().toISOString();
      try {
        const { db } = initializeDatabase(teamId);
        db.update(schema.syncRuns).set({ status: 'error', completedAt: now, error: errMsg }).where(eq(schema.syncRuns.id, runId)).run();
        upsertSyncState(db, teamId, 'stylists', { lastSyncedAt: now, lastError: errMsg });
      } catch {}
      return apiError(502, 'YOT_ERROR', errMsg);
    }
  }

  if (req.path === '/appointments' && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const { limit, offset } = parsePagination(req.query);
      const search = cleanString(req.query.search || req.query.q);
      const filters = {
        locationId: cleanString(req.query.locationId || req.query.location),
        stylistId: cleanString(req.query.stylistId || req.query.stylist || req.query.staffId),
        clientId: cleanString(req.query.clientId || req.query.client),
        appointmentId: cleanString(req.query.appointmentId || req.query.appointment),
        statusCode: cleanString(req.query.statusCode || req.query.status),
        categoryId: cleanString(req.query.categoryId || req.query.category),
        startsAfter: cleanString(req.query.startsAfter || req.query.startAtGte || req.query.dateFrom),
        startsBefore: cleanString(req.query.startsBefore || req.query.startAtLte || req.query.dateTo),
        search,
      };

      // Search filter spans joined fields (clientName, stylistName, etc.) and
      // can't be cheaply pushed into SQL. Pass a post-filter callback that
      // runs after the WHERE clause has narrowed the working set.
      const searchPostFilter = search
        ? (rows: schema.Appointment[]): schema.Appointment[] => {
            const term = search.toLowerCase();
            const lookups = buildAppointmentLookupsForRows(db, teamId, rows);
            return rows.filter((row) => {
              const mapped = mapAppointmentRecordWithLookups(row, lookups);
              return [
                row.appointmentId,
                row.internalId,
                row.clientId,
                mapped.clientName,
                mapped.clientPhone,
                mapped.locationName,
                mapped.stylistName,
                mapped.serviceName,
                row.serviceNameRaw,
                row.categoryName,
                row.status,
                row.statusCode,
                row.statusDescription,
                row.descriptionText,
                row.clientNotes,
              ].some((value) => String(value || '').toLowerCase().includes(term));
            });
          }
        : undefined;

      const { rows, total } = listAppointmentsForRequest(db, teamId, filters, { limit, offset }, searchPostFilter);
      const lookups = buildAppointmentLookupsForRows(db, teamId, rows);
      return {
        status: 200,
        data: {
          data: rows.map((row) => mapAppointmentRecordWithLookups(row, lookups)),
          total,
          limit,
          offset,
        },
      };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read appointments');
    }
  }

  if (req.path === '/stylists-by-location' && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const startsAfter  = cleanString(req.query.startsAfter  || req.query.startAtGte || req.query.dateFrom);
      const startsBefore = cleanString(req.query.startsBefore || req.query.startAtLte || req.query.dateTo);
      return {
        status: 200,
        data: { data: stylistsByLocationForRange(db, teamId, { startsAfter, startsBefore }) },
      };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read stylists by location');
    }
  }

  const appointmentMatch = req.path.match(/^\/appointments\/([^/]+)$/);
  if (appointmentMatch && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const requestedId = appointmentMatch[1]!;
      let rows = db.select().from(schema.appointments).where(and(eq(schema.appointments.teamId, teamId), eq(schema.appointments.id, requestedId))).all() as schema.Appointment[];
      if (!rows.length) {
        rows = db.select().from(schema.appointments).where(and(eq(schema.appointments.teamId, teamId), eq(schema.appointments.appointmentId, requestedId))).all() as schema.Appointment[];
      }
      if (!rows.length) return apiError(404, 'NOT_FOUND', 'Appointment not found');
      rows.sort((a, b) => String(b.startAt || b.startsAt || '').localeCompare(String(a.startAt || a.startsAt || '')));
      const lookups = buildAppointmentLookupsForRows(db, teamId, rows.slice(0, 1));
      return { status: 200, data: mapAppointmentDetailRecord(rows[0], lookups) };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read appointment');
    }
  }

  if (req.path === '/appointments/sync' && req.method === 'POST') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');

    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    const explicitLookback = req.query.lookbackDays != null;
    const lookbackDays = explicitLookback
      ? Math.max(1, Math.min(parseInt(req.query.lookbackDays || '30', 10) || 30, 365))
      : autoResumeRange(teamId, 'appointments').lookbackDays;
    // Forward window — pulls upcoming bookings (default 0 = past-only,
    // backwards-compatible). Use ?forwardDays=N to also fetch appointments
    // scheduled up to N days from now (e.g. dashboards that need to surface
    // tomorrow's schedule).
    const explicitForward = req.query.forwardDays != null;
    const forwardDays = explicitForward
      ? Math.max(0, Math.min(parseInt(req.query.forwardDays || '0', 10) || 0, 365))
      : 0;
    try {
      const { db } = initializeDatabase(teamId);
      db.insert(schema.syncRuns).values({ id: runId, teamId, resource: 'appointments', status: 'running', startedAt, notes: `lookbackDays=${lookbackDays}${explicitLookback ? '' : ' (auto-resume)'}; forwardDays=${forwardDays}` }).run();
      const locations = await fetchLocations(config);
      const activeLocations = locations.filter((item) => item?.id != null && item?.active !== false);
      const now = new Date().toISOString();
      const nowMs = Date.now();
      const enddate = nowMs + forwardDays * 24 * 60 * 60 * 1000;
      const date = nowMs - lookbackDays * 24 * 60 * 60 * 1000;
      let rowsSeen = 0;
      let rowsWritten = 0;
      let locationsSynced = 0;
      for (const location of activeLocations) {
        const locationId = String(location.id);
        const staff = await fetchLocationStaff(config, Number(location.id), { services: true });
        const actor = staff.find((item) => item?.id != null);
        if (!actor?.id) continue;
        const serviceRows = db.select().from(schema.services).where(and(eq(schema.services.teamId, teamId), eq(schema.services.locationId, locationId))).all() as schema.Service[];
        const serviceNameToId = new Map<string, string>();
        for (const row of serviceRows) {
          const norm = normalizeNameForLookup(row.name);
          if (norm && row.privateId) serviceNameToId.set(norm, row.privateId);
        }
        const payload = await fetchAppointmentsRange(config, { locationId: Number(location.id), staffId: Number(actor.id), date, enddate });
        const appointments = extractAppointmentsRangeRows(payload);
        const statuses = Array.isArray(payload?.statuses) ? payload.statuses : [];
        const categories = Array.isArray(payload?.categories) ? payload.categories : [];
        const statusById = new Map<string, Record<string, any>>();
        const categoryById = new Map<string, Record<string, any>>();
        for (const item of statuses) if (item?.id != null) statusById.set(String(item.id), item);
        for (const item of categories) if (item?.id != null) categoryById.set(String(item.id), item);
        rowsSeen += appointments.length;
        for (const item of appointments) {
          if (item?.appointmentId == null) continue;
          const appointmentId = String(item.appointmentId);
          const serviceNameRaw = cleanString(item.service);
          const serviceNameNorm = normalizeNameForLookup(item.service);
          const statusId = cleanString(item.status);
          const categoryId = cleanString(item.category);
          const statusMeta = statusId ? statusById.get(statusId) : null;
          const categoryMeta = categoryId ? categoryById.get(categoryId) : null;
          const values: schema.NewAppointment = {
            id: `${locationId}:${appointmentId}`,
            teamId,
            appointmentId,
            internalId: cleanString(item.id),
            clientId: cleanString(item.clientId),
            clientName: cleanString(item.clientName),
            clientPhone: cleanString(item.clientPhone),
            clientNotes: cleanString(item.clientNotes),
            staffId: cleanString(item.resourceId),
            stylistId: cleanString(item.resourceId),
            serviceId: serviceNameNorm ? serviceNameToId.get(serviceNameNorm) ?? null : null,
            serviceNameRaw,
            serviceNameNorm,
            locationId,
            startsAt: localIsoFromParts(item, 'startHour', 'startMinute'),
            endsAt: localIsoFromParts(item, 'endHour', 'endMinute'),
            startAt: localIsoFromParts(item, 'startHour', 'startMinute'),
            endAt: localIsoFromParts(item, 'endHour', 'endMinute'),
            status: cleanString(statusMeta?.description ?? item.status),
            statusCode: cleanString(statusMeta?.code ?? item.status),
            statusDescription: cleanString(statusMeta?.description),
            categoryId,
            categoryName: cleanString(categoryMeta?.description),
            durationMinutes: computeDurationMinutes(item),
            descriptionHtml: cleanString(item.description),
            descriptionText: stripHtml(item.description),
            referrer: cleanString(item.referrer),
            promotionCode: cleanString(item.promotionCode),
            arrivalNote: cleanString(item.arrivalNote),
            reminderSent: typeof item.reminderSent === 'boolean' ? item.reminderSent : null,
            cancelledFlag: typeof item.cancelled === 'boolean' ? item.cancelled : null,
            onlineBooking: typeof item.onlineBooking === 'boolean' ? item.onlineBooking : null,
            newClient: typeof item.newClient === 'boolean' ? item.newClient : null,
            isClass: typeof item.isClass === 'boolean' ? item.isClass : null,
            processingLength: typeof item.processingLength === 'number' ? item.processingLength : null,
            total: null,
            grossAmount: null,
            discountAmount: null,
            netAmount: null,
            createdAtRemote: cleanString(item.createdAt),
            createdBy: cleanString(item.createdBy),
            updatedAtRemote: cleanString(item.updatedAt),
            updatedBy: cleanString(item.updatedBy),
            raw: JSON.stringify(item),
            syncedAt: now,
          };
          const existing = db.select().from(schema.appointments).where(eq(schema.appointments.id, values.id)).all();
          if (existing.length) {
            db.update(schema.appointments).set({ ...values }).where(eq(schema.appointments.id, values.id)).run();
          } else {
            db.insert(schema.appointments).values(values).run();
          }
          rowsWritten++;
        }
        locationsSynced++;
      }
      upsertSyncState(db, teamId, 'appointments', { lastSyncedAt: now, lastSuccessAt: now, lastError: null, rowCount: rowsWritten });
      db.update(schema.syncRuns).set({ status: 'success', completedAt: now, rowsSeen, rowsWritten, pageCount: locationsSynced, notes: `lookbackDays=${lookbackDays}; locations=${locationsSynced}` }).where(eq(schema.syncRuns.id, runId)).run();
      return { status: 200, data: { ok: true, synced: rowsWritten, rowsSeen, locationCount: locationsSynced, lookbackDays, startedAt, completedAt: now } };
    } catch (error: any) {
      const errMsg = error?.message || String(error);
      const now = new Date().toISOString();
      try {
        const { db } = initializeDatabase(teamId);
        db.update(schema.syncRuns).set({ status: 'error', completedAt: now, error: errMsg }).where(eq(schema.syncRuns.id, runId)).run();
        upsertSyncState(db, teamId, 'appointments', { lastSyncedAt: now, lastError: errMsg });
      } catch {}
      return apiError(502, 'YOT_ERROR', errMsg);
    }
  }

  const serviceMatch = req.path.match(/^\/services\/([^/]+)$/);
  if (serviceMatch && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const rows = db.select().from(schema.services).where(and(eq(schema.services.teamId, teamId), eq(schema.services.id, serviceMatch[1]!))).all();
      if (!rows.length) return apiError(404, 'NOT_FOUND', 'Service not found');
      return { status: 200, data: mapServiceDetailRecord(rows[0]) };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read service');
    }
  }

  if (req.path === '/services' && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const { limit, offset } = parsePagination(req.query);
      const locationFilter = cleanString(req.query.locationId || req.query.location);
      const activeFilter = parseBooleanFilter(req.query.active);
      const search = cleanString(req.query.search || req.query.q);
      let rows = db.select().from(schema.services).where(eq(schema.services.teamId, teamId)).all() as schema.Service[];
      if (locationFilter) rows = rows.filter((row) => row.locationId === locationFilter);
      if (activeFilter !== null) rows = rows.filter((row) => row.active === activeFilter);
      if (search) {
        const term = search.toLowerCase();
        rows = rows.filter((row) => [row.name, row.id].some((value) => String(value || '').toLowerCase().includes(term)));
      }
      rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      const total = rows.length;
      return { status: 200, data: { data: rows.slice(offset, offset + limit).map(mapServiceRecord), total, limit, offset } };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read services');
    }
  }

  if (req.path === '/services/sync' && req.method === 'POST') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');

    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    try {
      const { db } = initializeDatabase(teamId);
      db.insert(schema.syncRuns).values({ id: runId, teamId, resource: 'services', status: 'running', startedAt }).run();
      const locations = await fetchLocations(config);
      const activeLocations = locations.filter((item) => item?.id != null && item?.active !== false);
      const now = new Date().toISOString();
      let rowsSeen = 0;
      let rowsWritten = 0;
      for (const location of activeLocations) {
        const locationId = String(location.id);
        const categories = await fetchLocationServices(config, Number(location.id));
        for (const category of categories) {
          const services = Array.isArray(category?.services) ? category.services : [];
          rowsSeen += services.length;
          for (const item of services) {
            if (item?.serviceId == null) continue;
            const serviceId = String(item.serviceId);
            const staffPrices = Array.isArray(item?.staffPrices) ? item.staffPrices : [];
            const nonEmptyStaffPrices = staffPrices.filter((row: any) => cleanString(row?.price) != null);
            const values: schema.NewService = {
              id: `${locationId}:${serviceId}`,
              teamId,
              locationId,
              privateId: serviceId,
              name: cleanString(item.serviceName ?? item.name),
              categoryId: cleanString(item.categoryId ?? category?.categoryId),
              categoryName: cleanString(item.categoryName ?? category?.category),
              durationMinutes: parseDurationMinutes(item.length),
              lengthDisplay: cleanString(item.length),
              price: typeof item.priceValue === 'number' ? item.priceValue : null,
              priceDisplay: cleanString(item.price),
              description: cleanString(item.description),
              active: typeof item.active === 'boolean' ? item.active : null,
              staffPriceCount: staffPrices.length || 0,
              staffPriceOverrides: JSON.stringify(nonEmptyStaffPrices),
              raw: JSON.stringify({ ...item, locationId, category: cleanString(category?.category) }),
              syncedAt: now,
            };
            const existing = db.select().from(schema.services).where(eq(schema.services.id, values.id)).all();
            if (existing.length) {
              db.update(schema.services).set({ ...values }).where(eq(schema.services.id, values.id)).run();
            } else {
              db.insert(schema.services).values(values).run();
            }
            rowsWritten++;
          }
        }
      }
      upsertSyncState(db, teamId, 'services', { lastSyncedAt: now, lastSuccessAt: now, lastError: null, rowCount: rowsWritten });
      db.update(schema.syncRuns).set({ status: 'success', completedAt: now, rowsSeen, rowsWritten, pageCount: activeLocations.length, notes: `locations=${activeLocations.length}` }).where(eq(schema.syncRuns.id, runId)).run();
      return { status: 200, data: { ok: true, synced: rowsWritten, rowsSeen, locationCount: activeLocations.length, startedAt, completedAt: now } };
    } catch (error: any) {
      const errMsg = error?.message || String(error);
      const now = new Date().toISOString();
      try {
        const { db } = initializeDatabase(teamId);
        db.update(schema.syncRuns).set({ status: 'error', completedAt: now, error: errMsg }).where(eq(schema.syncRuns.id, runId)).run();
        upsertSyncState(db, teamId, 'services', { lastSyncedAt: now, lastError: errMsg });
      } catch {}
      return apiError(502, 'YOT_ERROR', errMsg);
    }
  }

  if (req.path === '/export' && req.method === 'POST') {
    try {
      const { db } = initializeDatabase(teamId);
      const manifest = writeExportFiles(teamId, db);
      return { status: 200, data: { ok: true, manifest } };
    } catch (error: any) {
      return apiError(500, 'EXPORT_ERROR', error?.message || 'Failed to export local cache');
    }
  }

  if (req.path === '/sync-state' && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const rows = db.select().from(schema.syncState).where(eq(schema.syncState.teamId, teamId)).all();
      return { status: 200, data: { state: rows } };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read sync state');
    }
  }

  if (req.path === '/sync-runs' && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const { limit, offset } = parsePagination(req.query);
      const resourceFilter = cleanString(req.query.resource);
      let rows = db.select().from(schema.syncRuns).where(eq(schema.syncRuns.teamId, teamId)).all() as schema.SyncRun[];
      if (resourceFilter) rows = rows.filter((row) => row.resource === resourceFilter);
      rows.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
      const total = rows.length;
      return { status: 200, data: { data: rows.slice(offset, offset + limit).map(mapSyncRun), total, limit, offset } };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read sync runs');
    }
  }

  // ============================================================
  // Coverage endpoints (staff coverage + light windows + find cover)
  // ============================================================

  if (req.path === '/coverage/sync' && req.method === 'POST') {
    const { db: covDb, sqlite: covSqlite } = initializeDatabase(teamId);
    try {
      const body = (req.body || {}) as {
        locationId?: string;
        date?: string;
        ratios?: { weekday?: number; saturday?: number; sunday?: number };
        averagingDays?: number;
        slotMinutes?: number;
      };
      if (!body.locationId || !body.date) return apiError(400, 'BAD_REQUEST', 'locationId and date required');
      const { syncCoverageForLocationDay } = await import('../coverage/sync');
      const ratios = body.ratios
        ? {
            weekday: Number(body.ratios.weekday) || 10,
            saturday: Number(body.ratios.saturday) || 8,
            sunday: Number(body.ratios.sunday) || 6,
          }
        : undefined;
      const slotMinutes = Number.isFinite(Number(body.slotMinutes)) && Number(body.slotMinutes) > 0
        ? Math.round(Number(body.slotMinutes))
        : undefined;
      const result = await syncCoverageForLocationDay({
        teamId,
        locationId: body.locationId,
        date: body.date,
        ratios,
        averagingDays: body.averagingDays,
        slotMinutes,
      });
      const now = new Date().toISOString();
      // Row count = current cached rows for this team (multiple location-days
      // accumulate; the per-call result rebuilds one week of one location).
      let rowCount: number | null = null;
      try {
        const r = covSqlite.prepare('SELECT COUNT(*) AS c FROM location_coverage_facts WHERE team_id = ?').get(teamId) as { c: number };
        rowCount = r?.c ?? null;
      } catch { /* tolerate missing table */ }
      upsertSyncState(covDb, teamId, 'location_coverage_facts', {
        lastSyncedAt: now, lastSuccessAt: now, lastError: null, rowCount,
      });
      return { status: 200, data: result };
    } catch (err: any) {
      const msg = err?.message || 'Coverage sync failed';
      const now = new Date().toISOString();
      upsertSyncState(covDb, teamId, 'location_coverage_facts', { lastSyncedAt: now, lastError: msg });
      if (err?.name === 'MvcAuthMissingError') return apiError(412, 'MVC_AUTH_MISSING', msg);
      if (err?.name === 'MvcAuthExpiredError') return apiError(401, 'MVC_AUTH_EXPIRED', msg);
      return apiError(500, 'COVERAGE_SYNC_FAILED', msg);
    }
  }

  if (req.path === '/coverage/slots' && req.method === 'GET') {
    const locationId = cleanString(req.query.locationId);
    const date = cleanString(req.query.date);
    if (!locationId || !date) return apiError(400, 'BAD_REQUEST', 'locationId and date required');
    const { readCachedCoverage } = await import('../coverage/sync');
    const cached = readCachedCoverage(teamId, locationId, date);
    if (!cached) return apiError(404, 'NO_COVERAGE_CACHE', 'Run /coverage/sync first');
    return { status: 200, data: cached };
  }

  if (req.path === '/coverage/light-windows' && req.method === 'GET') {
    const locationId = cleanString(req.query.locationId);
    const date = cleanString(req.query.date);
    if (!locationId || !date) return apiError(400, 'BAD_REQUEST', 'locationId and date required');
    const { readCachedCoverage, aggregateLightWindows } = await import('../coverage/sync');
    const cached = readCachedCoverage(teamId, locationId, date);
    if (!cached) return apiError(404, 'NO_COVERAGE_CACHE', 'Run /coverage/sync first');
    const windows = aggregateLightWindows(cached.slots);
    return { status: 200, data: { date: cached.date, computedAt: cached.computedAt, windows } };
  }

  // Per-location daily summary across a date range. Uses the same per-DOW
  // 90-day historical average that powers the single-day coverage heatmap,
  // so weekly and daily views agree on "expected demand". Per cell:
  //   appts      = averageByDow[dowOf(date)]      (decimal, expected demand)
  //   stylists   = COUNT(DISTINCT stylist_id) from appointments that day
  //                (actual workers — best available proxy for past rosters)
  //   required   = round(appts / ratio(dayOfWeek))
  //   lightHours = number of business hours during which the per-hour distinct
  //                stylist count fell below the day's `required` value
  //   underCover = lightHours >= LIGHT_HOURS_RED_THRESHOLD (3)
  // Locations with zero appointments across the entire window are omitted.
  if (req.path === '/coverage/history' && req.method === 'GET') {
    const start = cleanString(req.query.start);
    const end = cleanString(req.query.end);
    if (!start || !end) return apiError(400, 'BAD_REQUEST', 'start and end required (YYYY-MM-DD)');
    const { ratioForDate, DEFAULT_RATIOS, DEFAULT_AVERAGING_DAYS, DOW_KEYS } = await import('../coverage/types');
    const { averageDailyAppointmentsByDow } = await import('../coverage/sync');
    const ratios = {
      weekday: Number(req.query.weekdayRatio) || DEFAULT_RATIOS.weekday,
      saturday: Number(req.query.saturdayRatio) || DEFAULT_RATIOS.saturday,
      sunday: Number(req.query.sundayRatio) || DEFAULT_RATIOS.sunday,
    };
    const averagingDays = Number(req.query.averagingDays) || DEFAULT_AVERAGING_DAYS;
    const { db, sqlite } = initializeDatabase(teamId);

    type ActualRow = { locationId: string; date: string; stylists: number };
    const actualRows = sqlite.prepare(
      `SELECT location_id AS locationId,
              substr(start_at, 1, 10) AS date,
              COUNT(DISTINCT stylist_id) AS stylists
         FROM appointments
        WHERE team_id = ?
          AND start_at IS NOT NULL
          AND substr(start_at, 1, 10) BETWEEN ? AND ?
          AND stylist_id IS NOT NULL
          AND stylist_id <> ''
        GROUP BY location_id, date`
    ).all(teamId, start, end) as ActualRow[];

    // Read the daily coverage cache. slot_payload already has the per-slot
    // `light` flag, `scheduledStylists` and `averageDailyAppointments` the
    // daily heatmap + drill-down render — surfacing all three here keeps
    // the 10-day view consistent with the views the user can drill into:
    //   - lightHours: copied directly so under-cover state matches.
    //   - peakStylists: max scheduledStylists across the day's slots, NOT
    //     the count of distinct rostered stylistIds. A stylist who only
    //     works the morning shouldn't inflate "stylists on" past what
    //     the hourly view ever shows simultaneously.
    //   - cachedAverageDailyAppts: each cached day's average was computed
    //     with its own sync-time reference date, so reading it back here
    //     guarantees the cell's "avg X/day" matches the drill-down's
    //     "avg X/day" — a live recompute with referenceDate=end would
    //     include today's in-progress sales and future-rostered-but-empty
    //     days, deflating the per-DOW average.
    type CacheRow = { locationId: string; date: string; slot_payload: string | null; rostered_payload: string | null };
    const cacheRows = sqlite.prepare(
      `SELECT location_id AS locationId, date, slot_payload, rostered_payload
         FROM location_coverage_facts
        WHERE team_id = ?
          AND date BETWEEN ? AND ?`
    ).all(teamId, start, end) as CacheRow[];

    const LIGHT_HOURS_RED_THRESHOLD = 3;
    type DayMeta = {
      lightHours: number;
      peakStylists: number;
      rosteredStylists: number;
      cachedRequired: number | null;
      cachedAverageDailyAppts: number | null;
    };
    const cacheByLocDate = new Map<string, Map<string, DayMeta>>();
    for (const r of cacheRows) {
      let lightHours = 0;
      let peakStylists = 0;
      let cachedRequired: number | null = null;
      let cachedAverageDailyAppts: number | null = null;
      if (r.slot_payload) {
        try {
          const parsed = JSON.parse(r.slot_payload) as {
            slots?: Array<{ light?: boolean; scheduledStylists?: number; requiredStylists?: number; startsAt?: string; endsAt?: string }>;
            requiredStylists?: number;
            averageDailyAppointments?: number;
          };
          if (typeof parsed.requiredStylists === 'number') cachedRequired = parsed.requiredStylists;
          if (typeof parsed.averageDailyAppointments === 'number') {
            cachedAverageDailyAppts = parsed.averageDailyAppointments;
          }
          // PERSON-HOURS missing, not slot count. For each short slot we
          // add `(required − scheduled) × slot_minutes / 60`. A 1-hour
          // slot needing 5 with 3 on contributes 2 hours; a 30-min slot
          // needing 5 with 3 on contributes 1 hour. This is what an
          // operator means when they ask "how much staffing did we miss?"
          let personMinutesShort = 0;
          const dayRequired = parsed.requiredStylists ?? 0;
          for (const s of parsed.slots ?? []) {
            const scheduled = typeof s.scheduledStylists === 'number' ? s.scheduledStylists : 0;
            if (scheduled > peakStylists) peakStylists = scheduled;
            // Prefer the slot's own requiredStylists if the slot payload
            // carries it (future-proofing for variable-by-hour staffing
            // levels), else fall back to the day-level required.
            const required = typeof s.requiredStylists === 'number' ? s.requiredStylists : dayRequired;
            const deficit = Math.max(0, required - scheduled);
            if (deficit === 0) continue;
            const a = s.startsAt ? Date.parse(s.startsAt) : NaN;
            const b = s.endsAt ? Date.parse(s.endsAt) : NaN;
            const minutes = Number.isFinite(a) && Number.isFinite(b) && b > a
              ? Math.round((b - a) / 60000)
              : 60; // legacy slot fallback
            personMinutesShort += deficit * minutes;
          }
          lightHours = Math.round((personMinutesShort / 60) * 10) / 10;
        } catch { /* leave defaults */ }
      }
      let rosteredStylists = 0;
      if (r.rostered_payload) {
        try {
          const parsed = JSON.parse(r.rostered_payload) as {
            rows?: Array<{ stylistId?: string; status?: string }>;
          };
          const scheduled = new Set<string>();
          for (const row of parsed.rows ?? []) {
            if (row.status === 'scheduled' && row.stylistId) scheduled.add(row.stylistId);
          }
          rosteredStylists = scheduled.size;
        } catch { /* leave 0 */ }
      }
      let byDate = cacheByLocDate.get(r.locationId);
      if (!byDate) { byDate = new Map(); cacheByLocDate.set(r.locationId, byDate); }
      byDate.set(r.date, { lightHours, peakStylists, rosteredStylists, cachedRequired, cachedAverageDailyAppts });
    }

    // Enumerate every day in the window once so we know what columns to emit.
    const days: string[] = [];
    {
      const cursor = new Date(`${start}T00:00:00`);
      const stop = new Date(`${end}T00:00:00`);
      while (cursor <= stop) {
        const yyyy = cursor.getFullYear();
        const mm = String(cursor.getMonth() + 1).padStart(2, '0');
        const dd = String(cursor.getDate()).padStart(2, '0');
        days.push(`${yyyy}-${mm}-${dd}`);
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    function dowOf(dateIso: string) {
      const [y, m, d] = dateIso.split('-').map(Number);
      return DOW_KEYS[new Date(y, (m ?? 1) - 1, d ?? 1).getDay()];
    }

    // Build per-location actual-stylist lookup + the set of locations with
    // any appointments in the window (so we omit dormant admin locations).
    const actualByLoc = new Map<string, Map<string, number>>();
    for (const r of actualRows) {
      let inner = actualByLoc.get(r.locationId);
      if (!inner) { inner = new Map(); actualByLoc.set(r.locationId, inner); }
      inner.set(r.date, r.stylists);
    }

    // Union: any location with appointments OR cached coverage in the
    // window. Forward-looking windows often have no bookings yet, so the
    // cache is the primary signal for which locations have data.
    const locationIds = new Set<string>([
      ...actualByLoc.keys(),
      ...cacheByLocDate.keys(),
    ]);

    // YOT occasionally ships duplicate location records that differ only in
    // capitalization (e.g. "Treaty Oaks St. Aug. Fl." (active=0) vs
    // "Treaty Oaks St. Aug. FL." (active=1)). The inactive duplicate has
    // stale coverage cache rows from older syncs, so it'd otherwise appear
    // as a blank/garbage row on the dashboard. Drop locations flagged
    // inactive on the YOT side.
    const activeLocations = new Set(
      sqlite.prepare(
        `SELECT id FROM locations WHERE team_id = ? AND active = 1`
      ).all(teamId).map((r: any) => String(r.id))
    );
    for (const id of [...locationIds]) {
      if (!activeLocations.has(id)) locationIds.delete(id);
    }

    const data = Array.from(locationIds).map((locationId) => {
      const stylistsByDate = actualByLoc.get(locationId) ?? new Map();
      const { averageByDow, closedByDow } = averageDailyAppointmentsByDow(
        db, sqlite, teamId, locationId, end, averagingDays,
      );
      const cacheByDate = cacheByLocDate.get(locationId);
      const out = days.map((date) => {
        const dow = dowOf(date);
        if (closedByDow[dow]) {
          return { date, stylists: 0, appts: 0, required: 0, lightHours: 0, underCover: false, closed: true, hasRoster: false };
        }
        const ratio = ratioForDate(date, ratios);
        const meta = cacheByDate?.get(date);
        // Prefer the cached averageDailyAppointments (set at sync time with
        // a sync-date-anchored referenceDate, so it doesn't include today's
        // in-progress sales or future-rostered-but-empty days). Falling
        // back to the live per-DOW average only when no cache exists for
        // the day — that's normally cells outside any synced window.
        const appts = meta?.cachedAverageDailyAppts ?? averageByDow[dow] ?? 0;
        // Required also prefers the cached value so the cell agrees with
        // the daily heatmap even if ratios drifted since sync.
        const required = meta?.cachedRequired ?? (ratio > 0 ? Math.round(appts / ratio) : 0);
        // Peak concurrent rostered stylists across the day's slots — the
        // same number the hourly heatmap shows at its busiest hour. A
        // morning-only + evening-only stylist combo would inflate distinct
        // count to 2 while the floor never actually has both present.
        // Fall back to distinct-rostered (then to actual workers) when
        // no slot payload exists (unsynced day).
        const stylists = meta
          ? (meta.peakStylists > 0 ? meta.peakStylists : meta.rosteredStylists)
          : (stylistsByDate.get(date) ?? 0);
        const lightHours = meta?.lightHours ?? 0;
        const underCover = lightHours >= LIGHT_HOURS_RED_THRESHOLD;
        return { date, stylists, appts, required, lightHours, underCover, closed: false, hasRoster: !!meta };
      });
      return { locationId, days: out };
    });

    // Mirror the daily heatmap's isRowInactive filter: drop locations where
    // every day in the window is either DOW-closed or has no expected appts
    // AND no rostered stylists. This hides retired/admin/test locations the
    // hourly heatmap also suppresses by default.
    const filtered = data.filter((loc) =>
      loc.days.some((d) => !d.closed && (d.appts > 0 || d.stylists > 0))
    );

    return { status: 200, data: { start, end, ratios, averagingDays, data: filtered } };
  }

  // GET /coverage/day-schedule?locationId=X&date=YYYY-MM-DD
  // Powers the calendar-style schedule grid in the staff-coverage daily
  // drill-down modal. Returns rostered stylists for the day (with their
  // shift bounds) plus every appointment, with enough fields to render a
  // time-line UI: who, when, what service, status, duration. Out-of-roster
  // appointments (stylist booked but not on roster) are also surfaced so
  // they can't silently disappear from the grid.
  if (req.path === '/coverage/day-schedule' && req.method === 'GET') {
    const locationId = cleanString(req.query.locationId);
    const date = cleanString(req.query.date);
    if (!locationId || !date) return apiError(400, 'BAD_REQUEST', 'locationId and date required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return apiError(400, 'BAD_REQUEST', 'date must be YYYY-MM-DD');
    const { db, sqlite } = initializeDatabase(teamId);

    type CacheRow = { rostered_payload: string | null; slot_payload: string | null };
    const cacheRow = sqlite.prepare(
      `SELECT rostered_payload, slot_payload FROM location_coverage_facts
        WHERE team_id = ? AND location_id = ? AND date = ?`
    ).get(teamId, locationId, date) as CacheRow | undefined;

    type RosterRow = { stylistId?: string; stylistName?: string; status?: string; startsAt?: string; endsAt?: string };
    const rosterRows: RosterRow[] = (() => {
      if (!cacheRow?.rostered_payload) return [];
      try {
        const parsed = JSON.parse(cacheRow.rostered_payload) as { rows?: RosterRow[] };
        return parsed.rows ?? [];
      } catch { return []; }
    })();
    const scheduledRosterRows = rosterRows.filter((r): r is Required<Pick<RosterRow, 'stylistId' | 'startsAt' | 'endsAt'>> & RosterRow =>
      r.status === 'scheduled' && !!r.stylistId && !!r.startsAt && !!r.endsAt
    );

    // Business hours = earliest shift start → latest shift end (with a 30-min
    // pad on each side so the time-axis header has a little breathing room
    // before/after the first/last appointment). Falls back to the slot
    // payload's first/last slot when no scheduled roster rows exist.
    let businessStart: string | null = null;
    let businessEnd: string | null = null;
    if (scheduledRosterRows.length) {
      businessStart = scheduledRosterRows.reduce((acc, r) => (!acc || r.startsAt < acc ? r.startsAt : acc), '' as string);
      businessEnd = scheduledRosterRows.reduce((acc, r) => (!acc || r.endsAt > acc ? r.endsAt : acc), '' as string);
    } else if (cacheRow?.slot_payload) {
      try {
        const parsed = JSON.parse(cacheRow.slot_payload) as { slots?: Array<{ startsAt?: string; endsAt?: string }> };
        const slots = parsed.slots ?? [];
        if (slots.length) {
          businessStart = slots[0]?.startsAt ?? null;
          businessEnd = slots[slots.length - 1]?.endsAt ?? null;
        }
      } catch { /* leave null */ }
    }

    // Pull every appointment for (location, date). Joining to stylists for
    // a clean fullName fallback when the roster row's name isn't available.
    type Appt = {
      id: string;
      stylistId: string | null;
      startAt: string | null;
      endAt: string | null;
      durationMinutes: number | null;
      serviceName: string | null;
      categoryName: string | null;
      clientName: string | null;
      statusCode: number | null;
      statusDescription: string | null;
      cancelledFlag: number | null;
      newClient: number | null;
      onlineBooking: number | null;
    };
    const appointments = sqlite.prepare(
      `SELECT id,
              stylist_id AS stylistId,
              start_at AS startAt,
              end_at AS endAt,
              duration_minutes AS durationMinutes,
              service_name_raw AS serviceName,
              category_name AS categoryName,
              client_name AS clientName,
              status_code AS statusCode,
              status_description AS statusDescription,
              cancelled_flag AS cancelledFlag,
              new_client AS newClient,
              online_booking AS onlineBooking
         FROM appointments
        WHERE team_id = ? AND location_id = ?
          AND substr(start_at, 1, 10) = ?
        ORDER BY start_at ASC`
    ).all(teamId, locationId, date) as Appt[];

    // Build a name lookup for each stylist seen in the roster or in the
    // appointments. roster row provides the YOT-display name; if a row
    // lacks one (rare), fall back to the stylists table.
    const stylistNameById = new Map<string, string>();
    for (const r of rosterRows) {
      if (r.stylistId && r.stylistName) stylistNameById.set(r.stylistId, r.stylistName);
    }
    const idsNeedingNames = new Set<string>();
    for (const r of scheduledRosterRows) {
      if (!stylistNameById.has(r.stylistId)) idsNeedingNames.add(r.stylistId);
    }
    for (const a of appointments) {
      if (a.stylistId && !stylistNameById.has(a.stylistId)) idsNeedingNames.add(a.stylistId);
    }
    if (idsNeedingNames.size) {
      const stylistRows = db.select().from(schema.stylists)
        .where(eq(schema.stylists.teamId, teamId)).all() as schema.Stylist[];
      for (const s of stylistRows) {
        if (idsNeedingNames.has(s.id) && s.fullName) stylistNameById.set(s.id, s.fullName);
      }
    }

    // Stylist rows = rostered stylists, sorted by shift start time. Off-
    // roster stylists who still booked appointments get appended at the end
    // with a null shift so the UI can show their work without inventing a
    // shift it doesn't actually have.
    type StylistRow = {
      stylistId: string;
      fullName: string;
      shiftStartAt: string | null;
      shiftEndAt: string | null;
      onRoster: boolean;
    };
    const rosteredById = new Map<string, StylistRow>();
    for (const r of scheduledRosterRows) {
      const existing = rosteredById.get(r.stylistId);
      // Multiple scheduled chunks (split shifts) → take the widest envelope
      // for simplicity. The appointments themselves still render in their
      // exact slots, so a stylist with a 2-hour mid-shift gap will just
      // have an unmarked stretch on the row.
      if (!existing) {
        rosteredById.set(r.stylistId, {
          stylistId: r.stylistId,
          fullName: stylistNameById.get(r.stylistId) || `Stylist ${r.stylistId}`,
          shiftStartAt: r.startsAt,
          shiftEndAt: r.endsAt,
          onRoster: true,
        });
      } else {
        if (r.startsAt < (existing.shiftStartAt ?? r.startsAt)) existing.shiftStartAt = r.startsAt;
        if (r.endsAt > (existing.shiftEndAt ?? r.endsAt)) existing.shiftEndAt = r.endsAt;
      }
    }
    const offRosterIds = new Set<string>();
    for (const a of appointments) {
      if (a.stylistId && !rosteredById.has(a.stylistId)) offRosterIds.add(a.stylistId);
    }
    const stylists: StylistRow[] = [...rosteredById.values()]
      .sort((a, b) => (a.shiftStartAt || '').localeCompare(b.shiftStartAt || ''));
    for (const id of offRosterIds) {
      stylists.push({
        stylistId: id,
        fullName: stylistNameById.get(id) || `Stylist ${id}`,
        shiftStartAt: null,
        shiftEndAt: null,
        onRoster: false,
      });
    }

    const responseAppointments = appointments.map((a) => ({
      id: a.id,
      stylistId: a.stylistId,
      startAt: a.startAt,
      endAt: a.endAt,
      durationMinutes: a.durationMinutes,
      serviceName: a.serviceName,
      categoryName: a.categoryName,
      clientName: a.clientName,
      statusCode: a.statusCode,
      statusDescription: a.statusDescription,
      isCancelled: a.cancelledFlag === 1 || (a.statusDescription || '').toLowerCase() === 'cancelled',
      isNewClient: a.newClient === 1,
      isOnlineBooking: a.onlineBooking === 1,
    }));

    return {
      status: 200,
      data: {
        locationId,
        date,
        businessStart,
        businessEnd,
        stylists,
        appointments: responseAppointments,
      },
    };
  }

  if (req.path === '/franchises/sync' && req.method === 'POST') {
    try {
      const { syncFranchises } = await import('../coverage/sync-franchises');
      const result = await syncFranchises({ teamId });
      return { status: 200, data: result };
    } catch (err: any) {
      const msg = err?.message || 'Franchise sync failed';
      if (err?.name === 'MvcAuthMissingError') return apiError(412, 'MVC_AUTH_MISSING', msg);
      if (err?.name === 'MvcAuthExpiredError') return apiError(401, 'MVC_AUTH_EXPIRED', msg);
      return apiError(500, 'FRANCHISE_SYNC_FAILED', msg);
    }
  }

  if (req.path === '/franchises' && req.method === 'GET') {
    const { listFranchises } = await import('../coverage/sync-franchises');
    const data = listFranchises(teamId);
    return { status: 200, data: { data, total: data.length } };
  }

  if (req.path === '/coverage/staff-available' && req.method === 'GET') {
    const locationId = cleanString(req.query.locationId);
    const from = cleanString(req.query.from);
    const to = cleanString(req.query.to);
    const serviceMinutes = Number(req.query.serviceMinutes ?? 0);
    const pool = (cleanString(req.query.pool) === 'same' ? 'same' : 'cross') as 'cross' | 'same';
    if (!locationId || !from || !to) return apiError(400, 'BAD_REQUEST', 'locationId, from, to required');

    const { db } = initializeDatabase(teamId);
    const { findStaffAvailable } = await import('../coverage/find-cover');

    // stylists.id is stored as `LOCATION:YOT_ID` (per-location scoped record),
    // while appointments.stylist_id and the roster's data-id attribute are the
    // YOT id alone. Strip the prefix so the appointment-overlap, rostered-
    // today, and lastWorkedHereAt joins line up. Dedup by YOT id, preferring
    // the row whose home matches the requested location.
    const stylistsRaw = db.select().from(schema.stylists).where(eq(schema.stylists.teamId, teamId)).all() as schema.Stylist[];
    const stripPrefix = (compound: string): string => {
      const i = compound.indexOf(':');
      return i >= 0 ? compound.slice(i + 1) : compound;
    };
    const stylistByYotId = new Map<string, { id: string; name: string; homeLocationId: string | null }>();
    for (const s of stylistsRaw) {
      const yotId = stripPrefix(s.id);
      const homeLocId = s.locationId ?? s.sourceLocationId ?? null;
      const name = s.fullName ?? s.id;
      const existing = stylistByYotId.get(yotId);
      if (!existing) {
        stylistByYotId.set(yotId, { id: yotId, name, homeLocationId: homeLocId });
      } else if (homeLocId === locationId && existing.homeLocationId !== locationId) {
        existing.homeLocationId = homeLocId;
      }
    }
    const stylists = Array.from(stylistByYotId.values());

    const apptsRaw = db.select().from(schema.appointments).where(eq(schema.appointments.teamId, teamId)).all() as schema.Appointment[];
    const appointments = apptsRaw
      .map((a) => ({
        stylistId: (a.stylistId ?? a.staffId) as string | null,
        startsAt: (a.startAt ?? a.startsAt) as string | null,
        endsAt: (a.endAt ?? a.endsAt) as string | null,
        locationId: a.locationId ?? null,
      }))
      .filter((a): a is { stylistId: string; startsAt: string; endsAt: string; locationId: string | null } =>
        !!a.stylistId && !!a.startsAt && !!a.endsAt);

    const pastAppointmentsAtLocation = new Map<string, string>();
    for (const a of appointments) {
      if (a.locationId !== locationId) continue;
      const prev = pastAppointmentsAtLocation.get(a.stylistId);
      if (!prev || a.startsAt > prev) pastAppointmentsAtLocation.set(a.stylistId, a.startsAt);
    }

    // Roster: union all rostered shifts cached for the team on `from`'s date.
    const date = from.slice(0, 10);
    const allCached = (db.select().from(schema.locationCoverageFacts).all() as schema.LocationCoverageFact[])
      .filter((r) => r.teamId === teamId && r.date === date);
    const scheduled: Array<{ stylistId: string; startsAt: string; endsAt: string }> = [];
    for (const r of allCached) {
      try {
        const payload = JSON.parse(r.rosteredPayload) as { rows: Array<{ stylistId: string | null; status: string; startsAt: string | null; endsAt: string | null }> };
        for (const row of payload.rows) {
          if (row.status === 'scheduled' && row.stylistId && row.startsAt && row.endsAt) {
            scheduled.push({ stylistId: row.stylistId, startsAt: row.startsAt, endsAt: row.endsAt });
          }
        }
      } catch { /* ignore malformed cache rows */ }
    }

    const candidates = findStaffAvailable({
      locationId,
      from,
      to,
      serviceMinutes,
      pool,
      stylists,
      scheduled,
      appointments: appointments.map((a) => ({ stylistId: a.stylistId, startsAt: a.startsAt, endsAt: a.endsAt })),
      pastAppointmentsAtLocation,
    });

    return { status: 200, data: { candidates, pool, serviceMinutes } };
  }

  return apiError(404, 'NOT_FOUND', `No handler for ${req.method} ${req.path}`);
}
