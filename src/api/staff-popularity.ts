// Staff Popularity: YOT's Staff Popularity report (bookings that asked for
// each stylist, online vs. made by the shop) for any window, with three
// columns YOT's report does not have:
//
//   Customers per hour = haircuts ÷ hours worked        (Staff Performance)
//   Sales $ per hour   = sales dollars ÷ hours worked   (Staff Performance)
//   New-client returns = of the clients new to the stylist in each of the
//                        last four months, how many have come back
//                        (new_client_cohort_retention)
//
// Customers per hour is the same number the stylist leaderboard calls
// "Sales/hr"; both are sums over the window divided once, never a mean of
// daily rates.
//
// Three sources, no shared id. Popularity and Staff Performance are both YOT
// reports keyed by the staff member's full name inside a report-spelled shop
// name, so they join on case-folded, whitespace-collapsed name within the
// canonical shop. The cohort table is keyed by stylist id and named from the
// staff API, which is a preferred name ("Ali") where the reports print a
// legal one ("Alison"). Cohorts are bridged by exact name first, then by
// surname when exactly one person in that shop carries it, then by first name
// under the same rule; anything still ambiguous stays unmatched and the
// stylist's cells read as "no data" rather than borrowing someone's numbers.

import { parseHoursWorkedToMinutes } from '../reports/reports/staff-performance';

export type PopularityFactRow = {
  locationName: string;
  staffName: string;
  firstAvailable: number | boolean | null;
  onlineBookings: number | null;
  regularBookings: number | null;
};

export type PerformanceFactRow = {
  locationName: string;
  staffName: string;
  totalSalesCount: number | null;
  totalSalesValue: number | null;
  hoursWorkedRaw: string | null;
};

export type CohortFactRow = {
  scope: 'stylist' | 'location';
  locationName: string | null;
  stylistName: string | null;
  cohortMonth: string;       // YYYY-MM
  newCount: number | null;
  returnedCount: number | null;
};

export type CohortBucket = { month: string; newCount: number; returnedCount: number };

type Bookings = { onlineBookings: number; regularBookings: number; totalBookings: number };

type Productivity = {
  haircuts: number;
  salesValue: number;
  hoursWorkedMinutes: number;
  customersPerHour: number | null;
  salesPerHour: number | null;   // dollars
};

export type PopularityStylist = Bookings & Productivity & {
  staffName: string;
  /** Share of the shop's requested bookings (First Available excluded), 0..1. */
  requestShare: number | null;
  /** False when Staff Performance has no row for this name in the window. */
  hasPerformance: boolean;
  /** One bucket per cohort month, newest first; null when no cohort matched. */
  newClientReturns: CohortBucket[] | null;
};

export type PopularityLocation = Bookings & Productivity & {
  locationName: string;
  /** Bookings that asked for a stylist by name. */
  requested: Bookings;
  /** Bookings that asked for nobody in particular. */
  firstAvailable: Bookings;
  newClientReturns: CohortBucket[] | null;
  stylists: PopularityStylist[];
};

export type StaffPopularityResult = {
  cohortMonths: string[];
  totals: Bookings & Productivity & { requested: Bookings; firstAvailable: Bookings; stylistCount: number; newClientReturns: CohortBucket[] | null };
  locations: PopularityLocation[];
};

export type BuildStaffPopularityOptions = {
  popularityRows: PopularityFactRow[];
  performanceRows: PerformanceFactRow[];
  cohortRows: CohortFactRow[];
  /** Cohort months to report, newest first. */
  cohortMonths: string[];
  /** Folds report / locations-table spellings of one shop to a single name. */
  canonicalLocation?: (name: string) => string;
};

const collapse = (value: string | null | undefined) => String(value ?? '').replace(/\s+/g, ' ').trim();
const fold = (value: string | null | undefined) => collapse(value).toLowerCase();
// "Mary Clark (Artist)" → "mary clark"
const nameKey = (value: string | null | undefined) => fold(String(value ?? '').replace(/\s*\([^)]*\)\s*$/, ''));

const blankBookings = (): Bookings => ({ onlineBookings: 0, regularBookings: 0, totalBookings: 0 });

function addBookings(target: Bookings, online: number, regular: number): void {
  target.onlineBookings += online;
  target.regularBookings += regular;
  target.totalBookings += online + regular;
}

function productivity(haircuts: number, salesValue: number, minutes: number): Productivity {
  const hours = minutes / 60;
  return {
    haircuts,
    salesValue: Math.round(salesValue * 100) / 100,
    hoursWorkedMinutes: minutes,
    // No hours on the clock means no rate: null, never Infinity or 0.
    customersPerHour: minutes > 0 ? haircuts / hours : null,
    salesPerHour: minutes > 0 ? salesValue / hours : null,
  };
}

