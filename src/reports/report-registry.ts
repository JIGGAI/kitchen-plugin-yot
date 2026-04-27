import type { ReportDocumentFormat } from './client';
import {
  DAILY_REVENUE_SUMMARY_REPORT,
  type DailyRevenueSummaryParams,
  type DailyRevenueSummaryResult,
  buildDailyRevenueSummaryInstanceParams,
  buildDailyRevenueSummaryParameterDiscovery,
  parseDailyRevenueSummaryWorkbook,
} from './reports/daily-revenue-summary';

export type YotReportDefinition<TParams, TResult> = {
  key: string;
  reportName: string;
  reportType: string;
  preferredFormat: ReportDocumentFormat;
  buildParameterDiscovery(params: TParams, apiKey: string): Record<string, string>;
  buildInstanceParams(params: TParams): Record<string, string | number | null>;
  parseDocument(buffer: Buffer, parameters?: any[]): TResult;
};

export const reportRegistry = {
  dailyRevenueSummary: {
    key: DAILY_REVENUE_SUMMARY_REPORT.key,
    reportName: DAILY_REVENUE_SUMMARY_REPORT.reportName,
    reportType: DAILY_REVENUE_SUMMARY_REPORT.reportType,
    preferredFormat: DAILY_REVENUE_SUMMARY_REPORT.preferredFormat,
    buildParameterDiscovery: buildDailyRevenueSummaryParameterDiscovery,
    buildInstanceParams: buildDailyRevenueSummaryInstanceParams,
    parseDocument: parseDailyRevenueSummaryWorkbook,
  } satisfies YotReportDefinition<DailyRevenueSummaryParams, DailyRevenueSummaryResult>,
};

export type ReportRegistry = typeof reportRegistry;
