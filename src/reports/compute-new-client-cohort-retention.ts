// Recomputes the per-stylist and per-location new-client cohort retention
// counts from our local `appointments` table. Unlike the YOT-sourced
// reports (sync-*.ts), this one doesn't call the YOT API — it derives
// everything from data we've already ingested via the 15-min appointment
// sync.
//
// Output: upserts into `new_client_cohort_retention` (migration 0015). One
// row per (scope, location, stylist?, cohort_month).
//
// Semantics:
//   - "New" = appointments.new_client = 1 (YOT's "new to business" flag
//     captured at booking time).
//   - "Returned" = the same client_id has ANY later appointment in the
//     business, to any stylist. The customer wants forward retention
//     credited to the originating stylist.
//   - "Returned to stylist" = the same client_id has a later appointment
//     specifically with the originating stylist. Powers the Top Retainers
//     leaderboard, which is keyed on same-stylist loyalty.
//   - cohort_month = YYYY-MM of the client's FIRST appointment in the
//     ingestion window. If a client somehow has new_client=1 on multiple
//     appointments (rare YOT data quirk — ~0.05% of cases) we collapse
//     to the earliest.
//
// Recompute window: last 6 calendar months ending at "today" by default.
// The "returned" count is a running total — anyone in the Feb cohort who
// returns in July adds to Feb's count — so we fully overwrite each
// in-scope month rather than incrementing.

import { createHash } from 'node:crypto';
import { initializeDatabase } from '../db';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

export type ComputeOptions = {
  teamId: string;
  /** Inclusive earliest cohort month YYYY-MM. Defaults to (today - 5 months). */
  startMonth?: string;
  /** Inclusive latest cohort month YYYY-MM. Defaults to today's month. */
  endMonth?: string;
};

export type ComputeResult = {
  ok: boolean;
  teamId: string;
  startMonth: string;
  endMonth: string;
  stylistRowsWritten: number;
  locationRowsWritten: number;
  cohortMonthsCovered: string[];
  computedAt: string;
};

