// Request router for kitchen-plugin-yot.
// Kitchen invokes handleRequest({ path, method, query, headers, body }, ctx)
// and expects { status, data } back.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { initializeDatabase } from '../db';
import * as schema from '../db/schema';
import { characterizeClientPaging, fetchBusiness, fetchClients, fetchLocations, ping } from '../drivers/yot-client';
import type { KitchenPluginContext } from './types-kitchen';
import type { ApiError, ClientRecord, ExportManifestRecord, LocationRecord, SyncRunRecord, YotConfig } from '../types';

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

function normalizeFullName(item: Record<string, any>): string | null {
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

function parseBooleanFilter(value: string | undefined): boolean | null {
  if (value == null || value === '') return null;
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'active'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'inactive'].includes(normalized)) return false;
  return null;
}

function parseSort(query: Record<string, string | undefined>): { field: string; direction: 'asc' | 'desc' } {
  const allowed = new Set(['fullName', 'firstName', 'lastName', 'lastVisitAt', 'syncedAt', 'createdAtRemote']);
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
    { name: 'appointments.json', rows: db.select().from(schema.appointments).where(eq(schema.appointments.teamId, teamId)).all() },
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
    const { db } = initializeDatabase(teamId);
    const syncRows = db.select().from(schema.syncState).where(eq(schema.syncState.teamId, teamId)).all();
    const counts = {
      clients: Number(db.select({ c: sql<number>`count(*)` }).from(schema.clients).where(eq(schema.clients.teamId, teamId)).all()?.[0]?.c || 0),
      locations: Number(db.select({ c: sql<number>`count(*)` }).from(schema.locations).where(eq(schema.locations.teamId, teamId)).all()?.[0]?.c || 0),
      appointments: Number(db.select({ c: sql<number>`count(*)` }).from(schema.appointments).where(eq(schema.appointments.teamId, teamId)).all()?.[0]?.c || 0),
    };
    return {
      status: 200,
      data: {
        ok: true,
        teamId,
        yotConfigured: Boolean(config),
        dbMode: `yot-${teamId}.db`,
        counts,
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

  if (req.path === '/locations' && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const { limit, offset } = parsePagination(req.query);
      const activeFilter = parseBooleanFilter(req.query.active);
      let rows = db.select().from(schema.locations).where(eq(schema.locations.teamId, teamId)).all();
      if (activeFilter !== null) rows = rows.filter((row: schema.Location) => row.active === activeFilter);
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
      const search = cleanString(req.query.search || req.query.q);
      const { field, direction } = parseSort(req.query);

      let rows = db.select().from(schema.clients).where(eq(schema.clients.teamId, teamId)).all() as schema.Client[];
      if (activeFilter !== null) rows = rows.filter((row) => row.active === activeFilter);
      if (locationFilter) rows = rows.filter((row) => row.sourceLocationId === locationFilter);
      if (cleanString(req.query.lastVisitBefore)) rows = rows.filter((row) => !row.lastVisitAt || row.lastVisitAt <= String(req.query.lastVisitBefore));
      if (cleanString(req.query.lastVisitAfter)) rows = rows.filter((row) => !!row.lastVisitAt && row.lastVisitAt >= String(req.query.lastVisitAfter));
      if (search) {
        const term = search.toLowerCase();
        rows = rows.filter((row) =>
          [row.fullName, row.firstName, row.lastName, row.emailAddress, row.mobilePhone, row.homePhone, row.businessPhone, row.phone]
            .some((value) => String(value || '').toLowerCase().includes(term))
        );
      }

      rows.sort((a, b) => {
        const dir = direction === 'asc' ? 1 : -1;
        const aValue = String((a as any)[field] || '');
        const bValue = String((b as any)[field] || '');
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
      return { status: 200, data: mapClientRecord(rows[0]) };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read client');
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
      const rows = db.select().from(schema.syncRuns).where(eq(schema.syncRuns.teamId, teamId)).all() as schema.SyncRun[];
      rows.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
      const total = rows.length;
      return { status: 200, data: { data: rows.slice(offset, offset + limit).map(mapSyncRun), total, limit, offset } };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read sync runs');
    }
  }

  return apiError(404, 'NOT_FOUND', `No handler for ${req.method} ${req.path}`);
}
