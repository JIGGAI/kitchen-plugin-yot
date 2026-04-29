import { randomUUID } from 'crypto';
import { initializeDatabase } from '../db';
import type { YotConfig } from '../types';
import { createReportClient } from './client';
import { reportRegistry } from './report-registry';
import type { StaffCashoutResult } from './reports/staff-cashout';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

export type SyncStaffCashoutOptions = {
  teamId: string;
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
};

export type SyncStaffCashoutResult = {
  startDate: string;
  endDate: string;
  rowsSeen: number;
  rowsWritten: number;
  parsed: StaffCashoutResult;
};

function readConfig(sqlite: SqliteDb, teamId: string): YotConfig {
  const row = sqlite
    .prepare("SELECT value FROM plugin_config WHERE team_id = ? AND key = 'yot'")
    .get(teamId) as { value?: string } | undefined;
  if (!row?.value) throw new Error(`No YOT config found for team ${teamId}`);
  const parsed = JSON.parse(row.value) as YotConfig;
  if (!parsed?.apiKey) throw new Error(`Invalid YOT config payload for team ${teamId}`);
  return parsed;
}

function isoDateOnly(value: string): string {
  return String(value || '').slice(0, 10);
}

export async function syncStaffCashoutFromReport(options: SyncStaffCashoutOptions): Promise<SyncStaffCashoutResult> {
  const { sqlite } = initializeDatabase(options.teamId);
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const startDate = isoDateOnly(options.startDateIso);
  const endDate = isoDateOnly(options.endDateIso);

  sqlite.prepare(`
    INSERT INTO sync_runs (id, team_id, resource, status, started_at, notes)
    VALUES (?, ?, 'staff_cashout_facts', 'running', ?, ?)
  `).run(runId, options.teamId, startedAt, `start=${startDate}; end=${endDate}`);

  try {
    const config = readConfig(sqlite, options.teamId);
    const client = createReportClient(config);
    const params = {
      startDateIso: options.startDateIso,
      endDateIso: options.endDateIso,
      organisationId: options.organisationId,
      locationId: options.locationId ?? null,
      staffId: options.staffId ?? null,
    };

    const parameterDefinitions = await client.getParameters(
      reportRegistry.staffCashout.reportType,
      reportRegistry.staffCashout.buildParameterDiscovery(params, config.apiKey),
    );
    const instanceId = await client.createInstance(
      reportRegistry.staffCashout.reportType,
      reportRegistry.staffCashout.buildInstanceParams(params),
    );
    const document = await client.createDocument(instanceId, reportRegistry.staffCashout.preferredFormat);
    await client.waitForDocument(instanceId, document.documentId);
    const file = await client.fetchDocument(instanceId, document.documentId);
    const parsed = reportRegistry.staffCashout.parseDocument(file.buffer, parameterDefinitions);

    const lastUpdatedAt = new Date().toISOString();
    const upsert = sqlite.prepare(`
      INSERT INTO staff_cashout_facts (
        team_id, date, location_name, staff_name, location_id, staff_id,
        service_revenue, product_revenue, tips, total_revenue, last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, date, location_name, staff_name) DO UPDATE SET
        location_id = excluded.location_id,
        staff_id = excluded.staff_id,
        service_revenue = excluded.service_revenue,
        product_revenue = excluded.product_revenue,
        tips = excluded.tips,
        total_revenue = excluded.total_revenue,
        last_updated_at = excluded.last_updated_at
    `);

    let rowsWritten = 0;
    const writeAll = sqlite.transaction((rows: StaffCashoutResult['rows']) => {
      // Wipe existing rows for this date range so deletions on YOT side are reflected.
      sqlite.prepare(`DELETE FROM staff_cashout_facts WHERE team_id = ? AND date BETWEEN ? AND ?`)
        .run(options.teamId, startDate, endDate);
      for (const row of rows) {
        if (!row.staffName) continue;
        const date = row.date || startDate;
        upsert.run(
          options.teamId,
          date,
          row.locationName || 'Unknown location',
          row.staffName,
          null,
          null,
          row.serviceRevenue,
          row.productRevenue,
          row.tips,
          row.totalRevenue,
          lastUpdatedAt,
        );
        rowsWritten += 1;
      }
    });
    writeAll(parsed.rows);

    sqlite.prepare(`
      INSERT INTO sync_state (team_id, resource, last_synced_at, last_success_at, row_count, last_error)
      VALUES (?, 'staff_cashout_facts', ?, ?, ?, NULL)
      ON CONFLICT(team_id, resource) DO UPDATE SET
        last_synced_at = excluded.last_synced_at,
        last_success_at = excluded.last_success_at,
        row_count = excluded.row_count,
        last_error = NULL
    `).run(options.teamId, lastUpdatedAt, lastUpdatedAt, rowsWritten);

    sqlite.prepare(`
      UPDATE sync_runs
      SET status = 'success', completed_at = ?, rows_seen = ?, rows_written = ?
      WHERE id = ?
    `).run(new Date().toISOString(), parsed.rows.length, rowsWritten, runId);

    return { startDate, endDate, rowsSeen: parsed.rows.length, rowsWritten, parsed };
  } catch (error: any) {
    sqlite.prepare(`
      INSERT INTO sync_state (team_id, resource, last_synced_at, last_error)
      VALUES (?, 'staff_cashout_facts', ?, ?)
      ON CONFLICT(team_id, resource) DO UPDATE SET
        last_synced_at = excluded.last_synced_at,
        last_error = excluded.last_error
    `).run(options.teamId, new Date().toISOString(), String(error?.message || error));
    sqlite.prepare(`
      UPDATE sync_runs
      SET status = 'error', completed_at = ?, error = ?
      WHERE id = ?
    `).run(new Date().toISOString(), String(error?.message || error), runId);
    throw error;
  }
}

export type StaffCashoutCacheRow = {
  date: string;
  locationName: string;
  staffName: string;
  serviceRevenue: number | null;
  productRevenue: number | null;
  tips: number | null;
  totalRevenue: number | null;
  lastUpdatedAt: string;
};

export function listStaffCashoutFacts(
  sqlite: SqliteDb,
  teamId: string,
  filters: { startDate?: string | null; endDate?: string | null; locationName?: string | null } = {},
): StaffCashoutCacheRow[] {
  const startDate = filters.startDate ? isoDateOnly(filters.startDate) : null;
  const endDate = filters.endDate ? isoDateOnly(filters.endDate) : null;
  const conditions: string[] = ['team_id = ?'];
  const params: Array<string> = [teamId];
  if (startDate) { conditions.push('date >= ?'); params.push(startDate); }
  if (endDate) { conditions.push('date <= ?'); params.push(endDate); }
  if (filters.locationName) { conditions.push('location_name = ?'); params.push(filters.locationName); }
  const sql = `
    SELECT date, location_name AS locationName, staff_name AS staffName,
           service_revenue AS serviceRevenue, product_revenue AS productRevenue,
           tips, total_revenue AS totalRevenue, last_updated_at AS lastUpdatedAt
    FROM staff_cashout_facts
    WHERE ${conditions.join(' AND ')}
    ORDER BY date DESC, location_name ASC, total_revenue DESC
  `;
  return sqlite.prepare(sql).all(...params) as StaffCashoutCacheRow[];
}
