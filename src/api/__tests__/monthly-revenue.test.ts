import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Monthly Revenue Summary: DailySalesSummaryTotals kept one row per
// (location, month). Covers the storage shaping, the two derived figures
// (total credit cards, sales per hour), the read route, and the rule for
// which months the half-hourly job refreshes.
vi.mock('../../drivers/yot-client', () => ({
  saveClient: vi.fn(), fetchClient: vi.fn(), fetchClients: vi.fn(),
  characterizeClientPaging: vi.fn(), extractAppointmentsRangeRows: vi.fn(),
  fetchAppointmentsRange: vi.fn(), fetchBusiness: vi.fn(),
  fetchLocationServices: vi.fn(), fetchLocationStaff: vi.fn(),
  fetchLocations: vi.fn(), fetchStaffProfile: vi.fn(), ping: vi.fn(),
}));

import { handleRequest, canonicalLocationName, monthlyRevenueMonthsDue } from '../handler';
import { initializeDatabase } from '../../db';
import {
  combineRevenueRows, lastDayOfYearMonth, monthRowsForStorage, readMonthlyRevenue,
  replaceMonthlyRevenueMonth, shiftYearMonth, yearMonthsBetween, type MonthlyRevenueFigures,
} from '../monthly-revenue';
import { parseMonthLabel, type DailySalesSummaryTotalsRow } from '../../reports/reports/daily-sales-summary-totals';

let tmp: string;
let teamSeq = 0;
function freshTeam(): string {
  const teamId = `MR${teamSeq++}`;
  initializeDatabase(teamId);
  return teamId;
}

// A month row the way the report prints it: net + gross = total, and
// % cost of sale = net ÷ total.
function figures(total: number, sales: number, extra: Partial<MonthlyRevenueFigures> = {}): MonthlyRevenueFigures {
  const commissionNet = total * 0.5;
  return {
    cashSales: total * 0.1, creditCardSales: total * 0.85, voucherSales: total * 0.03, otherSales: total * 0.02,
    totalSales: total, creditCardTips: total * 0.2, otherTips: 0, numberOfSales: sales,
    servicesPerSale: 1.5, avgSaleValue: total / sales, commissionTotal: commissionNet * 1.02,
    commissionNet, grossIncome: total - commissionNet, pctCostOfSale: commissionNet / total, ...extra,
  };
}
const detail = (locationName: string, yearMonth: string, total: number, sales: number, extra: Partial<MonthlyRevenueFigures> = {}): DailySalesSummaryTotalsRow => ({
  locationName, rowKind: 'monthDetail', monthLabel: yearMonth, yearMonth, ...figures(total, sales, extra), raw: [],
});
const store = (teamId: string, yearMonth: string, rows: DailySalesSummaryTotalsRow[], throughDate = lastDayOfYearMonth(yearMonth), now = '2026-11-01T00:00:00.000Z') => {
  const { sqlite } = initializeDatabase(teamId);
  return replaceMonthlyRevenueMonth(sqlite, teamId, yearMonth, throughDate, monthRowsForStorage(rows, yearMonth, canonicalLocationName, () => null), now);
};
const hours = (teamId: string, locationName: string, staffName: string, date: string, raw: string) => {
  const { sqlite } = initializeDatabase(teamId);
  sqlite.prepare(
    `INSERT INTO staff_performance_facts (team_id, location_name, staff_name, date, hours_worked_raw, last_updated_at) VALUES (?,?,?,?,?,?)`,
  ).run(teamId, locationName, staffName, date, raw, '2026-11-01T00:00:00Z');
};
const call = (method: string, path: string, teamId: string, query: Record<string, string> = {}) =>
  handleRequest({ method, path, query: { team: teamId, ...query }, headers: {}, body: null }, {} as any);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'yot-monthly-revenue-'));
  process.env.HOME = tmp;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('month helpers', () => {
  it('reads the report month labels', () => {
    expect(parseMonthLabel('Sep 2026')).toBe('2026-09');
    expect(parseMonthLabel(' January 2025 ')).toBe('2025-01');
    expect(parseMonthLabel('Totals')).toBeNull();
    expect(parseMonthLabel('Brighton MI')).toBeNull();
    expect(parseMonthLabel('Foo 2026')).toBeNull();
  });

  it('shifts and lists months across a year boundary', () => {
    expect(shiftYearMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftYearMonth('2025-12', 1)).toBe('2026-01');
    expect(shiftYearMonth('2026-11', -12)).toBe('2025-11');
    expect(yearMonthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(lastDayOfYearMonth('2024-02')).toBe('2024-02-29');
    expect(lastDayOfYearMonth('2026-11')).toBe('2026-11-30');
  });
});

describe('shaping report rows for storage', () => {
  it('keeps only the asked-for month and ignores totals rows', () => {
    const rows = monthRowsForStorage([
      detail('Brighton MI', '2026-09', 1000, 40),
      detail('Brighton MI', '2026-10', 1200, 50),
      { ...detail('Brighton MI', '2026-10', 2200, 90), rowKind: 'locationTotal', yearMonth: null },
      { ...detail('Brighton MI', '2026-10', 9999, 999), rowKind: 'grandTotal', locationName: null },
    ], '2026-10', canonicalLocationName, () => '4176');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ locationName: 'Brighton MI', locationId: '4176', totalSales: 1200, numberOfSales: 50 });
  });

  it('folds two spellings of one shop together and rebuilds the ratios from the sums', () => {
    // "Waterford" is the pre-rename spelling of "Waterford Mi".
    const rows = monthRowsForStorage([
      detail('Waterford', '2026-11', 1000, 20, { servicesPerSale: 1.0 }),
      detail('Waterford Mi', '2026-11', 3000, 80, { servicesPerSale: 2.0, commissionNet: 1800, grossIncome: 1200, pctCostOfSale: 0.6 }),
    ], '2026-11', canonicalLocationName, () => null);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.locationName).toBe('Waterford Mi');
    expect(row.totalSales).toBe(4000);
    expect(row.numberOfSales).toBe(100);
    expect(row.commissionNet).toBe(2300);
    // Not the mean of 0.5 and 0.6, and not the mean of 1.0 and 2.0.
    expect(row.pctCostOfSale).toBeCloseTo(2300 / 4000, 10);
    expect(row.servicesPerSale).toBeCloseTo((1 * 20 + 2 * 80) / 100, 10);
    expect(row.avgSaleValue).toBe(40);
  });

  it('leaves a ratio empty rather than dividing by nothing', () => {
    const combined = combineRevenueRows([figures(0, 0, { numberOfSales: 0, totalSales: 0, servicesPerSale: null, commissionNet: 0 })]);
    expect(combined.avgSaleValue).toBeNull();
    expect(combined.pctCostOfSale).toBeNull();
    expect(combined.servicesPerSale).toBeNull();
  });
});

