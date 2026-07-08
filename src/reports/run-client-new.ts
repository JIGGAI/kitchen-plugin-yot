import { initializeDatabase } from '../db';
import type { YotConfig } from '../types';
import { createReportClient } from './client';
import {
  CLIENT_NEW_REPORT,
  buildClientNewParameterDiscovery,
  buildClientNewInstanceParams,
  parseClientNewCsv,
  aggregateReferralSources,
  type ClientNewRow,
  type ClientNewReferralAggregate,
} from './reports/client-new';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

export type RunClientNewOptions = {
  teamId: string;
  startDateIso: string;   // 'YYYY-MM-DDT00:00:00'
  endDateIso: string;     // 'YYYY-MM-DDT00:00:00'
  organisationId: number;
  locationId?: number | null;
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

export async function runClientNewReport(options: RunClientNewOptions): Promise<ClientNewRow[]> {
  const { sqlite } = initializeDatabase(options.teamId);
  const config = readConfig(sqlite, options.teamId);
  const client = createReportClient(config);
  const params = {
    startDateIso: options.startDateIso,
    endDateIso: options.endDateIso,
    organisationId: options.organisationId,
    locationId: options.locationId ?? null,
  };
  await client.getParameters(
    CLIENT_NEW_REPORT.reportType,
    buildClientNewParameterDiscovery(params, config.apiKey),
  );
  const instanceId = await client.createInstance(
    CLIENT_NEW_REPORT.reportType,
    buildClientNewInstanceParams(params),
  );
  const document = await client.createDocument(instanceId, CLIENT_NEW_REPORT.preferredFormat);
  await client.waitForDocument(instanceId, document.documentId);
  const file = await client.fetchDocument(instanceId, document.documentId);
  return parseClientNewCsv(file.buffer);
}

// Convenience: run + aggregate referral sources for a range.
export async function runClientNewReferralAggregate(
  options: RunClientNewOptions,
): Promise<ClientNewReferralAggregate & { rows: number }> {
  const rows = await runClientNewReport(options);
  const agg = aggregateReferralSources(rows);
  return { ...agg, rows: rows.length };
}
