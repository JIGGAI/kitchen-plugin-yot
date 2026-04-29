import { initializeDatabase } from '../db';
import type { YotConfig } from '../types';
import { createReportClient } from './client';
import { reportRegistry } from './report-registry';
import type { StaffCashoutResult } from './reports/staff-cashout';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

export type RunStaffCashoutOptions = {
  teamId: string;
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
  includeDebugRows?: boolean;
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

export async function runStaffCashoutReport(options: RunStaffCashoutOptions): Promise<StaffCashoutResult> {
  const { sqlite } = initializeDatabase(options.teamId);
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
  return reportRegistry.staffCashout.parseDocument(file.buffer, parameterDefinitions, { includeDebugRows: options.includeDebugRows });
}