describe('storing and reading', () => {
  it('replaces a month wholesale, so a shop the report stops listing goes away', () => {
    const teamId = freshTeam();
    expect(store(teamId, '2026-10', [detail('Brighton MI', '2026-10', 1200, 50), detail('Howell MI', '2026-10', 800, 30)])).toBe(2);
    expect(store(teamId, '2026-10', [detail('Brighton MI', '2026-10', 1300, 55)])).toBe(1);
    const { sqlite } = initializeDatabase(teamId);
    const rows = readMonthlyRevenue(sqlite, teamId, '2026-10', '2026-10', canonicalLocationName);
    expect(rows.map((r) => [r.locationName, r.totalSales])).toEqual([['Brighton MI', 1300]]);
  });

  it('adds total credit cards and sales per hour, and leaves sales per hour empty without hours', () => {
    const teamId = freshTeam();
    store(teamId, '2026-10', [detail('Brighton MI', '2026-10', 1000, 120), detail('Howell MI', '2026-10', 800, 30)]);
    // 30h + 30h at Brighton in October; an hour in November must not count.
    hours(teamId, 'Brighton MI', 'Stylist One', '2026-10-03', '30h, 0m');
    hours(teamId, 'Brighton MI', 'Stylist Two', '2026-10-04', '29h, 60m');
    hours(teamId, 'Brighton MI', 'Stylist One', '2026-11-01', '1h, 0m');
    const { sqlite } = initializeDatabase(teamId);
    const [brighton, howell] = readMonthlyRevenue(sqlite, teamId, '2026-10', '2026-10', canonicalLocationName);
    expect(brighton!.totalCreditCards).toBeCloseTo(850 + 200, 10);
    expect(brighton!.hoursWorkedMinutes).toBe(3600);
    expect(brighton!.salesPerHour).toBe(2);
    expect(brighton!.monthToDate).toBe(false);
    expect(howell!.hoursWorkedMinutes).toBeNull();
    expect(howell!.salesPerHour).toBeNull();
  });

  it('finds hours recorded under an older spelling of the shop', () => {
    const teamId = freshTeam();
    store(teamId, '2026-10', [detail('Waterford Mi', '2026-10', 1000, 60)]);
    hours(teamId, 'Waterford', 'Stylist One', '2026-10-03', '30h, 0m');
    const { sqlite } = initializeDatabase(teamId);
    const [row] = readMonthlyRevenue(sqlite, teamId, '2026-10', '2026-10', canonicalLocationName);
    expect(row!.salesPerHour).toBe(2);
  });

  it('marks a row that stops before the end of its month as month to date', () => {
    const teamId = freshTeam();
    store(teamId, '2026-11', [detail('Brighton MI', '2026-11', 400, 15)], '2026-11-13');
    const { sqlite } = initializeDatabase(teamId);
    const [row] = readMonthlyRevenue(sqlite, teamId, '2026-11', '2026-11', canonicalLocationName);
    expect(row!.monthToDate).toBe(true);
    expect(row!.throughDate).toBe('2026-11-13');
  });
});

