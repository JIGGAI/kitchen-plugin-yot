// Sync franchises from the YOT MVC /Administration/Franchises/List page into
// the local SQLite. Joins each franchise's location-name list back to the
// `locations` table and stamps `franchise_id`/`franchise_name` columns so
// downstream consumers (the locations endpoint, the dashboard's coverage
// filter) can use them without re-scraping.
//
// Hair MX (franchiseId 1) is the corporate franchise; everything else is a
// franchisee. The `is_corporate` flag is set accordingly.

import { eq } from 'drizzle-orm';
import { initializeDatabase } from '../db';
import * as schema from '../db/schema';
import type { YotConfig } from '../types';
import { fetchFranchisesHtml, parseFranchisesHtml, withAutoLogin } from '../drivers/yot-mvc-client';

type SqliteDb = ReturnType<typeof initializeDatabase>['sqlite'];

const CORPORATE_FRANCHISE_NAMES = new Set(['hair mx']);

export type SyncFranchisesOptions = {
  teamId: string;
};

export type FranchiseSyncRecord = {
  franchiseId: string;
  name: string;
  isCorporate: boolean;
  locationCount: number;
  matchedLocationCount: number;
  unmatchedNames: string[];
};

export type SyncFranchisesResult = {
  syncedAt: string;
  franchises: FranchiseSyncRecord[];
  totalLocationsUpdated: number;
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

function persistMvcCookie(sqlite: SqliteDb, teamId: string, cookie: string): void {
  sqlite
    .prepare("UPDATE plugin_config SET value = json_set(value, '$.mvcCookie', ?) WHERE team_id = ? AND key = 'yot'")
    .run(cookie, teamId);
}

function isCorporateFranchise(name: string): boolean {
  return CORPORATE_FRANCHISE_NAMES.has(name.trim().toLowerCase());
}

/**
 * Normalize a location name for fuzzy matching: lowercase, collapse whitespace,
 * strip trailing punctuation. The YOT franchise list and the YOT REST
 * /locations response usually agree on names, but there are minor cosmetic
 * differences (extra spaces, trailing periods) that this normalization
 * handles.
 */
function normalizeLocationName(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,]+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function syncFranchises(opts: SyncFranchisesOptions): Promise<SyncFranchisesResult> {
  const { teamId } = opts;
  const { db, sqlite } = initializeDatabase(teamId);
  const config = readConfig(sqlite, teamId);

  const html = await withAutoLogin(
    config,
    (cookie) => { persistMvcCookie(sqlite, teamId, cookie); },
    (cfg) => fetchFranchisesHtml(cfg),
    // No franchise rows → possibly an expired-cookie zombie session; let
    // withAutoLogin probe and re-login rather than persisting an empty sync.
    { looksEmpty: (h) => !/itemId=/i.test(h) },
  );
  const entries = parseFranchisesHtml(html);
  const syncedAt = new Date().toISOString();

  // Build a name → location-id index from the current locations table for
  // this team. We only consider active locations to avoid resolving stale
  // names back to retired stores.
  const allLocations = db
    .select({ id: schema.locations.id, name: schema.locations.name, active: schema.locations.active })
    .from(schema.locations)
    .where(eq(schema.locations.teamId, teamId))
    .all();

  const nameToId = new Map<string, string>();
  for (const loc of allLocations) {
    if (!loc.name) continue;
    if (loc.active === false) continue;
    nameToId.set(normalizeLocationName(loc.name), loc.id);
  }

  // Reset every location's franchise pointer for this team. Running franchises
  // are then re-stamped below; locations with no match will remain null
  // (rather than carrying a stale franchise from a previous sync).
  sqlite
    .prepare('UPDATE locations SET franchise_id = NULL, franchise_name = NULL WHERE team_id = ?')
    .run(teamId);

  // Replace the franchise table for this team.
  sqlite.prepare('DELETE FROM franchises WHERE team_id = ?').run(teamId);

  const records: FranchiseSyncRecord[] = [];
  let totalLocationsUpdated = 0;

  // Process entries with the corporate franchise LAST so it wins any conflict
  // (YOT can list a single store under multiple franchises, e.g. Morgantown
  // WV appears under both "Hair MX" corporate AND "Terry Morgantown" — the
  // intent in that case is corporate ownership). Within each group, preserve
  // the source order from YOT.
  const orderedEntries = [
    ...entries.filter((e) => !isCorporateFranchise(e.name)),
    ...entries.filter((e) => isCorporateFranchise(e.name)),
  ];

  for (const entry of orderedEntries) {
    const isCorp = isCorporateFranchise(entry.name);
    const matchedIds: string[] = [];
    const unmatched: string[] = [];
    for (const locName of entry.locationNames) {
      const id = nameToId.get(normalizeLocationName(locName));
      if (id) matchedIds.push(id);
      else unmatched.push(locName);
    }

    sqlite
      .prepare(
        'INSERT INTO franchises (team_id, franchise_id, name, is_corporate, location_count, synced_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(teamId, entry.franchiseId, entry.name, isCorp ? 1 : 0, entry.locationCount, syncedAt);

    if (matchedIds.length) {
      // Stamp the franchise pointer on every matched location. Since corporate
      // is processed last, any location appearing in BOTH a franchisee group
      // and the corporate group ends up correctly tagged as corporate.
      const stmt = sqlite.prepare(
        'UPDATE locations SET franchise_id = ?, franchise_name = ? WHERE team_id = ? AND id = ?',
      );
      const tx = sqlite.transaction((ids: string[]) => {
        for (const id of ids) stmt.run(entry.franchiseId, entry.name, teamId, id);
      });
      tx(matchedIds);
      totalLocationsUpdated += matchedIds.length;
    }

    records.push({
      franchiseId: entry.franchiseId,
      name: entry.name,
      isCorporate: isCorp,
      locationCount: entry.locationCount,
      matchedLocationCount: matchedIds.length,
      unmatchedNames: unmatched,
    });
  }

  return { syncedAt, franchises: records, totalLocationsUpdated };
}

export type FranchiseRow = {
  franchiseId: string;
  name: string;
  isCorporate: boolean;
  locationCount: number;
  syncedAt: string;
};

export function listFranchises(teamId: string): FranchiseRow[] {
  const { db } = initializeDatabase(teamId);
  const rows = db.select().from(schema.franchises).where(eq(schema.franchises.teamId, teamId)).all() as schema.Franchise[];
  return rows
    .map((r): FranchiseRow => ({
      franchiseId: r.franchiseId,
      name: r.name,
      isCorporate: !!r.isCorporate,
      locationCount: r.locationCount ?? 0,
      syncedAt: r.syncedAt,
    }))
    .sort((a: FranchiseRow, b: FranchiseRow) => {
      if (a.isCorporate !== b.isCorporate) return a.isCorporate ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}
