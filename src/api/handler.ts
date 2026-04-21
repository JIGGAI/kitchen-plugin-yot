// Request router for kitchen-plugin-yot.
// Kitchen invokes handleRequest({ path, method, query, headers, body }, ctx)
// and expects { status, data } back.

import { and, eq, sql } from 'drizzle-orm';
import { initializeDatabase } from '../db';
import * as schema from '../db/schema';
import { fetchBusiness, fetchClients, fetchLocations, ping } from '../drivers/yot-client';
import type { KitchenPluginContext } from './types-kitchen';
import type { ApiError, YotConfig } from '../types';

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

export async function handleRequest(req: PluginRequest, _ctx: KitchenPluginContext): Promise<PluginResponse> {
  const teamId = getTeamId(req);

  // ---- /ping ----
  if (req.path === '/ping' && req.method === 'GET') {
    const config = readYotConfig(teamId);
    if (!config) return { status: 200, data: { ok: true, yotConfigured: false } };
    const result = await ping(config);
    return { status: 200, data: { ok: true, yotConfigured: true, yot: result } };
  }

  // ---- /config (per-team plugin config, e.g. YOT API key) ----
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
        try {
          db.run(sql`INSERT INTO plugin_config (team_id, key, value, updated_at) VALUES (${teamId}, ${key}, ${valueStr}, ${now})
                     ON CONFLICT(team_id, key) DO UPDATE SET value = ${valueStr}, updated_at = ${now}`);
        } catch {
          const existing = db.select().from(schema.pluginConfig)
            .where(and(eq(schema.pluginConfig.teamId, teamId), eq(schema.pluginConfig.key, key))).all();
          if (existing.length) {
            db.update(schema.pluginConfig).set({ value: valueStr, updatedAt: now })
              .where(and(eq(schema.pluginConfig.teamId, teamId), eq(schema.pluginConfig.key, key))).run();
          } else {
            db.insert(schema.pluginConfig).values({ teamId, key, value: valueStr, updatedAt: now }).run();
          }
        }
      }
      return { status: 200, data: { ok: true, keys: Object.keys(body) } };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to save config');
    }
  }

  // ---- /business (live passthrough, metadata is small + slow-changing) ----
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

  // ---- /locations (live passthrough, metadata is small + slow-changing) ----
  if (req.path === '/locations' && req.method === 'GET') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');
    try {
      const data = await fetchLocations(config);
      return { status: 200, data: { data, total: data.length } };
    } catch (error: any) {
      return apiError(502, 'YOT_ERROR', error?.message || String(error));
    }
  }

  // ---- /clients (cached list) ----
  if (req.path === '/clients' && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const { limit, offset } = parsePagination(req.query);
      const rows = db.select().from(schema.clients)
        .where(eq(schema.clients.teamId, teamId))
        .limit(limit).offset(offset).all();
      const totalRow = db.select({ c: sql<number>`count(*)` }).from(schema.clients)
        .where(eq(schema.clients.teamId, teamId)).all();
      const total = Number(totalRow[0]?.c || 0);
      return {
        status: 200,
        data: {
          data: rows.map((r: schema.Client) => ({
            id: r.id,
            firstName: r.firstName,
            lastName: r.lastName,
            email: r.email,
            phone: r.phone,
            tags: r.tags ? JSON.parse(r.tags) : [],
            lastVisitAt: r.lastVisitAt,
            totalVisits: r.totalVisits,
            totalSpend: r.totalSpend,
            syncedAt: r.syncedAt,
          })),
          total,
          limit,
          offset,
        },
      };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read clients');
    }
  }

  // ---- /clients/sync (pull from YOT into cache) ----
  if (req.path === '/clients/sync' && req.method === 'POST') {
    const config = readYotConfig(teamId);
    if (!config) return apiError(400, 'NOT_CONFIGURED', 'YOT apiKey not set for this team. POST /config first.');

    const startedAt = new Date().toISOString();
    try {
      // Page through until YOT returns an empty page. The list endpoint is
      // 1-indexed; in practice we cap at a high page number as a safety net.
      const MAX_PAGES = 200;
      const raw: any[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const chunk = await fetchClients(config, { page });
        if (!chunk.length) break;
        raw.push(...chunk);
      }
      const { db } = initializeDatabase(teamId);
      const now = new Date().toISOString();
      let upserts = 0;
      for (const item of raw) {
        // YOT list endpoint returns: id (numeric), privateId (uuid),
        // givenName, otherName, surname, initial, homePhone, mobilePhone,
        // businessPhone, emailAddress, birthday, gender, active, street,
        // suburb, state, postcode, country. Aggregated visit/spend data is
        // NOT in the list endpoint — must come from /client/{id} or exports.
        if (!item?.id && !item?.privateId) continue;
        const id = String(item.id ?? item.privateId);
        const addressParts = [item.street, item.suburb, item.state, item.postcode, item.country]
          .filter((p) => p != null && String(p).trim().length > 0);
        const values = {
          id,
          teamId,
          firstName: item.givenName ?? item.firstName ?? null,
          lastName: item.surname ?? item.lastName ?? null,
          email: item.emailAddress ?? item.email ?? null,
          phone: item.mobilePhone ?? item.homePhone ?? item.businessPhone ?? item.phone ?? null,
          address: addressParts.length ? JSON.stringify({
            street: item.street ?? null,
            suburb: item.suburb ?? null,
            state: item.state ?? null,
            postcode: item.postcode ?? null,
            country: item.country ?? null,
          }) : null,
          tags: null,
          lastVisitAt: null,
          totalVisits: null,
          totalSpend: null,
          raw: JSON.stringify(item),
          syncedAt: now,
        };
        try {
          db.insert(schema.clients).values(values).onConflictDoUpdate({
            target: schema.clients.id,
            set: { ...values, id: undefined as unknown as string },
          }).run();
        } catch {
          db.insert(schema.clients).values(values).run();
        }
        upserts++;
      }

      // Update sync_state
      db.run(sql`INSERT INTO sync_state (team_id, resource, last_synced_at, last_success_at, last_error, row_count)
                 VALUES (${teamId}, ${'clients'}, ${now}, ${now}, ${null}, ${upserts})
                 ON CONFLICT(team_id, resource) DO UPDATE SET
                   last_synced_at = ${now}, last_success_at = ${now}, last_error = ${null}, row_count = ${upserts}`);

      return { status: 200, data: { ok: true, synced: upserts, startedAt, completedAt: now } };
    } catch (error: any) {
      const errMsg = error?.message || String(error);
      const now = new Date().toISOString();
      try {
        const { db } = initializeDatabase(teamId);
        db.run(sql`INSERT INTO sync_state (team_id, resource, last_synced_at, last_error)
                   VALUES (${teamId}, ${'clients'}, ${now}, ${errMsg})
                   ON CONFLICT(team_id, resource) DO UPDATE SET
                     last_synced_at = ${now}, last_error = ${errMsg}`);
      } catch { /* ignore */ }
      return apiError(502, 'YOT_ERROR', errMsg);
    }
  }

  // ---- /sync-state (inspection) ----
  if (req.path === '/sync-state' && req.method === 'GET') {
    try {
      const { db } = initializeDatabase(teamId);
      const rows = db.select().from(schema.syncState).where(eq(schema.syncState.teamId, teamId)).all();
      return { status: 200, data: { state: rows } };
    } catch (error: any) {
      return apiError(500, 'DATABASE_ERROR', error?.message || 'Failed to read sync state');
    }
  }

  return apiError(404, 'NOT_FOUND', `No handler for ${req.method} ${req.path}`);
}
