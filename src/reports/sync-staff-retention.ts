// Sync the StaffRetentionDay Telerik report for a (team, window) into
// staff_retention_facts. Unlike per-day reports, this one is window-scoped:
// each (period_start, period_end, location, staff) is one row capturing the
// aggregated counts/percentages for the window. Re-syncing the same window
// upserts.

import { createHash } from 'node:crypto';
import { initializeDatabase } from '../db';
import type { YotConfig } from '../types';
import { createReportClient } from './client';
import {
  STAFF_RETENTION_DAY_REPORT,
  buildStaffRetentionDayParameterDiscovery,
  buildStaffRetentionDayInstanceParams,
  parseStaffRetentionDayWorkbook,
  type StaffRetentionRow,
  type RetentionMetric,
} from './reports/staff-retention-day';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

export type SyncStaffRetentionOptions = {
  teamId: string;
  startDate: string;    // YYYY-MM-DD
  endDate: string;      // YYYY-MM-DD
  organisationId: number;
  locationId?: number | null;
  franchiseId?: number | null;
};

export type SyncStaffRetentionResult = {
  ok: boolean;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  startDate: string;
  endDate: string;
  trailingMonthLabels: { m1: string | null; m2: string | null; m3: string | null };
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

function factId(
  teamId: string,
  periodStart: string,
  periodEnd: string,
  locationName: string,
  staffName: string,
): string {
  return createHash('sha1')
    .update(`${teamId}::${periodStart}::${periodEnd}::${locationName}::${staffName}`)
    .digest('hex')
    .slice(0, 32);
}

function metric(m: RetentionMetric | null) {
  return { count: m?.count ?? null, pct: m?.pct ?? null };
}

export async function syncStaffRetention(
  options: SyncStaffRetentionOptions,
): Promise<SyncStaffRetentionResult> {
  const { teamId, startDate, endDate, organisationId } = options;

  const { sqlite } = initializeDatabase(teamId);
  const config = readConfig(sqlite, teamId);

  // Fetch the full window in one shot. The report is per-window aggregate, not
  // per-day, so chunking would produce inconsistent results (each chunk would
  // have its own "previous N months retention" attached). Telerik's render
  // ceiling is the only concern; in practice this report renders in <30s for
  // a week-long full-org pull.
  const client = createReportClient(config);
  const params = {
    startDateIso: `${startDate}T00:00:00`,
    endDateIso: `${endDate}T23:59:59`,
    organisationId,
    locationId: options.locationId ?? null,
    franchiseId: options.franchiseId ?? null,
  };

  console.log(`[sync-staff-retention] ${startDate} → ${endDate}`);
  await client.getParameters(
    STAFF_RETENTION_DAY_REPORT.reportType,
    buildStaffRetentionDayParameterDiscovery(params, config.apiKey),
  );
  const instanceId = await client.createInstance(
    STAFF_RETENTION_DAY_REPORT.reportType,
    buildStaffRetentionDayInstanceParams(params),
  );
  const document = await client.createDocument(instanceId, STAFF_RETENTION_DAY_REPORT.preferredFormat);
  await client.waitForDocument(instanceId, document.documentId);
  const file = await client.fetchDocument(instanceId, document.documentId);

  const parsed = parseStaffRetentionDayWorkbook(file.buffer);
  console.log(`[sync-staff-retention]   → ${parsed.rows.length} rows / ${parsed.locations.length} locations`);

  const { m1, m2, m3 } = parsed.trailingMonthLabels;

  const upsert = sqlite.prepare(`
    INSERT INTO staff_retention_facts (
      id, team_id, period_start, period_end, location_name, staff_name,
      total_sales,
      returned_to_staff_count, returned_to_staff_pct,
      returned_to_business_count, returned_to_business_pct,
      new_clients_count, new_clients_pct,
      total_rebooked_count, total_rebooked_pct,
      new_clients_rebooked_count, new_clients_rebooked_pct,
      retention_m1_count, retention_m1_pct, retention_m1_label,
      retention_m2_count, retention_m2_pct, retention_m2_label,
      retention_m3_count, retention_m3_pct, retention_m3_label,
      synced_at
    ) VALUES (
      @id, @team_id, @period_start, @period_end, @location_name, @staff_name,
      @total_sales,
      @rts_count, @rts_pct,
      @rtb_count, @rtb_pct,
      @nc_count, @nc_pct,
      @tr_count, @tr_pct,
      @ncr_count, @ncr_pct,
      @m1_count, @m1_pct, @m1_label,
      @m2_count, @m2_pct, @m2_label,
      @m3_count, @m3_pct, @m3_label,
      @synced_at
    )
    ON CONFLICT(team_id, period_start, period_end, location_name, staff_name) DO UPDATE SET
      total_sales = excluded.total_sales,
      returned_to_staff_count = excluded.returned_to_staff_count,
      returned_to_staff_pct = excluded.returned_to_staff_pct,
      returned_to_business_count = excluded.returned_to_business_count,
      returned_to_business_pct = excluded.returned_to_business_pct,
      new_clients_count = excluded.new_clients_count,
      new_clients_pct = excluded.new_clients_pct,
      total_rebooked_count = excluded.total_rebooked_count,
      total_rebooked_pct = excluded.total_rebooked_pct,
      new_clients_rebooked_count = excluded.new_clients_rebooked_count,
      new_clients_rebooked_pct = excluded.new_clients_rebooked_pct,
      retention_m1_count = excluded.retention_m1_count,
      retention_m1_pct = excluded.retention_m1_pct,
      retention_m1_label = excluded.retention_m1_label,
      retention_m2_count = excluded.retention_m2_count,
      retention_m2_pct = excluded.retention_m2_pct,
      retention_m2_label = excluded.retention_m2_label,
      retention_m3_count = excluded.retention_m3_count,
      retention_m3_pct = excluded.retention_m3_pct,
      retention_m3_label = excluded.retention_m3_label,
      synced_at = excluded.synced_at
  `);
  const checkExists = sqlite.prepare(
    `SELECT 1 FROM staff_retention_facts
     WHERE team_id = ? AND period_start = ? AND period_end = ? AND location_name = ? AND staff_name = ?`,
  );
  const syncedAt = new Date().toISOString();
  let rowsInserted = 0;
  let rowsUpdated = 0;
  let rowsSkipped = 0;

  const tx = sqlite.transaction((rows: StaffRetentionRow[]) => {
    for (const row of rows) {
      if (!row.staffName || !row.locationName) {
        rowsSkipped += 1;
        continue;
      }
      const id = factId(teamId, startDate, endDate, row.locationName, row.staffName);
      const exists = checkExists.get(teamId, startDate, endDate, row.locationName, row.staffName) != null;
      const rts = metric(row.returnedToStaff);
      const rtb = metric(row.returnedToBusiness);
      const nc = metric(row.newClients);
      const tr = metric(row.totalRebooked);
      const ncr = metric(row.newClientsRebooked);
      const r1 = metric(row.retention1MonthBack);
      const r2 = metric(row.retention2MonthsBack);
      const r3 = metric(row.retention3MonthsBack);
      upsert.run({
        id,
        team_id: teamId,
        period_start: startDate,
        period_end: endDate,
        location_name: row.locationName,
        staff_name: row.staffName,
        total_sales: row.totalSales || 0,
        rts_count: rts.count, rts_pct: rts.pct,
        rtb_count: rtb.count, rtb_pct: rtb.pct,
        nc_count: nc.count, nc_pct: nc.pct,
        tr_count: tr.count, tr_pct: tr.pct,
        ncr_count: ncr.count, ncr_pct: ncr.pct,
        m1_count: r1.count, m1_pct: r1.pct, m1_label: m1,
        m2_count: r2.count, m2_pct: r2.pct, m2_label: m2,
        m3_count: r3.count, m3_pct: r3.pct, m3_label: m3,
        synced_at: syncedAt,
      });
      if (exists) rowsUpdated += 1;
      else rowsInserted += 1;
    }
  });
  tx(parsed.rows);

  console.log(`[sync-staff-retention] done: inserted=${rowsInserted} updated=${rowsUpdated} skipped=${rowsSkipped}`);
  return {
    ok: true,
    rowsInserted,
    rowsUpdated,
    rowsSkipped,
    startDate,
    endDate,
    trailingMonthLabels: parsed.trailingMonthLabels,
  };
}