function ymOffset(ym: string, monthDelta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + monthDelta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function todayUtcYearMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function rowId(teamId: string, scope: 'stylist' | 'location', locationId: string, stylistId: string | null, cohortMonth: string): string {
  return createHash('sha1')
    .update(`${teamId}::${scope}::${locationId}::${stylistId ?? ''}::${cohortMonth}`)
    .digest('hex')
    .slice(0, 32);
}

// For a given cohort month, compute the per-(location, stylist) counts of
// new-to-business clients and how many of them ever returned to the
// business afterwards (any stylist, any location). One pass per month
// keeps memory bounded.
type RawCohortRow = {
  locationId: string;
  stylistId: string;
  newCount: number;
  returnedCount: number;
  returnedToStylistCount: number;
};

function computeMonth(sqlite: SqliteDb, teamId: string, cohortMonth: string): RawCohortRow[] {
  const monthStart = `${cohortMonth}-01T00:00:00`;
  const monthEnd = `${ymOffset(cohortMonth, 1)}-01T00:00:00`;

  // "First appointment per client" within the cohort month. A client only
  // counts once even if YOT flagged them new on multiple rows (rare).
  // Restricted to rows where new_client = 1 — that's what defines the
  // cohort.
  //
  // Returned: EXISTS any appointment for the same client_id with a later
  // start than this cohort row. We use a subquery rather than a window
  // function so SQLite can use the (client_id) index efficiently.
  const stmt = sqlite.prepare(`
    WITH cohort AS (
      SELECT
        location_id,
        stylist_id,
        client_id,
        MIN(COALESCE(start_at, starts_at)) AS first_at
      FROM appointments
      WHERE team_id = ?
        AND new_client = 1
        AND client_id IS NOT NULL
        AND stylist_id IS NOT NULL
        AND location_id IS NOT NULL
        AND COALESCE(start_at, starts_at) >= ?
        AND COALESCE(start_at, starts_at) < ?
      GROUP BY location_id, stylist_id, client_id
    )
    SELECT
      c.location_id AS locationId,
      c.stylist_id AS stylistId,
      COUNT(*) AS newCount,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM appointments a
        WHERE a.team_id = ?
          AND a.client_id = c.client_id
          AND COALESCE(a.start_at, a.starts_at) > c.first_at
      ) THEN 1 ELSE 0 END) AS returnedCount,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM appointments a
        WHERE a.team_id = ?
          AND a.client_id = c.client_id
          AND a.stylist_id = c.stylist_id
          AND COALESCE(a.start_at, a.starts_at) > c.first_at
      ) THEN 1 ELSE 0 END) AS returnedToStylistCount
    FROM cohort c
    GROUP BY c.location_id, c.stylist_id
  `);
  return stmt.all(teamId, monthStart, monthEnd, teamId, teamId) as RawCohortRow[];
}

export function computeNewClientCohortRetention(options: ComputeOptions): ComputeResult {
  const { teamId } = options;
  const endMonth = options.endMonth || todayUtcYearMonth();
  const startMonth = options.startMonth || ymOffset(endMonth, -5);

  const { sqlite } = initializeDatabase(teamId);

  const months: string[] = [];
  for (let m = startMonth; m <= endMonth; m = ymOffset(m, 1)) months.push(m);

  const computedAt = new Date().toISOString();
  let stylistRowsWritten = 0;
  let locationRowsWritten = 0;

  const upsertStylist = sqlite.prepare(`
    INSERT INTO new_client_cohort_retention (
      id, team_id, scope, location_id, stylist_id, cohort_month,
      new_count, returned_count, returned_to_stylist_count, computed_at
    ) VALUES (?, ?, 'stylist', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(team_id, scope, location_id, stylist_id, cohort_month)
    DO UPDATE SET
      new_count                  = excluded.new_count,
      returned_count             = excluded.returned_count,
      returned_to_stylist_count  = excluded.returned_to_stylist_count,
      computed_at                = excluded.computed_at
  `);
  // location-scope rows have stylist_id = NULL. SQLite treats NULLs as
  // distinct in UNIQUE constraints, so we need a separate ON CONFLICT
  // target (the same one works because the index defines stylist_id as
  // part of the key — for NULL we rely on a deterministic "any matching
  // row with this scope+loc+month" lookup via the index. To keep it
  // simple and deterministic we use a manual upsert: delete-then-insert
  // for location rows in a single transaction so re-runs are clean.
  const deleteLocationRow = sqlite.prepare(`
    DELETE FROM new_client_cohort_retention
    WHERE team_id = ? AND scope = 'location' AND location_id = ? AND cohort_month = ?
  `);
  const insertLocation = sqlite.prepare(`
    INSERT INTO new_client_cohort_retention (
      id, team_id, scope, location_id, stylist_id, cohort_month,
      new_count, returned_count, returned_to_stylist_count, computed_at
    ) VALUES (?, ?, 'location', ?, NULL, ?, ?, ?, ?, ?)
  `);

  const tx = sqlite.transaction((monthList: string[]) => {
    for (const month of monthList) {
      const rows = computeMonth(sqlite, teamId, month);

      // Stylist rows.
      for (const r of rows) {
        upsertStylist.run(
          rowId(teamId, 'stylist', r.locationId, r.stylistId, month),
          teamId,
          r.locationId,
          r.stylistId,
          month,
          r.newCount,
          r.returnedCount,
          r.returnedToStylistCount,
          computedAt,
        );
        stylistRowsWritten++;
      }

      // Location rollups: sum across stylists at each location. The
      // returned_to_stylist column is a sum of same-stylist returns at
      // that location — kept consistent with stylist rows but not surfaced
      // in the location UI.
      const byLocation = new Map<string, { newCount: number; returnedCount: number; returnedToStylistCount: number }>();
      for (const r of rows) {
        const acc = byLocation.get(r.locationId) || { newCount: 0, returnedCount: 0, returnedToStylistCount: 0 };
        acc.newCount += r.newCount;
        acc.returnedCount += r.returnedCount;
        acc.returnedToStylistCount += r.returnedToStylistCount;
        byLocation.set(r.locationId, acc);
      }
      for (const [locationId, agg] of byLocation) {
        deleteLocationRow.run(teamId, locationId, month);
        insertLocation.run(
          rowId(teamId, 'location', locationId, null, month),
          teamId,
          locationId,
          month,
          agg.newCount,
          agg.returnedCount,
          agg.returnedToStylistCount,
          computedAt,
        );
        locationRowsWritten++;
      }
    }
  });

  tx(months);

  return {
    ok: true,
    teamId,
    startMonth,
    endMonth,
    stylistRowsWritten,
    locationRowsWritten,
    cohortMonthsCovered: months,
    computedAt,
  };
}
