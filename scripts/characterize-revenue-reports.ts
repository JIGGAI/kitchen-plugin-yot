import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReportClient } from '../src/reports/client';
import { reportRegistry } from '../src/reports/report-registry';
import type { YotConfig } from '../src/types';

const DB_PATH = '/Users/hairmx/.openclaw/kitchen/plugins/yot/yot-hmx-marketing-team.db';
const TEAM_ID = 'hmx-marketing-team';
const WINDOW_START = '2026-04-26T00:00:00.000Z';
const WINDOW_END = '2026-05-02T00:00:00.000Z';
const ORGANISATION_ID = 11082;

type ProbeSummary = {
  generatedAt: string;
  dbPath: string;
  teamId: string;
  reportKey: string;
  reportName: string;
  reportType: string;
  preferredFormat: string;
  parameterDefinitions: Array<{
    name: string;
    type: string;
    isVisible: boolean;
    value: unknown;
  }>;
  instanceId: string | null;
  documentId: string | null;
  workbookPath: string | null;
  workbookBytes: number | null;
  sheetName: string | null;
  headerRow: string[];
  locationCount: number;
  detailRowCount: number;
  averageRowCount: number;
  totalRowCount: number;
  sampleRows: unknown[];
  totalsByLocation: unknown[];
  requestLog: ReturnType<typeof createReportClient>['requestLog'];
  fatalError?: string;
};

function readConfig(): YotConfig {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const row = db
      .prepare("SELECT value FROM plugin_config WHERE team_id = ? AND key = 'yot'")
      .get(TEAM_ID) as { value?: string } | undefined;
    if (!row?.value) throw new Error(`No YOT config found for team ${TEAM_ID}`);
    const parsed = JSON.parse(row.value) as YotConfig;
    if (!parsed?.apiKey) throw new Error(`Invalid YOT config payload for team ${TEAM_ID}`);
    return parsed;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const summary: ProbeSummary = {
    generatedAt: new Date().toISOString(),
    dbPath: DB_PATH,
    teamId: TEAM_ID,
    reportKey: reportRegistry.dailyRevenueSummary.key,
    reportName: reportRegistry.dailyRevenueSummary.reportName,
    reportType: reportRegistry.dailyRevenueSummary.reportType,
    preferredFormat: reportRegistry.dailyRevenueSummary.preferredFormat,
    parameterDefinitions: [],
    instanceId: null,
    documentId: null,
    workbookPath: null,
    workbookBytes: null,
    sheetName: null,
    headerRow: [],
    locationCount: 0,
    detailRowCount: 0,
    averageRowCount: 0,
    totalRowCount: 0,
    sampleRows: [],
    totalsByLocation: [],
    requestLog: [],
  };

  try {
    const config = readConfig();
    const client = createReportClient(config);
    const params = {
      startDateIso: WINDOW_START,
      endDateIso: WINDOW_END,
      organisationId: ORGANISATION_ID,
      locationId: null,
      staffId: null,
      dayOfWeek: null,
    };

    const parameterDefinitions = await client.getParameters(
      reportRegistry.dailyRevenueSummary.reportType,
      reportRegistry.dailyRevenueSummary.buildParameterDiscovery(params, config.apiKey),
    );
    summary.parameterDefinitions = parameterDefinitions.map((row) => ({
      name: row.name,
      type: row.type,
      isVisible: row.isVisible,
      value: row.value,
    }));

    const instanceId = await client.createInstance(
      reportRegistry.dailyRevenueSummary.reportType,
      reportRegistry.dailyRevenueSummary.buildInstanceParams(params),
    );
    summary.instanceId = instanceId;

    const document = await client.createDocument(instanceId, reportRegistry.dailyRevenueSummary.preferredFormat);
    summary.documentId = document.documentId;

    await client.waitForDocument(instanceId, document.documentId);
    const file = await client.fetchDocument(instanceId, document.documentId);

    const workbookPath = join(tmpdir(), `daily-revenue-summary-${instanceId}.xlsx`);
    writeFileSync(workbookPath, file.buffer);
    summary.workbookPath = workbookPath;
    summary.workbookBytes = file.buffer.byteLength;

    const parsed = reportRegistry.dailyRevenueSummary.parseDocument(file.buffer, parameterDefinitions);
    summary.sheetName = parsed.sheetName;
    summary.headerRow = parsed.headerRow;
    summary.locationCount = parsed.locations.length;
    summary.detailRowCount = parsed.rows.filter((row) => row.rowKind === 'detail').length;
    summary.averageRowCount = parsed.rows.filter((row) => row.rowKind === 'average').length;
    summary.totalRowCount = parsed.rows.filter((row) => row.rowKind === 'total').length;
    summary.sampleRows = parsed.rows.slice(0, 10);
    summary.totalsByLocation = parsed.rows.filter((row) => row.rowKind === 'total').slice(0, 25);
    summary.requestLog = client.requestLog;
  } catch (error) {
    summary.fatalError = error instanceof Error ? error.message : String(error);
  }

  process.stdout.write(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  const fatal = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ fatalError: fatal }, null, 2));
  process.exitCode = 1;
});
