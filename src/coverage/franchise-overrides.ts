import type Database from 'better-sqlite3';

type SqliteDb = Pick<Database.Database, 'prepare'>;

export type FranchiseOwnershipRow = {
  locationId: string;
  locationName: string;
  active: boolean;
  yotFranchiseId: string | null;
  yotFranchiseName: string | null;
  effectiveFranchiseId: string | null;
  effectiveFranchiseName: string | null;
  override: null | {
    franchiseId: string;
    franchiseName: string;
    note: string | null;
    updatedBy: string | null;
    createdAt: string;
    updatedAt: string;
  };
};

/** Apply every local override after the raw YOT roster has been stamped. */
export function applyFranchiseOwnershipOverrides(sqlite: SqliteDb, teamId: string): number {
  // Keep the display name current when YOT renames an existing owner group,
  // while retaining the stored name if that owner is temporarily absent.
  sqlite.prepare(`
    UPDATE franchise_ownership_overrides
       SET franchise_name = (
             SELECT f.name FROM franchises f
              WHERE f.team_id = franchise_ownership_overrides.team_id
                AND f.franchise_id = franchise_ownership_overrides.franchise_id
           )
     WHERE team_id = ?
       AND EXISTS (
             SELECT 1 FROM franchises f
              WHERE f.team_id = franchise_ownership_overrides.team_id
                AND f.franchise_id = franchise_ownership_overrides.franchise_id
           )
  `).run(teamId);
  const result = sqlite.prepare(`
    UPDATE locations
       SET franchise_id = (
             SELECT o.franchise_id
               FROM franchise_ownership_overrides o
              WHERE o.team_id = locations.team_id AND o.location_id = locations.id
           ),
           franchise_name = (
             SELECT o.franchise_name
               FROM franchise_ownership_overrides o
              WHERE o.team_id = locations.team_id AND o.location_id = locations.id
           )
     WHERE team_id = ?
       AND EXISTS (
             SELECT 1
               FROM franchise_ownership_overrides o
              WHERE o.team_id = locations.team_id AND o.location_id = locations.id
           )
  `).run(teamId) as { changes?: number };
  return Number(result?.changes || 0);
}

export function listFranchiseOwnership(sqlite: SqliteDb, teamId: string): FranchiseOwnershipRow[] {
  const rows = sqlite.prepare(`
    SELECT l.id AS locationId,
           COALESCE(l.name, l.id) AS locationName,
           COALESCE(l.active, 0) AS active,
           l.yot_franchise_id AS yotFranchiseId,
           l.yot_franchise_name AS yotFranchiseName,
           l.franchise_id AS effectiveFranchiseId,
           l.franchise_name AS effectiveFranchiseName,
           o.franchise_id AS overrideFranchiseId,
           o.franchise_name AS overrideFranchiseName,
           o.note AS overrideNote,
           o.updated_by AS overrideUpdatedBy,
           o.created_at AS overrideCreatedAt,
           o.updated_at AS overrideUpdatedAt
      FROM locations l
      LEFT JOIN franchise_ownership_overrides o
        ON o.team_id = l.team_id AND o.location_id = l.id
     WHERE l.team_id = ?
     ORDER BY COALESCE(l.active, 0) DESC, lower(COALESCE(l.name, l.id))
  `).all(teamId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    locationId: String(row.locationId),
    locationName: String(row.locationName),
    active: !!row.active,
    yotFranchiseId: row.yotFranchiseId == null ? null : String(row.yotFranchiseId),
    yotFranchiseName: row.yotFranchiseName == null ? null : String(row.yotFranchiseName),
    effectiveFranchiseId: row.effectiveFranchiseId == null ? null : String(row.effectiveFranchiseId),
    effectiveFranchiseName: row.effectiveFranchiseName == null ? null : String(row.effectiveFranchiseName),
    override: row.overrideFranchiseId == null ? null : {
      franchiseId: String(row.overrideFranchiseId),
      franchiseName: String(row.overrideFranchiseName),
      note: row.overrideNote == null ? null : String(row.overrideNote),
      updatedBy: row.overrideUpdatedBy == null ? null : String(row.overrideUpdatedBy),
      createdAt: String(row.overrideCreatedAt),
      updatedAt: String(row.overrideUpdatedAt),
    },
  }));
}

export function upsertFranchiseOwnershipOverride(
  sqlite: SqliteDb,
  teamId: string,
  locationId: string,
  franchiseId: string,
  note?: string | null,
  updatedBy?: string | null,
): FranchiseOwnershipRow {
  const location = sqlite.prepare(
    'SELECT id FROM locations WHERE team_id = ? AND id = ?',
  ).get(teamId, locationId) as { id?: string } | undefined;
  if (!location) throw new Error('LOCATION_NOT_FOUND');

  const franchise = sqlite.prepare(
    'SELECT franchise_id AS franchiseId, name FROM franchises WHERE team_id = ? AND franchise_id = ?',
  ).get(teamId, franchiseId) as { franchiseId?: string; name?: string } | undefined;
  if (!franchise?.franchiseId || !franchise?.name) throw new Error('FRANCHISE_NOT_FOUND');

  const now = new Date().toISOString();
  sqlite.prepare(`
    INSERT INTO franchise_ownership_overrides
      (team_id, location_id, franchise_id, franchise_name, note, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(team_id, location_id) DO UPDATE SET
      franchise_id = excluded.franchise_id,
      franchise_name = excluded.franchise_name,
      note = excluded.note,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `).run(
    teamId, locationId, franchiseId, franchise.name, note?.trim() || null,
    updatedBy?.trim() || null, updatedBy?.trim() || null, now, now,
  );

  sqlite.prepare(
    'UPDATE locations SET franchise_id = ?, franchise_name = ? WHERE team_id = ? AND id = ?',
  ).run(franchiseId, franchise.name, teamId, locationId);

  return listFranchiseOwnership(sqlite, teamId).find((row) => row.locationId === locationId)!;
}

export function deleteFranchiseOwnershipOverride(sqlite: SqliteDb, teamId: string, locationId: string): boolean {
  const result = sqlite.prepare(
    'DELETE FROM franchise_ownership_overrides WHERE team_id = ? AND location_id = ?',
  ).run(teamId, locationId) as { changes?: number };
  if (!result?.changes) return false;

  // Removing an override immediately restores the last raw YOT assignment.
  sqlite.prepare(`
    UPDATE locations
       SET franchise_id = yot_franchise_id,
           franchise_name = yot_franchise_name
     WHERE team_id = ? AND id = ?
  `).run(teamId, locationId);
  return true;
}
