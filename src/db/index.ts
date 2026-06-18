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

  // Refuse to silently bootstrap a missing DB. better-sqlite3's default is to
  // create the file if it doesn't exist, which masks an upstream problem (the
  // file got deleted, renamed, or path-mismatched) and silently strands the
  // team on an empty cache. Fail loud instead; require an explicit opt-in for
  // legitimate first-time setup.
  if (!existsSync(dbFile) && process.env.YOT_ALLOW_DB_AUTOCREATE !== '1') {
    throw new Error(
      `kitchen-plugin-yot DB missing at ${dbFile}. ` +
        `Refusing to auto-create — this usually means data was lost or the path is wrong. ` +
        `If this is intentional first-time setup, re-run with YOT_ALLOW_DB_AUTOCREATE=1.`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require('drizzle-orm/better-sqlite3');

  const sqlite = new Database(dbFile);
  // Durability + concurrency pragmas. Without busy_timeout, concurrent writers
  // (the gateway + out-of-process sync scripts) fail fast with SQLITE_BUSY;
  // with WAL + synchronous=NORMAL we keep crash-safety while staying fast.
  // These are cheap and idempotent per connection.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
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

// Cache connections on globalThis, not a module-local Map. The kitchen gateway
// re-evaluates this module per request/plugin-load, which gives each evaluation
// a fresh module-local Map — so a plain `const connections = new Map()` never
// actually reuses a connection and the process leaks ~2 SQLite handles/request
// (observed: ~1000 open handles to one WAL db, which contributed to a DB
// corruption when the gateway was restarted mid-write). A process-global cache
// survives module re-evaluation, so a given process holds ONE connection/team.
const GLOBAL_KEY = '__yotDbConnections__';
const g = globalThis as any;
const connections: Map<string, { db: any; sqlite: any }> = g[GLOBAL_KEY] || (g[GLOBAL_KEY] = new Map());

export function initializeDatabase(teamId: string) {
  const cached = connections.get(teamId);
  if (cached) return cached;
  const { db, sqlite } = createDatabase(teamId);
  runMigrations(sqlite);
  const entry = { db, sqlite };
  connections.set(teamId, entry);
  return entry;
}

/**
 * Close and forget a team's cached connection. Short-lived scripts (e.g. the
 * out-of-process clients sync) call this on exit so they checkpoint the WAL and
 * release the file cleanly rather than leaving a connection dangling.
 */
export function closeDatabase(teamId: string) {
  const cached = connections.get(teamId);
  if (!cached) return;
  try { cached.sqlite.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  try { cached.sqlite.close(); } catch {}
  connections.delete(teamId);
}

export type DatabaseConnection = ReturnType<typeof initializeDatabase>;
