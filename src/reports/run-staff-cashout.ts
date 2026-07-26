import { initializeDatabase } from '../db';
import type { YotConfig } from '../types';
import { createReportClient } from './client';
import type { ReportDocumentFormat } from './client';
import { reportRegistry } from './report-registry';
import type { StaffCashoutResult } from './reports/staff-cashout';
import { parseStaffCashoutCsv } from './reports/staff-cashout-csv';
import { isXlsxRenderingUnavailable } from './render-fallback';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

export type RunStaffCashoutOptions = {
  teamId: string;
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
  staffId?: number | null;
  includeDebugRows?: boolean;
  /**
   * Fall back to the CSV renderer when YOT's XLSX extension is unavailable.
   * Only safe for callers that read staffName / locationName /
   * bankToBankAmount — the CSV parser leaves the revenue columns null.
   */
  allowCsvFallback?: boolean;
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
  async function render(format: ReportDocumentFormat) {
    const document = await client.createDocument(instanceId, format);
    await client.waitForDocument(instanceId, document.documentId);
    return client.fetchDocument(instanceId, document.documentId);
  }

  try {
    const file = await render(reportRegistry.staffCashout.preferredFormat);
    return reportRegistry.staffCashout.parseDocument(file.buffer, parameterDefinitions, {
      includeDebugRows: options.includeDebugRows,
    });
  } catch (error) {
    // Opt-in only. The CSV parser populates staffName / locationName /
    // bankToBankAmount — everything the disbursement export reads — but leaves
    // the revenue columns null, so callers that surface the full row shape
    // (e.g. the /staff-cashout API) must keep failing loudly instead.
    if (!options.allowCsvFallback || !isXlsxRenderingUnavailable(error)) throw error;

    console.error(
      '[staff-cashout] XLSX rendering unavailable upstream — falling back to the CSV renderer. ' +
        'Rows are reconciled against the report\'s own bank-to-bank total before use.',
    );
    const file = await render('CSV');
    // Throws unless the extracted rows reconcile against the report's own
    // stated bank-to-bank total.
    const result = parseStaffCashoutCsv(file.buffer);
    console.error(
      `[staff-cashout] CSV fallback reconciled: ${result.rows.length} staff rows totalling ` +
        `${result.bankToBankTotal.toFixed(2)} bank-to-bank.`,
    );
    return result;
  }
}
