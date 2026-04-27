import { randomUUID } from 'node:crypto';
import { initializeDatabase } from '../db';
import { createReportClient } from './client';
import { reportRegistry } from './report-registry';
import type { YotConfig } from '../types';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

type RevenueFactCount = {
  appointmentCount: number;
  uniqueClientCount: number;
};

type LocationRow = {
  id: string;
  name: string | null;
};

export type SyncRevenueFactsOptions = {
  teamId: string;
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
  dayOfWeek?: number | null;
};

export type SyncRevenueFactsResult = {
  runId: string;
  teamId: string;
  startDateIso: string;
  endDateIso: string;
  startedAt: string;
  completedAt: string;
  instanceId: string;
  documentId: string;
  clientId: string | null;
  detailRowCount: number;
  totalRowCount: number;
  averageRowCount: number;
  rowsWritten: number;
  matchedLocationCount: number;
  unmatchedLocationNames: string[];
  requestLog: ReturnType<typeof createReportClient>['requestLog'];
};

export type SyncRevenueFactsBatchResult = {
  teamId: string;
  startDateIso: string;
  endDateIso: string;
  startedAt: string;
  completedAt: string;
  detailRowCount: number;
  totalRowCount: number;
  averageRowCount: number;
  rowsWritten: number;
  matchedLocationCount: number;
  unmatchedLocationNames: string[];
  requestLog: ReturnType<typeof createReportClient>['requestLog'];
  chunkCount: number;
  chunks: SyncRevenueFactsResult[];
};

function cleanString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeLocationName(value: unknown): string | null {
  const text = cleanString(value);
  return text ? text.toLowerCase().replace(/[^a-z0-9]+/g, '') : null;
}

function isoDateOnly(value: string): string {
  return value.slice(0, 10);
}

function parseDateOnlyUtc(value: string): Date {
  const [year, month, day] = value.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year || 0, (month || 1) - 1, day || 1));
}

