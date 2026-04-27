import { randomUUID } from 'node:crypto';
import { initializeDatabase } from '../db';
import { createReportClient } from './client';
import { reportRegistry } from './report-registry';
import type { YotConfig } from '../types';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

type LocationRow = {
  id: string;
  name: string | null;
};

export type SyncPromotionUsageOptions = {
  teamId: string;
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
};

export type SyncPromotionUsageResult = {
  runId: string;
  teamId: string;
  startDateIso: string;
  endDateIso: string;
  startedAt: string;
  completedAt: string;
  instanceId: string;
  documentId: string;
  clientId: string | null;
  rowCount: number;
  rowsWritten: number;
  promotionCount: number;
  matchedLocationCount: number;
  unmatchedLocationNames: string[];
  requestLog: ReturnType<typeof createReportClient>['requestLog'];
  promotionIds?: string[];
  matchedLocationIds?: string[];
};

function cleanString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeKey(value: unknown): string | null {
  const text = cleanString(value);
  return text ? text.toLowerCase().replace(/[^a-z0-9]+/g, '-') : null;
}

function normalizeLocationName(value: unknown): string | null {
  const text = cleanString(value);
  return text ? text.toLowerCase().replace(/[^a-z0-9]+/g, '') : null;
}

function isGenericPromotionCode(value: unknown): boolean {
  const text = cleanString(value);
  if (!text) return false;
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '') === 'nocode';
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

function upsertSyncState(sqlite: SqliteDb, teamId: string, values: { lastSyncedAt?: string | null; lastSuccessAt?: string | null; lastError?: string | null; rowCount?: number | null }) {
  sqlite.prepare(`
    INSERT INTO sync_state (team_id, resource, last_synced_at, last_success_at, last_error, row_count)
    VALUES (?, 'promotion_usage', ?, ?, ?, ?)
    ON CONFLICT(team_id, resource) DO UPDATE SET
      last_synced_at = excluded.last_synced_at,
      last_success_at = COALESCE(excluded.last_success_at, sync_state.last_success_at),
      last_error = excluded.last_error,
      row_count = COALESCE(excluded.row_count, sync_state.row_count)
  `).run(teamId, values.lastSyncedAt ?? null, values.lastSuccessAt ?? null, values.lastError ?? null, values.rowCount ?? null);
}

function splitPromotionSyncWindows(startDateIso: string, endDateIso: string): Array<{ startDateIso: string; endDateIso: string }> {
  const startDate = isoDateOnly(startDateIso);
  const endDate = isoDateOnly(endDateIso);
  const windows: Array<{ startDateIso: string; endDateIso: string }> = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    windows.push({ startDateIso: `${cursor}T00:00:00.000Z`, endDateIso: `${cursor}T00:00:00.000Z` });
    cursor = addDaysToDateOnly(cursor, 1);
  }
  return windows;
}

export async function syncPromotionUsageRange(options: SyncPromotionUsageOptions & { chunkDays?: number | null }): Promise<SyncPromotionUsageResult & { chunkCount: number; chunks: SyncPromotionUsageResult[] }> {
  const windows = splitPromotionSyncWindows(options.startDateIso, options.endDateIso);
  const chunks: SyncPromotionUsageResult[] = [];
  const unmatchedLocationNames = new Set<string>();
  const requestLog: ReturnType<typeof createReportClient>['requestLog'] = [];
  const promotionKeys = new Set<string>();
  let rowCount = 0;
  let rowsWritten = 0;
  const matchedLocationIds = new Set<string>();
  const startedAt = new Date().toISOString();

  for (const window of windows) {
    const chunk = await syncPromotionUsage(window.startDateIso, window.endDateIso, options);
    chunks.push(chunk);
    rowCount += chunk.rowCount;
    rowsWritten += chunk.rowsWritten;
    requestLog.push(...chunk.requestLog);
    for (const name of chunk.unmatchedLocationNames) unmatchedLocationNames.add(name);
    for (const key of chunk.promotionIds || []) promotionKeys.add(key);
    for (const id of chunk.matchedLocationIds || []) matchedLocationIds.add(id);
  }

  const completedAt = new Date().toISOString();
  return {
    ...chunks[chunks.length - 1]!,
    startedAt,
    completedAt,
    rowCount,
    rowsWritten,
    promotionCount: promotionKeys.size,
    matchedLocationCount: matchedLocationIds.size,
    unmatchedLocationNames: Array.from(unmatchedLocationNames).sort(),
    requestLog,
    chunkCount: chunks.length,
    chunks,
  };
}

