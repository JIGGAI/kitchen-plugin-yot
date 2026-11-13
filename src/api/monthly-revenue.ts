// Monthly Revenue Summary: YOT's DailySalesSummaryTotals report kept one row
// per (location, calendar month) in monthly_revenue_summary_facts.
//
// The report is slow (about a minute per month for every shop), so the
// dashboard never runs it on demand: POST /monthly-revenue/sync fetches a
// month and replaces its rows, GET /monthly-revenue reads any span of months.
//
// What the report does and does not carry. It prints cash, credit card,
// voucher and other sales, total sales, credit card and other tips, number
// of sales, services per sale, average sale value, commission total and net,
// gross income and % cost of sale. Two figures the summary shows are derived
// here:
//   - Total credit cards = credit card sales + credit card tips (what the
//     card processor actually settles).
//   - Sales per hour = number of sales ÷ hours worked. Hours are not in this
//     report; they come from staff_performance_facts for the same shop and
//     month, and the figure is null where no hours were recorded (that table
//     starts 2026-01-02).
//
// Checked against the report: commission net + gross income = total sales,
// and % cost of sale = commission net ÷ total sales. combineRevenueRows uses
// those identities to roll rows up without averaging ratios.

import type { DailySalesSummaryTotalsRow } from '../reports/reports/daily-sales-summary-totals';
import { parseHoursWorkedToMinutes } from '../reports/reports/staff-performance';

// The connection initializeDatabase hands out (better-sqlite3 or the
// node:sqlite shim behind the same surface); untyped there, so untyped here.
type SqliteDb = any;

export type MonthlyRevenueFigures = {
  cashSales: number | null;
  creditCardSales: number | null;
  voucherSales: number | null;
  otherSales: number | null;
  totalSales: number | null;
  creditCardTips: number | null;
  otherTips: number | null;
  numberOfSales: number | null;
  servicesPerSale: number | null;
  avgSaleValue: number | null;
  commissionTotal: number | null;
  commissionNet: number | null;
  grossIncome: number | null;
  pctCostOfSale: number | null;
};

export type MonthlyRevenueRow = MonthlyRevenueFigures & {
  locationId: string | null;
  locationName: string;
  yearMonth: string;
  /** Credit card sales + credit card tips. */
  totalCreditCards: number | null;
  /** Minutes worked at the shop that month; null when none were recorded. */
  hoursWorkedMinutes: number | null;
  /** Number of sales ÷ hours worked; null without hours. */
  salesPerHour: number | null;
  throughDate: string;
  /** True when the row stops before the end of its month. */
  monthToDate: boolean;
  lastUpdatedAt: string | null;
};

const ADDITIVE = [
  'cashSales', 'creditCardSales', 'voucherSales', 'otherSales', 'totalSales',
  'creditCardTips', 'otherTips', 'numberOfSales', 'commissionTotal', 'commissionNet', 'grossIncome',
] as const;

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isYearMonth(value: unknown): value is string {
  return typeof value === 'string' && YEAR_MONTH.test(value);
}

/** 'YYYY-MM' shifted by a number of months (negative = earlier). */
export function shiftYearMonth(yearMonth: string, by: number): string {
  const [year, month] = yearMonth.split('-').map(Number) as [number, number];
  const index = year * 12 + (month - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Every month from start to end inclusive, oldest first. */
export function yearMonthsBetween(start: string, end: string): string[] {
  const months: string[] = [];
  for (let cursor = start; cursor <= end && months.length < 600; cursor = shiftYearMonth(cursor, 1)) months.push(cursor);
  return months;
}

export function lastDayOfYearMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split('-').map(Number) as [number, number];
  return `${yearMonth}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
}

/**
 * Fold report rows that name the same shop into one. Money and counts add;
 * the three ratios are rebuilt from the sums, never averaged.
 */
export function combineRevenueRows(rows: MonthlyRevenueFigures[]): MonthlyRevenueFigures {
  const out: Record<string, number | null> = {};
  for (const key of ADDITIVE) {
    const values = rows.map((r) => r[key]).filter((v): v is number => v != null && Number.isFinite(v));
    out[key] = values.length ? values.reduce((a, b) => a + b, 0) : null;
  }
  const sales = out.numberOfSales;
  const total = out.totalSales;
  // Services per sale has no total behind it in the report, so it is the
  // sales-weighted mean of the rows that have one.
  const weighted = rows.filter((r) => r.servicesPerSale != null && Number(r.numberOfSales) > 0);
  const weight = weighted.reduce((a, r) => a + Number(r.numberOfSales), 0);
  return {
    ...(out as unknown as MonthlyRevenueFigures),
    servicesPerSale: weight > 0 ? weighted.reduce((a, r) => a + Number(r.servicesPerSale) * Number(r.numberOfSales), 0) / weight : null,
    avgSaleValue: sales != null && sales > 0 && total != null ? total / sales : null,
    pctCostOfSale: total != null && total > 0 && out.commissionNet != null ? out.commissionNet / total : null,
  };
}

export type MonthlyRevenueWrite = MonthlyRevenueFigures & { locationName: string; locationId: string | null };

/**
 * The rows to store for one month from a parsed report: that month's detail
 * rows, one per canonical shop name. A report asked for a single month still
 * prints the month row, so nothing is taken from the "Totals" rows.
 */
export function monthRowsForStorage(
  parsedRows: DailySalesSummaryTotalsRow[],
  yearMonth: string,
  canonicalName: (name: string) => string,
  resolveLocationId: (name: string) => string | null,
): MonthlyRevenueWrite[] {
  const byName = new Map<string, { name: string; rows: MonthlyRevenueFigures[] }>();
  for (const row of parsedRows) {
    if (row.rowKind !== 'monthDetail' || row.yearMonth !== yearMonth || !row.locationName) continue;
    const name = canonicalName(row.locationName).trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const key = name.toLowerCase();
    const entry = byName.get(key) || { name, rows: [] };
    entry.rows.push(row);
    byName.set(key, entry);
  }
  return [...byName.values()].map(({ name, rows }) => ({
    locationName: name,
    locationId: resolveLocationId(name),
    ...(rows.length === 1 ? pickFigures(rows[0]!) : combineRevenueRows(rows)),
  }));
}

function pickFigures(row: MonthlyRevenueFigures): MonthlyRevenueFigures {
  return {
    cashSales: row.cashSales, creditCardSales: row.creditCardSales, voucherSales: row.voucherSales,
    otherSales: row.otherSales, totalSales: row.totalSales, creditCardTips: row.creditCardTips,
    otherTips: row.otherTips, numberOfSales: row.numberOfSales, servicesPerSale: row.servicesPerSale,
    avgSaleValue: row.avgSaleValue, commissionTotal: row.commissionTotal, commissionNet: row.commissionNet,
    grossIncome: row.grossIncome, pctCostOfSale: row.pctCostOfSale,
  };
}

/** Replace one month's rows. Returns how many were written. */
export function replaceMonthlyRevenueMonth(
  sqlite: SqliteDb,
  teamId: string,
  yearMonth: string,
  throughDate: string,
  rows: MonthlyRevenueWrite[],
  now: string,
): number {
  const insert = sqlite.prepare(
    `INSERT INTO monthly_revenue_summary_facts (
       team_id, location_name, year_month, location_id,
       cash_sales, credit_card_sales, voucher_sales, other_sales, total_sales,
       credit_card_tips, other_tips, number_of_sales, services_per_sale, avg_sale_value,
       commission_total, commission_net, gross_income, pct_cost_of_sale,
       through_date, last_updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const run = sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM monthly_revenue_summary_facts WHERE team_id = ? AND year_month = ?').run(teamId, yearMonth);
    for (const r of rows) {
      insert.run(
        teamId, r.locationName, yearMonth, r.locationId,
        r.cashSales, r.creditCardSales, r.voucherSales, r.otherSales, r.totalSales,
        r.creditCardTips, r.otherTips, r.numberOfSales == null ? null : Math.round(r.numberOfSales),
        r.servicesPerSale, r.avgSaleValue, r.commissionTotal, r.commissionNet, r.grossIncome, r.pctCostOfSale,
        throughDate, now,
      );
    }
  });
  run();
  return rows.length;
}

