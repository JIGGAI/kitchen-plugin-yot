import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import * as schema from './schema';

/**
 * Find `db/migrations/` relative to the bundled output. After esbuild bundling,
 * __dirname can be `dist/`, `dist/api/`, or (unbundled) `dist/db/` depending on
 * which entry point is executing. Walk up to 6 levels looking for the
 * migrations directory so this works regardless of build layout.
 */
function resolveMigrationsDir(startDir: string): string | null {
  let cur = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(cur, 'db', 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function createDatabase(teamId: string) {
  const dbDir = join(homedir(), '.openclaw', 'kitchen', 'plugins', 'yot');
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  const dbFile = join(dbDir, `yot-${teamId}.db`);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require('drizzle-orm/better-sqlite3');

  const sqlite = new Database(dbFile);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

/**
 * Apply any migration files not yet applied, using a lightweight runner.
 * We don't rely on drizzle-kit's journal because this plugin needs to install
 * from dist/ without shipping drizzle metadata.
 */
function runMigrations(sqlite: any) {
  const migrationsDir = resolveMigrationsDir(__dirname);
  if (!migrationsDir) return;

  sqlite.exec(`CREATE TABLE IF NOT EXISTS __yot_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);

  const applied = new Set<string>(
    sqlite.prepare('SELECT name FROM __yot_migrations').all().map((r: any) => r.name as string)
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const raw = readFileSync(join(migrationsDir, file), 'utf8');
    // Strip SQL comments before splitting so a `;` inside `-- comment` text
    // doesn't create bogus statements.
    const sql = raw
      .replace(/--[^\n]*/g, '')      // line comments
      .replace(/\/\*[\s\S]*?\*\//g, ''); // block comments
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      try { sqlite.exec(stmt + ';'); }
      catch (err: any) {
        // IF NOT EXISTS collisions are benign
        if (!String(err?.message || '').match(/already exists/i)) throw err;
      }
    }
    sqlite.prepare('INSERT INTO __yot_migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
  }
}

const connections = new Map<string, { db: any; sqlite: any }>();

export function initializeDatabase(teamId: string) {
  const cached = connections.get(teamId);
  if (cached) return cached;
  const { db, sqlite } = createDatabase(teamId);
  runMigrations(sqlite);
  const entry = { db, sqlite };
  connections.set(teamId, entry);
  return entry;
}

export type DatabaseConnection = ReturnType<typeof initializeDatabase>;
