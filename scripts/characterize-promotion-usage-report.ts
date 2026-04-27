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
const WINDOW_END = '2026-04-26T00:00:00.000Z';
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
  rowCount: number;
  sampleRows: unknown[];
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
    reportKey: reportRegistry.promotionUsage.key,
    reportName: reportRegistry.promotionUsage.reportName,
    reportType: reportRegistry.promotionUsage.reportType,
    preferredFormat: reportRegistry.promotionUsage.preferredFormat,
    parameterDefinitions: [],
    instanceId: null,
    documentId: null,
    workbookPath: null,
    workbookBytes: null,
    sheetName: null,
    headerRow: [],
    rowCount: 0,
    sampleRows: [],
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
    };

    const parameterDefinitions = await client.getParameters(
      reportRegistry.promotionUsage.reportType,
      reportRegistry.promotionUsage.buildParameterDiscovery(params, config.apiKey),
    );
    summary.parameterDefinitions = parameterDefinitions.map((row) => ({
      name: row.name,
      type: row.type,
      isVisible: row.isVisible,
      value: row.value,
    }));

    const instanceId = await client.createInstance(
      reportRegistry.promotionUsage.reportType,
      reportRegistry.promotionUsage.buildInstanceParams(params),
    );
    summary.instanceId = instanceId;

    const document = await client.createDocument(instanceId, reportRegistry.promotionUsage.preferredFormat);
    summary.documentId = document.documentId;

    await client.waitForDocument(instanceId, document.documentId);
    const file = await client.fetchDocument(instanceId, document.documentId);

    const workbookPath = join(tmpdir(), `promotion-usage-${instanceId}.xlsx`);
    writeFileSync(workbookPath, file.buffer);
    summary.workbookPath = workbookPath;
    summary.workbookBytes = file.buffer.byteLength;

    const parsed = reportRegistry.promotionUsage.parseDocument(file.buffer, parameterDefinitions);
    summary.sheetName = parsed.sheetName;
    summary.headerRow = parsed.headerRow;
    summary.rowCount = parsed.rows.length;
    summary.sampleRows = parsed.rows.slice(0, 20);
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