function formatDateOnlyUtc(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

function addDaysToDateOnly(value: string, days: number): string {
  const date = parseDateOnlyUtc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnlyUtc(date);
}

function minDateOnly(a: string, b: string): string {
  return a <= b ? a : b;
}

function parseReportDate(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function readConfig(sqlite: SqliteDb, teamId: string): YotConfig {
  const row = sqlite
    .prepare("SELECT value FROM plugin_config WHERE team_id = ? AND key = 'yot'")
    .get(teamId) as { value?: string } | undefined;
  if (!row?.value) throw new Error(`No YOT config found for team ${teamId}`);
  const parsed = JSON.parse(row.value) as YotConfig;
  if (!parsed?.apiKey) throw new Error(`Invalid YOT config payload for team ${teamId}`);
  return parsed;
}

function buildLocationLookup(sqlite: SqliteDb, teamId: string): Map<string, LocationRow[]> {
  const rows = sqlite
    .prepare('SELECT id, name FROM locations WHERE team_id = ?')
    .all(teamId) as LocationRow[];
  const map = new Map<string, LocationRow[]>();
  for (const row of rows) {
    const key = normalizeLocationName(row.name);
    if (!key) continue;
    const bucket = map.get(key) || [];
    bucket.push(row);
    map.set(key, bucket);
  }
  return map;
}

function resolveLocationId(lookup: Map<string, LocationRow[]>, locationName: string): string | null {
  const key = normalizeLocationName(locationName);
  if (!key) return null;
  const matches = lookup.get(key) || [];
  if (matches.length === 1) return matches[0]!.id;
  const exact = matches.find((row) => cleanString(row.name) === cleanString(locationName));
  return exact?.id || null;
}

function buildAppointmentCounts(sqlite: SqliteDb, teamId: string, startDate: string, endDate: string): Map<string, RevenueFactCount> {
  const rows = sqlite.prepare(`
    SELECT
      location_id AS locationId,
      substr(start_at, 1, 10) AS date,
      COUNT(*) AS appointmentCount,
      COUNT(DISTINCT client_id) AS uniqueClientCount
    FROM appointments
    WHERE team_id = ?
      AND start_at IS NOT NULL
      AND substr(start_at, 1, 10) >= ?
      AND substr(start_at, 1, 10) <= ?
    GROUP BY location_id, substr(start_at, 1, 10)
  `).all(teamId, startDate, endDate) as Array<{
    locationId: string | null;
    date: string | null;
    appointmentCount: number;
    uniqueClientCount: number;
  }>;

  const map = new Map<string, RevenueFactCount>();
  for (const row of rows) {
    if (!row.locationId || !row.date) continue;
    map.set(`${row.locationId}::${row.date}`, {
      appointmentCount: Number(row.appointmentCount || 0),
      uniqueClientCount: Number(row.uniqueClientCount || 0),
    });
  }
  return map;
}

function upsertSyncState(sqlite: SqliteDb, teamId: string, values: { lastSyncedAt?: string | null; lastSuccessAt?: string | null; lastError?: string | null; rowCount?: number | null }) {
  sqlite.prepare(`
    INSERT INTO sync_state (team_id, resource, last_synced_at, last_success_at, last_error, row_count)
    VALUES (?, 'revenue_facts', ?, ?, ?, ?)
    ON CONFLICT(team_id, resource) DO UPDATE SET
      last_synced_at = excluded.last_synced_at,
      last_success_at = COALESCE(excluded.last_success_at, sync_state.last_success_at),
      last_error = excluded.last_error,
      row_count = COALESCE(excluded.row_count, sync_state.row_count)
  `).run(teamId, values.lastSyncedAt ?? null, values.lastSuccessAt ?? null, values.lastError ?? null, values.rowCount ?? null);
}

function splitRevenueSyncWindows(startDateIso: string, endDateIso: string, chunkDays: number): Array<{ startDateIso: string; endDateIso: string }> {
  const startDate = isoDateOnly(startDateIso);
  const endDate = isoDateOnly(endDateIso);
  const windows: Array<{ startDateIso: string; endDateIso: string }> = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const chunkEndDate = minDateOnly(addDaysToDateOnly(cursor, chunkDays - 1), endDate);
    windows.push({ startDateIso: `${cursor}T00:00:00.000Z`, endDateIso: `${chunkEndDate}T00:00:00.000Z` });
    cursor = addDaysToDateOnly(chunkEndDate, 1);
  }
  return windows;
}

export async function syncRevenueFactsRangeFromDailyRevenueSummary(options: SyncRevenueFactsOptions & { chunkDays?: number | null }): Promise<SyncRevenueFactsBatchResult> {
  const chunkDays = Math.max(1, Math.min(Math.trunc(options.chunkDays ?? 28), 31));
  const windows = splitRevenueSyncWindows(options.startDateIso, options.endDateIso, chunkDays);
  const startedAt = new Date().toISOString();
  const chunks: SyncRevenueFactsResult[] = [];
  const unmatchedLocationNames = new Set<string>();
  let detailRowCount = 0;
  let totalRowCount = 0;
  let averageRowCount = 0;
  let rowsWritten = 0;
  const requestLog: ReturnType<typeof createReportClient>['requestLog'] = [];

  for (const window of windows) {
    const chunk = await syncRevenueFactsFromDailyRevenueSummary({
      ...options,
      startDateIso: window.startDateIso,
      endDateIso: window.endDateIso,
    });
    chunks.push(chunk);
    detailRowCount += chunk.detailRowCount;
    totalRowCount += chunk.totalRowCount;
    averageRowCount += chunk.averageRowCount;
    rowsWritten += chunk.rowsWritten;
    requestLog.push(...chunk.requestLog);
    for (const name of chunk.unmatchedLocationNames) unmatchedLocationNames.add(name);
  }

  const { sqlite } = initializeDatabase(options.teamId);
  const startDate = isoDateOnly(options.startDateIso);
  const endDate = isoDateOnly(options.endDateIso);
  const matchedLocationCountQuery = options.locationId == null
    ? sqlite.prepare('SELECT COUNT(DISTINCT location_id) AS c FROM revenue_facts WHERE team_id = ? AND date >= ? AND date <= ?')
    : sqlite.prepare('SELECT COUNT(DISTINCT location_id) AS c FROM revenue_facts WHERE team_id = ? AND location_id = ? AND date >= ? AND date <= ?');
  const row = (options.locationId == null
    ? matchedLocationCountQuery.get(options.teamId, startDate, endDate)
    : matchedLocationCountQuery.get(options.teamId, String(options.locationId), startDate, endDate)) as { c?: number } | undefined;

  return {
    teamId: options.teamId,
    startDateIso: options.startDateIso,
    endDateIso: options.endDateIso,
    startedAt,
    completedAt: new Date().toISOString(),
    detailRowCount,
    totalRowCount,
    averageRowCount,
    rowsWritten,
    matchedLocationCount: Number(row?.c || 0),
    unmatchedLocationNames: Array.from(unmatchedLocationNames).sort(),
    requestLog,
    chunkCount: chunks.length,
    chunks,
  };
}

export async function syncRevenueFactsFromDailyRevenueSummary(options: SyncRevenueFactsOptions): Promise<SyncRevenueFactsResult> {
  const { sqlite } = initializeDatabase(options.teamId);
  const startedAt = new Date().toISOString();
  const runId = randomUUID();

  sqlite.prepare(`
    INSERT INTO sync_runs (id, team_id, resource, status, started_at, notes)
    VALUES (?, ?, 'revenue_facts', 'running', ?, ?)
  `).run(runId, options.teamId, startedAt, `start=${options.startDateIso}; end=${options.endDateIso}`);

  try {
    const config = readConfig(sqlite, options.teamId);
    const client = createReportClient(config);
    const params = {
      startDateIso: options.startDateIso,
      endDateIso: options.endDateIso,
      organisationId: options.organisationId,
      locationId: options.locationId ?? null,
      staffId: options.staffId ?? null,
      dayOfWeek: options.dayOfWeek ?? null,
    };

    const parameterDefinitions = await client.getParameters(
      reportRegistry.dailyRevenueSummary.reportType,
      reportRegistry.dailyRevenueSummary.buildParameterDiscovery(params, config.apiKey),
    );
    const instanceId = await client.createInstance(
      reportRegistry.dailyRevenueSummary.reportType,
      reportRegistry.dailyRevenueSummary.buildInstanceParams(params),
    );
    const document = await client.createDocument(instanceId, reportRegistry.dailyRevenueSummary.preferredFormat);
    await client.waitForDocument(instanceId, document.documentId);
    const file = await client.fetchDocument(instanceId, document.documentId);
    const parsed = reportRegistry.dailyRevenueSummary.parseDocument(file.buffer, parameterDefinitions);

    const detailRows = parsed.rows.filter((row) => row.rowKind === 'detail');
    const averageRowCount = parsed.rows.filter((row) => row.rowKind === 'average').length;
    const totalRowCount = parsed.rows.filter((row) => row.rowKind === 'total').length;
    const startDate = isoDateOnly(options.startDateIso);
    const endDate = isoDateOnly(options.endDateIso);
    const locationLookup = buildLocationLookup(sqlite, options.teamId);
    const appointmentCounts = buildAppointmentCounts(sqlite, options.teamId, startDate, endDate);
    const unmatchedLocationNames = new Set<string>();
    const matchedLocationIds = new Set<string>();
    let rowsWritten = 0;

    const upsertRevenueFact = sqlite.prepare(`
      INSERT INTO revenue_facts (
        team_id,
        location_id,
        date,
        gross_amount,
        discount_amount,
        net_amount,
        appointment_count,
        unique_client_count,
        last_updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, location_id, date) DO UPDATE SET
        gross_amount = excluded.gross_amount,
        discount_amount = excluded.discount_amount,
        net_amount = excluded.net_amount,
        appointment_count = excluded.appointment_count,
        unique_client_count = excluded.unique_client_count,
        last_updated_at = excluded.last_updated_at
    `);

    for (const row of detailRows) {
      const locationId = resolveLocationId(locationLookup, row.locationName);
      const date = parseReportDate(row.date);
      if (!locationId || !date) {
        if (!locationId) unmatchedLocationNames.add(row.locationName);
        continue;
      }
      matchedLocationIds.add(locationId);
      const counts = appointmentCounts.get(`${locationId}::${date}`);
      const grossAmount = row.totalRevenue ?? row.taxableRevenue ?? row.revenueLessTax;
      const netAmount = row.revenueLessTax ?? row.totalRevenue ?? row.taxableRevenue;
      upsertRevenueFact.run(
        options.teamId,
        locationId,
        date,
        grossAmount,
        0,
        netAmount,
        counts?.appointmentCount ?? null,
        counts?.uniqueClientCount ?? null,
        startedAt,
      );
      rowsWritten += 1;
    }

    const completedAt = new Date().toISOString();
    const noteParts = [
      `start=${options.startDateIso}`,
      `end=${options.endDateIso}`,
      `detailRows=${detailRows.length}`,
      `rowsWritten=${rowsWritten}`,
      `matchedLocations=${matchedLocationIds.size}`,
      `unmatchedLocations=${unmatchedLocationNames.size}`,
    ];
    if (unmatchedLocationNames.size) noteParts.push(`unmatched=${Array.from(unmatchedLocationNames).slice(0, 10).join('|')}`);

    upsertSyncState(sqlite, options.teamId, {
      lastSyncedAt: completedAt,
      lastSuccessAt: completedAt,
      lastError: null,
      rowCount: rowsWritten,
    });
    sqlite.prepare(`
      UPDATE sync_runs
      SET status = 'success', completed_at = ?, rows_seen = ?, rows_written = ?, page_count = ?, notes = ?, error = NULL
      WHERE id = ?
    `).run(completedAt, detailRows.length, rowsWritten, parsed.locations.length, noteParts.join('; '), runId);

    return {
      runId,
      teamId: options.teamId,
      startDateIso: options.startDateIso,
      endDateIso: options.endDateIso,
      startedAt,
      completedAt,
      instanceId,
      documentId: document.documentId,
      clientId: client.getClientId(),
      detailRowCount: detailRows.length,
      totalRowCount,
      averageRowCount,
      rowsWritten,
      matchedLocationCount: matchedLocationIds.size,
      unmatchedLocationNames: Array.from(unmatchedLocationNames).sort(),
      requestLog: client.requestLog,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const errMsg = error instanceof Error ? error.message : String(error);
    sqlite.prepare(`
      UPDATE sync_runs
      SET status = 'error', completed_at = ?, error = ?
      WHERE id = ?
    `).run(completedAt, errMsg, runId);
    upsertSyncState(sqlite, options.teamId, {
      lastSyncedAt: completedAt,
      lastError: errMsg,
    });
    throw error;
  }
}
