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

function addDaysIso(dateOnly: string, n: number): string {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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
    const lastUpdatedAt = new Date().toISOString();
    const upsert = sqlite.prepare(`
      INSERT INTO staff_cashout_facts (
        team_id, date, location_name, staff_name, location_id, staff_id,
        service_revenue, product_revenue, tips, total_revenue,
        total_cash_received, bank_to_bank_amount, last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, date, location_name, staff_name) DO UPDATE SET
        location_id = excluded.location_id,
        staff_id = excluded.staff_id,
        service_revenue = excluded.service_revenue,
        product_revenue = excluded.product_revenue,
        tips = excluded.tips,
        total_revenue = excluded.total_revenue,
        total_cash_received = excluded.total_cash_received,
        bank_to_bank_amount = excluded.bank_to_bank_amount,
        last_updated_at = excluded.last_updated_at
    `);
    const deleteDay = sqlite.prepare(
      `DELETE FROM staff_cashout_facts WHERE team_id = ? AND date = ?`,
    );

    // The Staff Cashout report aggregates by date range and emits no per-row
    // date column — every parsed row gets `date: null`. If we called the
    // report once for a multi-day range and stamped each row with `startDate`
    // (the previous behavior), all 5+ days of data would land on one date.
    // Loop per day so each call's report = exactly that one date's data,
    // which lets us stamp the correct date on each row.
    let rowsSeen = 0;
    let rowsWritten = 0;
    let lastParsed: StaffCashoutResult = { sheetName: null, headerRow: [], parameters: [], rows: [] };
    let cursor = startDate;
    while (cursor <= endDate) {
      const dayParams = {
        startDateIso: `${cursor}T00:00:00`,
        endDateIso: `${cursor}T00:00:00`,
        organisationId: options.organisationId,
        locationId: options.locationId ?? null,
        staffId: options.staffId ?? null,
      };
      const parameterDefinitions = await client.getParameters(
        reportRegistry.staffCashout.reportType,
        reportRegistry.staffCashout.buildParameterDiscovery(dayParams, config.apiKey),
      );
      const instanceId = await client.createInstance(
        reportRegistry.staffCashout.reportType,
        reportRegistry.staffCashout.buildInstanceParams(dayParams),
      );
      const document = await client.createDocument(instanceId, reportRegistry.staffCashout.preferredFormat);
      await client.waitForDocument(instanceId, document.documentId);
      const file = await client.fetchDocument(instanceId, document.documentId);
      const parsed = reportRegistry.staffCashout.parseDocument(file.buffer, parameterDefinitions);
      lastParsed = parsed;
      rowsSeen += parsed.rows.length;

      const cursorDay = cursor;
      const writeDay = sqlite.transaction((rows: StaffCashoutResult['rows']) => {
        // Wipe the day's existing rows first so YOT-side deletions reflect.
        deleteDay.run(options.teamId, cursorDay);
        for (const row of rows) {
          if (!row.staffName) continue;
          upsert.run(
            options.teamId,
            cursorDay,
            row.locationName || 'Unknown location',
            row.staffName,
            null,
            null,
            row.serviceRevenue,
            row.productRevenue,
            row.tips,
            row.totalRevenue,
            row.totalCashReceived,
            row.bankToBankAmount,
            lastUpdatedAt,
          );
          rowsWritten += 1;
        }
      });
      writeDay(parsed.rows);
      cursor = addDaysIso(cursor, 1);
    }

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
    `).run(new Date().toISOString(), rowsSeen, rowsWritten, runId);

    return { startDate, endDate, rowsSeen, rowsWritten, parsed: lastParsed };
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
  totalCashReceived: number | null;
  bankToBankAmount: number | null;
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
           tips, total_revenue AS totalRevenue,
           total_cash_received AS totalCashReceived,
           bank_to_bank_amount AS bankToBankAmount,
           last_updated_at AS lastUpdatedAt
    FROM staff_cashout_facts
    WHERE ${conditions.join(' AND ')}
    ORDER BY date DESC, location_name ASC, bank_to_bank_amount DESC, total_revenue DESC
  `;
  return sqlite.prepare(sql).all(...params) as StaffCashoutCacheRow[];
}
