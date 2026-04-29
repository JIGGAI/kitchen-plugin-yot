import type { ReportDocumentFormat } from './client';
import {
  DAILY_REVENUE_SUMMARY_REPORT,
  type DailyRevenueSummaryParams,
  type DailyRevenueSummaryResult,
  buildDailyRevenueSummaryInstanceParams,
  buildDailyRevenueSummaryParameterDiscovery,
  parseDailyRevenueSummaryWorkbook,
} from './reports/daily-revenue-summary';
import {
  PROMOTION_USAGE_REPORT,
  type PromotionUsageParams,
  type PromotionUsageResult,
  buildPromotionUsageInstanceParams,
  buildPromotionUsageParameterDiscovery,
  parsePromotionUsageWorkbook,
} from './reports/promotion-usage';
import {
  STAFF_CASHOUT_REPORT,
  type StaffCashoutParams,
  type StaffCashoutResult,
  buildStaffCashoutInstanceParams,
  buildStaffCashoutParameterDiscovery,
  parseStaffCashoutWorkbook,
} from './reports/staff-cashout';

export type YotReportDefinition<TParams, TResult> = {
  key: string;
  reportName: string;
  reportType: string;
  preferredFormat: ReportDocumentFormat;
  buildParameterDiscovery(params: TParams, apiKey: string): Record<string, string>;
  buildInstanceParams(params: TParams): Record<string, string | number | null>;
  parseDocument(buffer: Buffer, parameters?: any[], options?: Record<string, unknown>): TResult;
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
  promotionUsage: {
    key: PROMOTION_USAGE_REPORT.key,
    reportName: PROMOTION_USAGE_REPORT.reportName,
    reportType: PROMOTION_USAGE_REPORT.reportType,
    preferredFormat: PROMOTION_USAGE_REPORT.preferredFormat,
    buildParameterDiscovery: buildPromotionUsageParameterDiscovery,
    buildInstanceParams: buildPromotionUsageInstanceParams,
    parseDocument: parsePromotionUsageWorkbook,
  } satisfies YotReportDefinition<PromotionUsageParams, PromotionUsageResult>,
  staffCashout: {
    key: STAFF_CASHOUT_REPORT.key,
    reportName: STAFF_CASHOUT_REPORT.reportName,
    reportType: STAFF_CASHOUT_REPORT.reportType,
    preferredFormat: STAFF_CASHOUT_REPORT.preferredFormat,
    buildParameterDiscovery: buildStaffCashoutParameterDiscovery,
    buildInstanceParams: buildStaffCashoutInstanceParams,
    parseDocument: parseStaffCashoutWorkbook,
  } satisfies YotReportDefinition<StaffCashoutParams, StaffCashoutResult>,
};

export type ReportRegistry = typeof reportRegistry;
