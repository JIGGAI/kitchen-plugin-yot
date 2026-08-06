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
  DAILY_SALES_SUMMARY_REPORT,
  type DailySalesSummaryParams,
  type DailySalesSummaryResult,
  buildDailySalesSummaryInstanceParams,
  buildDailySalesSummaryParameterDiscovery,
  parseDailySalesSummaryWorkbook,
} from './reports/daily-sales-summary';
import {
  DAILY_SALES_SUMMARY_TOTALS_REPORT,
  type DailySalesSummaryTotalsParams,
  type DailySalesSummaryTotalsResult,
  buildDailySalesSummaryTotalsInstanceParams,
  buildDailySalesSummaryTotalsParameterDiscovery,
  parseDailySalesSummaryTotalsWorkbook,
} from './reports/daily-sales-summary-totals';
import {
  MONTHLY_PERFORMANCE_SUMMARY_REPORT,
  type MonthlyPerformanceSummaryParams,
  type MonthlyPerformanceSummaryResult,
  buildMonthlyPerformanceSummaryInstanceParams,
  buildMonthlyPerformanceSummaryParameterDiscovery,
  parseMonthlyPerformanceSummaryWorkbook,
} from './reports/monthly-performance-summary';
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
import {
  STAFF_PERFORMANCE_REPORT,
  type StaffPerformanceParams,
  type StaffPerformanceResult,
  buildStaffPerformanceInstanceParams,
  buildStaffPerformanceParameterDiscovery,
  parseStaffPerformanceWorkbook,
} from './reports/staff-performance';
import {
  STAFF_TIMECARD_SUMMARY_REPORT,
  type StaffTimecardSummaryParams,
  type StaffTimecardSummaryResult,
  buildStaffTimecardSummaryInstanceParams,
  buildStaffTimecardSummaryParameterDiscovery,
  parseStaffTimecardSummaryWorkbook,
} from './reports/staff-timecard-summary';
import {
  STAFF_RETENTION_DAY_REPORT,
  type StaffRetentionDayParams,
  type StaffRetentionDayResult,
  buildStaffRetentionDayInstanceParams,
  buildStaffRetentionDayParameterDiscovery,
  parseStaffRetentionDayWorkbook,
} from './reports/staff-retention-day';
import {
  STAFF_WORK_SUMMARY_REPORT,
  type StaffWorkSummaryParams,
  type StaffWorkSummaryResult,
  buildStaffWorkSummaryInstanceParams,
  buildStaffWorkSummaryParameterDiscovery,
  parseStaffWorkSummaryWorkbook,
} from './reports/staff-work-summary';

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
  dailySalesSummary: {
    key: DAILY_SALES_SUMMARY_REPORT.key,
    reportName: DAILY_SALES_SUMMARY_REPORT.reportName,
    reportType: DAILY_SALES_SUMMARY_REPORT.reportType,
    preferredFormat: DAILY_SALES_SUMMARY_REPORT.preferredFormat,
    buildParameterDiscovery: buildDailySalesSummaryParameterDiscovery,
    buildInstanceParams: buildDailySalesSummaryInstanceParams,
    parseDocument: parseDailySalesSummaryWorkbook,
  } satisfies YotReportDefinition<DailySalesSummaryParams, DailySalesSummaryResult>,
  dailySalesSummaryTotals: {
    key: DAILY_SALES_SUMMARY_TOTALS_REPORT.key,
    reportName: DAILY_SALES_SUMMARY_TOTALS_REPORT.reportName,
    reportType: DAILY_SALES_SUMMARY_TOTALS_REPORT.reportType,
    preferredFormat: DAILY_SALES_SUMMARY_TOTALS_REPORT.preferredFormat,
    buildParameterDiscovery: buildDailySalesSummaryTotalsParameterDiscovery,
    buildInstanceParams: buildDailySalesSummaryTotalsInstanceParams,
    parseDocument: parseDailySalesSummaryTotalsWorkbook,
  } satisfies YotReportDefinition<DailySalesSummaryTotalsParams, DailySalesSummaryTotalsResult>,
  monthlyPerformanceSummary: {
    key: MONTHLY_PERFORMANCE_SUMMARY_REPORT.key,
    reportName: MONTHLY_PERFORMANCE_SUMMARY_REPORT.reportName,
    reportType: MONTHLY_PERFORMANCE_SUMMARY_REPORT.reportType,
    preferredFormat: MONTHLY_PERFORMANCE_SUMMARY_REPORT.preferredFormat,
    buildParameterDiscovery: buildMonthlyPerformanceSummaryParameterDiscovery,
    buildInstanceParams: buildMonthlyPerformanceSummaryInstanceParams,
    parseDocument: parseMonthlyPerformanceSummaryWorkbook,
  } satisfies YotReportDefinition<MonthlyPerformanceSummaryParams, MonthlyPerformanceSummaryResult>,
  staffPerformance: {
    key: STAFF_PERFORMANCE_REPORT.key,
    reportName: STAFF_PERFORMANCE_REPORT.reportName,
    reportType: STAFF_PERFORMANCE_REPORT.reportType,
    preferredFormat: STAFF_PERFORMANCE_REPORT.preferredFormat,
    buildParameterDiscovery: buildStaffPerformanceParameterDiscovery,
    buildInstanceParams: buildStaffPerformanceInstanceParams,
    parseDocument: parseStaffPerformanceWorkbook,
  } satisfies YotReportDefinition<StaffPerformanceParams, StaffPerformanceResult>,
  staffTimecardSummary: {
    key: STAFF_TIMECARD_SUMMARY_REPORT.key,
    reportName: STAFF_TIMECARD_SUMMARY_REPORT.reportName,
    reportType: STAFF_TIMECARD_SUMMARY_REPORT.reportType,
    preferredFormat: STAFF_TIMECARD_SUMMARY_REPORT.preferredFormat,
    buildParameterDiscovery: buildStaffTimecardSummaryParameterDiscovery,
    buildInstanceParams: buildStaffTimecardSummaryInstanceParams,
    parseDocument: parseStaffTimecardSummaryWorkbook,
  } satisfies YotReportDefinition<StaffTimecardSummaryParams, StaffTimecardSummaryResult>,
  staffRetentionDay: {
    key: STAFF_RETENTION_DAY_REPORT.key,
    reportName: STAFF_RETENTION_DAY_REPORT.reportName,
    reportType: STAFF_RETENTION_DAY_REPORT.reportType,
    preferredFormat: STAFF_RETENTION_DAY_REPORT.preferredFormat,
    buildParameterDiscovery: buildStaffRetentionDayParameterDiscovery,
    buildInstanceParams: buildStaffRetentionDayInstanceParams,
    parseDocument: parseStaffRetentionDayWorkbook,
  } satisfies YotReportDefinition<StaffRetentionDayParams, StaffRetentionDayResult>,
  staffWorkSummary: {
    key: STAFF_WORK_SUMMARY_REPORT.key,
    reportName: STAFF_WORK_SUMMARY_REPORT.reportName,
    reportType: STAFF_WORK_SUMMARY_REPORT.reportType,
    preferredFormat: STAFF_WORK_SUMMARY_REPORT.preferredFormat,
    buildParameterDiscovery: buildStaffWorkSummaryParameterDiscovery,
    buildInstanceParams: buildStaffWorkSummaryInstanceParams,
    parseDocument: parseStaffWorkSummaryWorkbook,
  } satisfies YotReportDefinition<StaffWorkSummaryParams, StaffWorkSummaryResult>,
};

export type ReportRegistry = typeof reportRegistry;