/** The `count` most recent complete months before `today` (YYYY-MM-DD), newest first. */
export function trailingCohortMonths(today: string, count = 4): string[] {
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  const months: string[] = [];
  for (let back = 1; back <= count; back += 1) {
    const d = new Date(Date.UTC(y!, m! - 1 - back, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

export function buildStaffPopularity(opts: BuildStaffPopularityOptions): StaffPopularityResult {
  const canonical = opts.canonicalLocation ?? ((name: string) => name);
  const cohortMonths = opts.cohortMonths;

  type StylistAcc = Bookings & {
    staffName: string; haircuts: number; salesValue: number; minutes: number; hasPerformance: boolean;
  };
  type LocationAcc = {
    locationName: string;
    firstAvailable: Bookings;
    stylists: Map<string, StylistAcc>;
  };
  const locations = new Map<string, LocationAcc>();
  const locationFor = (rawName: string): LocationAcc => {
    const display = collapse(canonical(rawName)) || collapse(rawName);
    const key = display.toLowerCase();
    let acc = locations.get(key);
    if (!acc) {
      acc = { locationName: display, firstAvailable: blankBookings(), stylists: new Map() };
      locations.set(key, acc);
    }
    return acc;
  };
  const stylistFor = (loc: LocationAcc, staffName: string): StylistAcc => {
    const key = nameKey(staffName);
    let acc = loc.stylists.get(key);
    if (!acc) {
      acc = { staffName: collapse(staffName), ...blankBookings(), haircuts: 0, salesValue: 0, minutes: 0, hasPerformance: false };
      loc.stylists.set(key, acc);
    }
    return acc;
  };

  for (const row of opts.popularityRows) {
    if (!collapse(row.locationName) || !collapse(row.staffName)) continue;
    const online = Number(row.onlineBookings || 0);
    const regular = Number(row.regularBookings || 0);
    const loc = locationFor(row.locationName);
    if (row.firstAvailable) addBookings(loc.firstAvailable, online, regular);
    else addBookings(stylistFor(loc, row.staffName), online, regular);
  }

  // Staff Performance lists people the popularity report does not (nobody
  // asked for them by name in the window). They still worked, so they get a
  // row with zero bookings rather than vanishing from their shop.
  for (const row of opts.performanceRows) {
    if (!collapse(row.locationName) || !collapse(row.staffName)) continue;
    const stylist = stylistFor(locationFor(row.locationName), row.staffName);
    stylist.haircuts += Number(row.totalSalesCount || 0);
    stylist.salesValue += Number(row.totalSalesValue || 0);
    stylist.minutes += parseHoursWorkedToMinutes(row.hoursWorkedRaw);
    stylist.hasPerformance = true;
  }

  // Cohort rows → per location: shop-level buckets, and per-stylist buckets
  // keyed by the cohort table's own name for the bridge below.
  const monthIndex = new Map(cohortMonths.map((month, i) => [month, i]));
  const blankBuckets = (): CohortBucket[] => cohortMonths.map((month) => ({ month, newCount: 0, returnedCount: 0 }));
  const shopCohorts = new Map<string, CohortBucket[]>();
  const stylistCohorts = new Map<string, Map<string, CohortBucket[]>>();
  for (const row of opts.cohortRows) {
    const i = monthIndex.get(row.cohortMonth);
    if (i == null || !collapse(row.locationName)) continue;
    const locKey = fold(canonical(String(row.locationName)));
    let buckets: CohortBucket[];
    if (row.scope === 'location') {
      buckets = shopCohorts.get(locKey) ?? blankBuckets();
      shopCohorts.set(locKey, buckets);
    } else {
      const key = nameKey(row.stylistName);
      if (!key) continue;
      const byName = stylistCohorts.get(locKey) ?? new Map<string, CohortBucket[]>();
      stylistCohorts.set(locKey, byName);
      buckets = byName.get(key) ?? blankBuckets();
      byName.set(key, buckets);
    }
    // Two stylist ids can carry one name in a shop (a re-created account);
    // their cohorts are the same person's, so they add.
    buckets[i]!.newCount += Number(row.newCount || 0);
    buckets[i]!.returnedCount += Number(row.returnedCount || 0);
  }

  const totalBuckets = blankBuckets();
  let anyShopCohort = false;
  const totals = {
    ...blankBookings(), requested: blankBookings(), firstAvailable: blankBookings(),
    haircuts: 0, salesValue: 0, minutes: 0, stylistCount: 0,
  };

  const outLocations: PopularityLocation[] = [];
  for (const [locKey, loc] of locations) {
    const requested = blankBookings();
    let haircuts = 0; let salesValue = 0; let minutes = 0;
    for (const s of loc.stylists.values()) {
      addBookings(requested, s.onlineBookings, s.regularBookings);
      haircuts += s.haircuts; salesValue += s.salesValue; minutes += s.minutes;
    }

    // Bridge cohort names onto this shop's report names.
    const cohortByName = stylistCohorts.get(locKey) ?? new Map<string, CohortBucket[]>();
    const matched = new Map<string, CohortBucket[]>();   // report nameKey → buckets
    const reportKeys = [...loc.stylists.keys()];
    const unclaimed = new Map(cohortByName);
    for (const key of reportKeys) {
      const hit = unclaimed.get(key);
      if (hit) { matched.set(key, hit); unclaimed.delete(key); }
    }
    const bridge = (part: (key: string) => string, eligible: (cohortKey: string) => boolean) => {
      const openReport = reportKeys.filter((key) => !matched.has(key));
      const reportByPart = new Map<string, string[]>();
      for (const key of openReport) reportByPart.set(part(key), [...(reportByPart.get(part(key)) ?? []), key]);
      const cohortByPart = new Map<string, string[]>();
      for (const key of unclaimed.keys()) {
        if (eligible(key)) cohortByPart.set(part(key), [...(cohortByPart.get(part(key)) ?? []), key]);
      }
      for (const [token, cohortKeys] of cohortByPart) {
        const reportHits = reportByPart.get(token) ?? [];
        // One on each side or nothing: two people sharing the token is a guess.
        if (!token || cohortKeys.length !== 1 || reportHits.length !== 1) continue;
        matched.set(reportHits[0]!, unclaimed.get(cohortKeys[0]!)!);
        unclaimed.delete(cohortKeys[0]!);
      }
    };
    const lastToken = (key: string) => key.split(' ').pop() ?? '';
    const firstToken = (key: string) => key.split(' ')[0] ?? '';
    bridge(lastToken, (cohortKey) => cohortKey.includes(' '));   // surname, when the cohort name has one
    bridge(firstToken, () => true);                               // first name ("Ali" ↔ "Ali Garner")

    const stylists: PopularityStylist[] = [...loc.stylists.entries()].map(([key, s]) => ({
      staffName: s.staffName,
      onlineBookings: s.onlineBookings,
      regularBookings: s.regularBookings,
      totalBookings: s.totalBookings,
      requestShare: requested.totalBookings > 0 ? s.totalBookings / requested.totalBookings : null,
      ...productivity(s.haircuts, s.salesValue, s.minutes),
      hasPerformance: s.hasPerformance,
      newClientReturns: matched.get(key) ?? null,
    })).sort((a, b) => b.totalBookings - a.totalBookings || a.staffName.localeCompare(b.staffName));

    const shopBuckets = shopCohorts.get(locKey) ?? null;
    if (shopBuckets) {
      anyShopCohort = true;
      shopBuckets.forEach((bucket, i) => {
        totalBuckets[i]!.newCount += bucket.newCount;
        totalBuckets[i]!.returnedCount += bucket.returnedCount;
      });
    }

    const all = blankBookings();
    addBookings(all, requested.onlineBookings + loc.firstAvailable.onlineBookings, requested.regularBookings + loc.firstAvailable.regularBookings);
    outLocations.push({
      locationName: loc.locationName,
      ...all,
      requested,
      firstAvailable: loc.firstAvailable,
      ...productivity(haircuts, salesValue, minutes),
      newClientReturns: shopBuckets,
      stylists,
    });

    addBookings(totals, all.onlineBookings, all.regularBookings);
    addBookings(totals.requested, requested.onlineBookings, requested.regularBookings);
    addBookings(totals.firstAvailable, loc.firstAvailable.onlineBookings, loc.firstAvailable.regularBookings);
    totals.haircuts += haircuts; totals.salesValue += salesValue; totals.minutes += minutes;
    totals.stylistCount += stylists.length;
  }

  outLocations.sort((a, b) => a.locationName.localeCompare(b.locationName));

  const { haircuts, salesValue, minutes, ...bookingTotals } = totals;
  return {
    cohortMonths,
    totals: {
      ...bookingTotals,
      ...productivity(haircuts, salesValue, minutes),
      newClientReturns: anyShopCohort ? totalBuckets : null,
    },
    locations: outLocations,
  };
}