async function syncPromotionUsage(startDateIso: string, endDateIso: string, options: SyncPromotionUsageOptions): Promise<SyncPromotionUsageResult> {
  const { sqlite } = initializeDatabase(options.teamId);
  const startedAt = new Date().toISOString();
  const runId = randomUUID();

  sqlite.prepare(`
    INSERT INTO sync_runs (id, team_id, resource, status, started_at, notes)
    VALUES (?, ?, 'promotion_usage', 'running', ?, ?)
  `).run(runId, options.teamId, startedAt, `start=${startDateIso}; end=${endDateIso}`);

  try {
    const config = readConfig(sqlite, options.teamId);
    const client = createReportClient(config);
    const params = {
      startDateIso,
      endDateIso,
      organisationId: options.organisationId,
      locationId: options.locationId ?? null,
      staffId: options.staffId ?? null,
    };

    const parameterDefinitions = await client.getParameters(
      reportRegistry.promotionUsage.reportType,
      reportRegistry.promotionUsage.buildParameterDiscovery(params, config.apiKey),
    );
    const instanceId = await client.createInstance(
      reportRegistry.promotionUsage.reportType,
      reportRegistry.promotionUsage.buildInstanceParams(params),
    );
    const document = await client.createDocument(instanceId, reportRegistry.promotionUsage.preferredFormat);
    await client.waitForDocument(instanceId, document.documentId);
    const file = await client.fetchDocument(instanceId, document.documentId);
    const parsed = reportRegistry.promotionUsage.parseDocument(file.buffer, parameterDefinitions);
    const requestedUsageIso = `${isoDateOnly(startDateIso)}T00:00:00.000Z`;
    sqlite.prepare('DELETE FROM promotion_usage WHERE team_id = ? AND used_at = ?').run(options.teamId, requestedUsageIso);
    const locationLookup = buildLocationLookup(sqlite, options.teamId);
    const unmatchedLocationNames = new Set<string>();
    const matchedLocationIds = new Set<string>();
    const promotionIds = new Set<string>();
    const aggregates = new Map<string, {
      promotionId: string;
      locationId: string;
      date: string;
      promotionName: string | null;
      promotionCode: string | null;
      locationName: string;
      usageCount: number;
      discountAmount: number | null;
      rawRows: string[][];
    }>();
    let rowsWritten = 0;

    const upsertPromotion = sqlite.prepare(`
      INSERT INTO promotions (
        id,
        team_id,
        code,
        name,
        start_at,
        end_at,
        discount_type,
        discount_value,
        location_id,
        active,
        raw,
        synced_at
      )
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        code = COALESCE(excluded.code, promotions.code),
        name = COALESCE(excluded.name, promotions.name),
        raw = excluded.raw,
        synced_at = excluded.synced_at
    `);

    const upsertUsage = sqlite.prepare(`
      INSERT INTO promotion_usage (
        id,
        team_id,
        promotion_id,
        location_id,
        appointment_id,
        client_id,
        used_at,
        discount_amount,
        raw,
        synced_at
      )
      VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        promotion_id = excluded.promotion_id,
        location_id = excluded.location_id,
        used_at = excluded.used_at,
        discount_amount = excluded.discount_amount,
        raw = excluded.raw,
        synced_at = excluded.synced_at
    `);

    const inferredDate = isoDateOnly(startDateIso);
    for (const row of parsed.rows) {
      if (!row.locationName) continue;
      const locationId = resolveLocationId(locationLookup, row.locationName);
      if (!locationId) {
        unmatchedLocationNames.add(row.locationName);
        continue;
      }

      const normalizedPromotionCode = normalizeKey(row.promotionCode);
      const usablePromotionCode = normalizedPromotionCode && !isGenericPromotionCode(row.promotionCode) ? row.promotionCode : null;
      const keySource = usablePromotionCode || row.promotionName;
      const promotionKey = normalizeKey(keySource);
      if (!promotionKey) continue;

      const promotionId = `${options.teamId}::promotion::${promotionKey}`;
      matchedLocationIds.add(locationId);
      promotionIds.add(promotionId);
      const rowDate = row.date || inferredDate;
      const aggregateKey = `${locationId}::${rowDate}::${promotionId}`;
      const aggregate = aggregates.get(aggregateKey) || {
        promotionId,
        locationId,
        date: rowDate,
        promotionName: row.promotionName,
        promotionCode: usablePromotionCode,
        locationName: row.locationName,
        usageCount: 0,
        discountAmount: 0,
        rawRows: [],
      };
      aggregate.usageCount += row.usageCount;
      aggregate.discountAmount = (aggregate.discountAmount || 0) + (row.discountAmount || 0);
      aggregate.rawRows.push(row.raw);
      if (!aggregate.promotionName && row.promotionName) aggregate.promotionName = row.promotionName;
      if (!aggregate.promotionCode && usablePromotionCode) aggregate.promotionCode = usablePromotionCode;
      aggregates.set(aggregateKey, aggregate);
    }

    for (const aggregate of aggregates.values()) {
      const usageId = `${options.teamId}::promotion-usage::${aggregate.locationId}::${aggregate.date}::${aggregate.promotionId}`;
      const usageIso = `${aggregate.date}T00:00:00.000Z`;
      const raw = JSON.stringify({
        date: aggregate.date,
        locationName: aggregate.locationName,
        promotionName: aggregate.promotionName,
        promotionCode: aggregate.promotionCode,
        usageCount: aggregate.usageCount,
        discountAmount: aggregate.discountAmount,
        source: 'PromotionsUsed',
        reportRows: aggregate.rawRows,
      });

      upsertPromotion.run(
        aggregate.promotionId,
        options.teamId,
        aggregate.promotionCode,
        aggregate.promotionName || aggregate.promotionCode,
        raw,
        startedAt,
      );
      upsertUsage.run(
        usageId,
        options.teamId,
        aggregate.promotionId,
        aggregate.locationId,
        usageIso,
        aggregate.discountAmount,
        raw,
        startedAt,
      );
      rowsWritten += 1;
    }

    const totalRows = (sqlite.prepare('SELECT COUNT(*) AS c FROM promotion_usage WHERE team_id = ?').get(options.teamId) as { c?: number } | undefined)?.c || 0;
    const completedAt = new Date().toISOString();
    const notes = [
      `start=${startDateIso}`,
      `end=${endDateIso}`,
      `rows=${parsed.rows.length}`,
      `rowsWritten=${rowsWritten}`,
      `promotions=${promotionIds.size}`,
      `matchedLocations=${matchedLocationIds.size}`,
      `unmatchedLocations=${unmatchedLocationNames.size}`,
    ].join('; ');

    upsertSyncState(sqlite, options.teamId, {
      lastSyncedAt: completedAt,
      lastSuccessAt: completedAt,
      lastError: null,
      rowCount: Number(totalRows),
    });
    sqlite.prepare(`
      UPDATE sync_runs
      SET status = 'success', completed_at = ?, rows_seen = ?, rows_written = ?, page_count = ?, notes = ?, error = NULL
      WHERE id = ?
    `).run(completedAt, parsed.rows.length, rowsWritten, promotionIds.size, notes, runId);

    return {
      runId,
      teamId: options.teamId,
      startDateIso,
      endDateIso,
      startedAt,
      completedAt,
      instanceId,
      documentId: document.documentId,
      clientId: client.getClientId(),
      rowCount: parsed.rows.length,
      rowsWritten,
      promotionCount: promotionIds.size,
      matchedLocationCount: matchedLocationIds.size,
      unmatchedLocationNames: Array.from(unmatchedLocationNames).sort(),
      requestLog: client.requestLog,
      promotionIds: Array.from(promotionIds),
      matchedLocationIds: Array.from(matchedLocationIds),
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