describe('GET /monthly-revenue', () => {
  it('returns the asked-for span with every month named, even the empty ones', async () => {
    const teamId = freshTeam();
    store(teamId, '2026-08', [detail('Brighton MI', '2026-08', 900, 35)]);
    store(teamId, '2026-10', [detail('Brighton MI', '2026-10', 1200, 50)], undefined, '2026-11-02T00:00:00.000Z');
    store(teamId, '2025-01', [detail('Brighton MI', '2025-01', 500, 20)]);
    const res: any = await call('GET', '/monthly-revenue', teamId, { startMonth: '2026-08', endMonth: '2026-10' });
    expect(res.status).toBe(200);
    expect(res.data.months).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(res.data.rows.map((r: any) => r.yearMonth)).toEqual(['2026-08', '2026-10']);
    expect(res.data.dataFrom).toBe('2025-01');
    expect(res.data.dataTo).toBe('2026-10');
    expect(res.data.lastUpdatedAt).toBe('2026-11-02T00:00:00.000Z');
  });

  it('rejects a malformed month and caps the span at five years', async () => {
    const teamId = freshTeam();
    expect((await call('GET', '/monthly-revenue', teamId, { startMonth: '2026-8' }) as any).status).toBe(400);
    const res: any = await call('GET', '/monthly-revenue', teamId, { startMonth: '2000-01', endMonth: '2026-10' });
    expect(res.data.months).toHaveLength(60);
    expect(res.data.months[59]).toBe('2026-10');
  });
});

describe('POST /monthly-revenue/sync', () => {
  it('needs a configured team and sane months before it calls YOT', async () => {
    const teamId = freshTeam();
    expect((await call('POST', '/monthly-revenue/sync', teamId, { yearMonth: '2026-10' }) as any).status).toBe(400);
    const { sqlite } = initializeDatabase(teamId);
    sqlite.prepare(`INSERT INTO plugin_config (team_id, key, value, updated_at) VALUES (?,?,?,?)`).run(teamId, 'yot', JSON.stringify({ apiKey: 'k' }), '2026-01-01T00:00:00Z');
    const bad = async (query: Record<string, string>) => (await call('POST', '/monthly-revenue/sync', teamId, query) as any);
    expect((await bad({ yearMonth: 'October' })).status).toBe(400);
    expect((await bad({ startMonth: '2026-05', endMonth: '2026-03' })).status).toBe(400);
    expect((await bad({ yearMonth: '2999-01' })).data.message).toMatch(/has not started yet/);
    expect((await bad({ startMonth: '2024-01', endMonth: '2025-06' })).data.message).toMatch(/At most 12 months/);
  });
});

describe('which months the half-hourly job refreshes', () => {
  const NOW = Date.parse('2026-11-13T15:00:00.000Z');
  const due = (teamId: string) => {
    const { sqlite } = initializeDatabase(teamId);
    return monthlyRevenueMonthsDue(sqlite, teamId, '2026-11', NOW, lastDayOfYearMonth, (ym) => shiftYearMonth(ym, -1));
  };

  it('syncs the current month when it has never been stored', () => {
    expect(due(freshTeam())).toEqual(['2026-11']);
  });

  it('leaves a recently refreshed month alone and refreshes a stale one', () => {
    const fresh = freshTeam();
    store(fresh, '2026-11', [detail('Brighton MI', '2026-11', 400, 15)], '2026-11-13', '2026-11-13T12:00:00.000Z');
    expect(due(fresh)).toEqual([]);
    const stale = freshTeam();
    store(stale, '2026-11', [detail('Brighton MI', '2026-11', 400, 15)], '2026-11-13', '2026-11-13T08:00:00.000Z');
    expect(due(stale)).toEqual(['2026-11']);
  });

  it('finishes last month when it was last stored as a month to date', () => {
    const teamId = freshTeam();
    store(teamId, '2026-10', [detail('Brighton MI', '2026-10', 1100, 45)], '2026-10-31', '2026-10-31T20:00:00.000Z');
    store(teamId, '2026-11', [detail('Brighton MI', '2026-11', 400, 15)], '2026-11-13', '2026-11-13T12:00:00.000Z');
    expect(due(teamId)).toEqual([]);
    const cutShort = freshTeam();
    store(cutShort, '2026-10', [detail('Brighton MI', '2026-10', 1100, 45)], '2026-10-30', '2026-10-30T20:00:00.000Z');
    store(cutShort, '2026-11', [detail('Brighton MI', '2026-11', 400, 15)], '2026-11-13', '2026-11-13T12:00:00.000Z');
    expect(due(cutShort)).toEqual(['2026-10']);
  });
});
