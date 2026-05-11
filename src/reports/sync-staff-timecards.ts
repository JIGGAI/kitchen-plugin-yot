import { createHash } from 'node:crypto';
import { initializeDatabase } from '../db';
import type { YotConfig } from '../types';
import { createReportClient } from './client';
import {
  STAFF_TIMECARD_SUMMARY_REPORT,
  buildStaffTimecardSummaryParameterDiscovery,
  buildStaffTimecardSummaryInstanceParams,
  parseStaffTimecardSummaryWorkbook,
  type StaffTimecardSummaryShiftRow,
} from './reports/staff-timecard-summary';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

export type SyncStaffTimecardsOptions = {
  teamId: string;
  startDate: string;    // YYYY-MM-DD
  endDate: string;      // YYYY-MM-DD
  organisationId: number;
  chunkDays?: number;   // default 7; max recommended 14 given Telerik's 5-min render ceiling
};

export type SyncStaffTimecardsResult = {
  ok: boolean;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  chunks: number;
  startDate: string;
  endDate: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readConfig(sqlite: SqliteDb, teamId: string): YotConfig {
  const row = sqlite
    .prepare("SELECT value FROM plugin_config WHERE team_id = ? AND key = 'yot'")
    .get(teamId) as { value?: string } | undefined;
  if (!row?.value) throw new Error(`No YOT config found for team ${teamId}`);
  const parsed = JSON.parse(row.value) as YotConfig;
  if (!parsed?.apiKey) throw new Error(`Invalid YOT config payload for team ${teamId}`);
  return parsed;
}

/**
 * Stable row ID: SHA-1(team::location::staffName::shiftDate) truncated to 32 hex chars.
 * Uniquely identifies a (team, location, stylist, day) fact.
 * Location is included so multi-location stylists (same shift echoed in multiple
 * location blocks) each get their own row rather than clobbering each other.
 */
function factId(teamId: string, locationName: string | null, staffName: string, shiftDate: string): string {
  return createHash('sha1')
    .update(`${teamId}::${locationName ?? ''}::${staffName}::${shiftDate}`)
    .digest('hex')
    .slice(0, 32);
}

function parseDateOnlyUtc(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
}

function formatDateOnlyUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function addDaysIso(dateOnly: string, n: number): string {
  const d = parseDateOnlyUtc(dateOnly);
  d.setUTCDate(d.getUTCDate() + n);
  return formatDateOnlyUtc(d);
}

function minDateOnly(a: string, b: string): string {
  return a <= b ? a : b;
}

/**
 * Split [startDate, endDate] into non-overlapping windows of at most chunkDays.
 * Using a safe date-only UTC path avoids DST drift at month boundaries.
 */
function* dateChunks(
  startDate: string,
  endDate: string,
  chunkDays: number,
): Generator<{ chunkStart: string; chunkEnd: string }> {
  let cursor = startDate;
  while (cursor <= endDate) {
    const chunkEnd = minDateOnly(addDaysIso(cursor, chunkDays - 1), endDate);
    yield { chunkStart: cursor, chunkEnd };
    cursor = addDaysIso(chunkEnd, 1);
  }
}

// ---------------------------------------------------------------------------
// Report fetch — one chunk
// ---------------------------------------------------------------------------

async function fetchOneChunk(
  config: YotConfig,
  organisationId: number,
  startDate: string,
  endDate: string,
): Promise<StaffTimecardSummaryShiftRow[]> {
  const client = createReportClient(config);
  const startDateIso = `${startDate}T00:00:00`;
  const endDateIso = `${endDate}T23:59:59`;
  const params = { startDateIso, endDateIso, organisationId };

  await client.getParameters(
    STAFF_TIMECARD_SUMMARY_REPORT.reportType,
    buildStaffTimecardSummaryParameterDiscovery(params, config.apiKey),
  );
  const instanceId = await client.createInstance(
    STAFF_TIMECARD_SUMMARY_REPORT.reportType,
    buildStaffTimecardSummaryInstanceParams(params),
  );
  const document = await client.createDocument(instanceId, STAFF_TIMECARD_SUMMARY_REPORT.preferredFormat);
  await client.waitForDocument(instanceId, document.documentId);
  const file = await client.fetchDocument(instanceId, document.documentId);

  const parsed = parseStaffTimecardSummaryWorkbook(file.buffer);
  return parsed.rows.filter((r) => r.rowKind === 'shift');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function syncStaffTimecards(
  options: SyncStaffTimecardsOptions,
): Promise<SyncStaffTimecardsResult> {
  const { teamId, startDate, endDate, organisationId } = options;
  // Telerik's render times out (200 polls = ~5 min) on 7-day full-org pulls.
  // 3-day chunks fit comfortably under that limit.
  const chunkDays = Math.max(1, Math.min(Math.trunc(options.chunkDays ?? 3), 14));

  const { sqlite } = initializeDatabase(teamId);
  const config = readConfig(sqlite, teamId);

  // Fetch all shift rows across date chunks (avoids Telerik's 5-min render ceiling)
  const allShifts: StaffTimecardSummaryShiftRow[] = [];
  let chunkCount = 0;
  for (const { chunkStart, chunkEnd } of dateChunks(startDate, endDate, chunkDays)) {
    chunkCount += 1;
    console.log(`[sync-staff-timecards] chunk ${chunkCount}: ${chunkStart} → ${chunkEnd}`);
    const shifts = await fetchOneChunk(config, organisationId, chunkStart, chunkEnd);
    console.log(`[sync-staff-timecards]   → ${shifts.length} shift rows`);
    allShifts.push(...shifts);
  }

  // Upsert in a single transaction for atomicity
  const upsert = sqlite.prepare(`
    INSERT INTO staff_timecard_facts
      (id, team_id, location_name, staff_name, shift_date, arrived_minutes, raw_row, synced_at)
    VALUES
      (@id, @team_id, @location_name, @staff_name, @shift_date, @arrived_minutes, @raw_row, @synced_at)
    ON CONFLICT(id) DO UPDATE SET
      location_name   = excluded.location_name,
      arrived_minutes = excluded.arrived_minutes,
      raw_row         = excluded.raw_row,
      synced_at       = excluded.synced_at
  `);
  const checkExists = sqlite.prepare('SELECT 1 FROM staff_timecard_facts WHERE id = ?');
  const syncedAt = new Date().toISOString();
  let rowsInserted = 0;
  let rowsUpdated = 0;
  let rowsSkipped = 0;

  const tx = sqlite.transaction(() => {
    for (const row of allShifts) {
      if (!row.staffName || !row.shiftDate) {
        rowsSkipped += 1;
        continue;
      }
      const id = factId(teamId, row.locationName, row.staffName, row.shiftDate);
      const exists = checkExists.get(id) != null;
      upsert.run({
        id,
        team_id: teamId,
        location_name: row.locationName,
        staff_name: row.staffName,
        shift_date: row.shiftDate,
        arrived_minutes: row.arrivedMinutes,
        raw_row: JSON.stringify(row.raw),
        synced_at: syncedAt,
      });
      if (exists) { rowsUpdated += 1; } else { rowsInserted += 1; }
    }
  });
  tx();

  console.log(`[sync-staff-timecards] done: inserted=${rowsInserted} updated=${rowsUpdated} skipped=${rowsSkipped}`);
  return {
    ok: true,
    rowsInserted,
    rowsUpdated,
    rowsSkipped,
    chunks: chunkCount,
    startDate,
    endDate,
  };
}