type FactRow = MonthlyRevenueFigures & {
  locationId: string | null; locationName: string; yearMonth: string; throughDate: string; lastUpdatedAt: string | null;
};

/**
 * Read a span of months, oldest first within each shop, with the two derived
 * figures attached. `canonicalName` is applied to the hours rows too, so a
 * shop the reports have spelled two ways still finds its hours.
 */
export function readMonthlyRevenue(
  sqlite: SqliteDb,
  teamId: string,
  startMonth: string,
  endMonth: string,
  canonicalName: (name: string) => string,
): MonthlyRevenueRow[] {
  const facts = sqlite.prepare(
    `SELECT location_id AS locationId, location_name AS locationName, year_month AS yearMonth,
       cash_sales AS cashSales, credit_card_sales AS creditCardSales, voucher_sales AS voucherSales,
       other_sales AS otherSales, total_sales AS totalSales, credit_card_tips AS creditCardTips,
       other_tips AS otherTips, number_of_sales AS numberOfSales, services_per_sale AS servicesPerSale,
       avg_sale_value AS avgSaleValue, commission_total AS commissionTotal, commission_net AS commissionNet,
       gross_income AS grossIncome, pct_cost_of_sale AS pctCostOfSale,
       through_date AS throughDate, last_updated_at AS lastUpdatedAt
     FROM monthly_revenue_summary_facts
     WHERE team_id = ? AND year_month >= ? AND year_month <= ?
     ORDER BY location_name COLLATE NOCASE, year_month`,
  ).all(teamId, startMonth, endMonth) as FactRow[];

  const key = (name: string, yearMonth: string) => `${canonicalName(name).trim().replace(/\s+/g, ' ').toLowerCase()}::${yearMonth}`;
  const minutes = new Map<string, number>();
  if (facts.length) {
    const hours = sqlite.prepare(
      `SELECT location_name AS locationName, substr(date, 1, 7) AS yearMonth, hours_worked_raw AS hoursWorkedRaw
       FROM staff_performance_facts
       WHERE team_id = ? AND date >= ? AND date <= ? AND hours_worked_raw IS NOT NULL`,
    ).all(teamId, `${startMonth}-01`, lastDayOfYearMonth(endMonth)) as Array<{ locationName: string; yearMonth: string; hoursWorkedRaw: string | null }>;
    for (const h of hours) {
      const worked = parseHoursWorkedToMinutes(h.hoursWorkedRaw);
      if (!(worked > 0)) continue;
      const k = key(h.locationName, h.yearMonth);
      minutes.set(k, (minutes.get(k) || 0) + worked);
    }
  }

  return facts.map((f) => {
    const worked = minutes.get(key(f.locationName, f.yearMonth)) ?? null;
    const hasCards = f.creditCardSales != null || f.creditCardTips != null;
    return {
      ...f,
      totalCreditCards: hasCards ? Number(f.creditCardSales || 0) + Number(f.creditCardTips || 0) : null,
      hoursWorkedMinutes: worked,
      salesPerHour: worked != null && worked > 0 && f.numberOfSales != null ? f.numberOfSales / (worked / 60) : null,
      monthToDate: f.throughDate < lastDayOfYearMonth(f.yearMonth),
    };
  });
}
