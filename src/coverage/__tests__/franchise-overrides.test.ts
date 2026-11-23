import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  applyFranchiseOwnershipOverrides,
  deleteFranchiseOwnershipOverride,
  listFranchiseOwnership,
  upsertFranchiseOwnershipOverride,
} from '../franchise-overrides';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE locations (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT, active INTEGER,
      franchise_id TEXT, franchise_name TEXT,
      yot_franchise_id TEXT, yot_franchise_name TEXT
    );
    CREATE TABLE franchises (
      team_id TEXT NOT NULL, franchise_id TEXT NOT NULL, name TEXT NOT NULL,
      PRIMARY KEY (team_id, franchise_id)
    );
    CREATE TABLE franchise_ownership_overrides (
      team_id TEXT NOT NULL, location_id TEXT NOT NULL, franchise_id TEXT NOT NULL,
      franchise_name TEXT NOT NULL, note TEXT, created_by TEXT, updated_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (team_id, location_id)
    );
    INSERT INTO franchises VALUES ('hmx', '1', 'Hair MX'), ('hmx', '77', 'Terry');
    INSERT INTO locations VALUES ('8198', 'hmx', 'Morgantown WV', 1, '1', 'Hair MX', '1', 'Hair MX');
  `);
  return db;
}

describe('franchise ownership overrides', () => {
  it('persists an override and reapplies it after a YOT sync', () => {
    const db = fixture();
    upsertFranchiseOwnershipOverride(db, 'hmx', '8198', '77', 'Confirmed billing owner');

    db.prepare(`UPDATE locations SET franchise_id = '1', franchise_name = 'Hair MX',
      yot_franchise_id = '1', yot_franchise_name = 'Hair MX' WHERE id = '8198'`).run();
    expect(applyFranchiseOwnershipOverrides(db, 'hmx')).toBe(1);

    const row = listFranchiseOwnership(db, 'hmx')[0];
    expect(row.yotFranchiseName).toBe('Hair MX');
    expect(row.effectiveFranchiseName).toBe('Terry');
    expect(row.override?.note).toBe('Confirmed billing owner');
  });

  it('restores the latest raw YOT owner when an override is removed', () => {
    const db = fixture();
    upsertFranchiseOwnershipOverride(db, 'hmx', '8198', '77');
    db.prepare(`UPDATE locations SET yot_franchise_id = '77', yot_franchise_name = 'Terry' WHERE id = '8198'`).run();

    expect(deleteFranchiseOwnershipOverride(db, 'hmx', '8198')).toBe(true);
    const row = listFranchiseOwnership(db, 'hmx')[0];
    expect(row.override).toBeNull();
    expect(row.effectiveFranchiseName).toBe('Terry');
  });
});
