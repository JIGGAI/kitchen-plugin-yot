// Request router for kitchen-plugin-yot.
// Kitchen invokes handleRequest({ path, method, query, headers, body }, ctx)
// and expects { status, data } back.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { initializeDatabase } from '../db';
import * as schema from '../db/schema';
import { listAppointmentsForRequest } from './list-appointments';
import { buildAppointmentLookupsForRows } from './appointment-lookups';
import { characterizeClientPaging, extractAppointmentsRangeRows, fetchAppointmentsRange, fetchBusiness, fetchClients, fetchLocationServices, fetchLocationStaff, fetchLocations, fetchStaffProfile, ping } from '../drivers/yot-client';
import { runStaffCashoutReport } from '../reports/run-staff-cashout';
import { listStaffCashoutFacts, syncStaffCashoutFromReport } from '../reports/sync-staff-cashout';
import { syncPromotionUsageRange } from '../reports/sync-promotion-usage';
import { syncRevenueFactsRangeFromDailyRevenueSummary } from '../reports/sync-revenue-facts';
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
    };
    bucket.grossAmount += asNumber(row.grossAmount);
    bucket.discountAmount += asNumber(row.discountAmount);
    bucket.netAmount += asNumber(row.netAmount);
    bucket.appointmentCount += asNumber(row.appointmentCount);
    bucket.uniqueClientCount += asNumber(row.uniqueClientCount);
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
    }));
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
      const days = clampDays(parseInt(req.query.days || '1', 10), 1);
      const includeToday = parseBooleanFilter(req.query.includeToday) === true;
      const anchorEnd = includeToday ? dateOnlyNow() : addDaysToDateOnly(dateOnlyNow(), -1);
      const endDate = requestedEnd || anchorEnd;
      const startDate = requestedStart || addDaysToDateOnly(endDate, -(days - 1));
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
      const days = clampDays(parseInt(req.query.days || '1', 10), 1);
      const includeToday = parseBooleanFilter(req.query.includeToday) === true;
      const anchorEnd = includeToday ? dateOnlyNow() : addDaysToDateOnly(dateOnlyNow(), -1);
      const endDate = requestedEnd || anchorEnd;
      const startDate = requestedStart || addDaysToDateOnly(endDate, -(days - 1));
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

  if (req.path === '/staff-cashout/sync' && req.method === 'POST') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');
    try {
      const requestedStart = toDateOnlyInput(req.query.startDate || req.query.dateFrom || req.query.start || req.query.date);
      const requestedEnd = toDateOnlyInput(req.query.endDate || req.query.dateTo || req.query.end || req.query.date);
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
      if (locationFilter) rows = rows.filter((row) => row.sourceLocationId === locationFilter);
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
    const lookbackDays = Math.max(1, Math.min(parseInt(req.query.lookbackDays || '30', 10) || 30, 365));
    try {
      const { db } = initializeDatabase(teamId);
      db.insert(schema.syncRuns).values({ id: runId, teamId, resource: 'appointments', status: 'running', startedAt, notes: `lookbackDays=${lookbackDays}` }).run();
      const locations = await fetchLocations(config);
      const activeLocations = locations.filter((item) => item?.id != null && item?.active !== false);
      const now = new Date().toISOString();
      const enddate = Date.now();
      const date = enddate - lookbackDays * 24 * 60 * 60 * 1000;
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

  return apiError(404, 'NOT_FOUND', `No handler for ${req.method} ${req.path}`);
}
