#!/usr/bin/env tsx
/**
 * YOT plugin — flat-file backup and restore (ticket 0114).
 *
 * Usage:
 *   # backup every resource for a team
 *   npx tsx scripts/backup-and-restore.ts backup --team hmx-marketing-team [--out <dir>] [--keep-last N]
 *
 *   # restore a brand-new DB from an NDJSON dump
 *   npx tsx scripts/backup-and-restore.ts restore --team hmx-marketing-team --from <dir> [--to <dbFile>] [--force]
 *
 * Defaults:
 *   - Live DB path:  ~/.openclaw/kitchen/plugins/yot/yot-<team>.db
 *   - Backups root:  ~/.openclaw/kitchen/plugins/yot/backups/<team>/
 *   - Each run lands in backups/<team>/<UTC-timestamp>/<resource>.ndjson
 *   - Retention (--keep-last N) defaults to 7; older runs are pruned after a
 *     successful backup.
 *
 * Restore semantics:
 *   - Never overwrites a non-empty existing DB unless --force is passed.
 *   - Applies the shipped migrations (db/migrations/*.sql) to the new DB,
 *     then replays each resource's NDJSON into its table.
 *
 * Hard rule: this script should NOT be pointed at a DB that's currently being
 * written to. For hmx-marketing-team this means: run only when the bulk
 * ingest is idle.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, createReadStream, createWriteStream } from 'fs';
import { join, dirname, basename, resolve as resolvePath } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

// ---------------------------------------------------------------------------
// Types + config
// ---------------------------------------------------------------------------

type ResourceSpec = {
  name: string;         // table name
  teamScoped: boolean;  // whether to scope SELECT by team_id (all resources currently are)
};

const RESOURCES: ResourceSpec[] = [
  { name: 'plugin_config', teamScoped: true },
  { name: 'clients', teamScoped: true },
  { name: 'locations', teamScoped: true },
  { name: 'stylists', teamScoped: true },
  { name: 'appointments', teamScoped: true },
  { name: 'services', teamScoped: true },
  { name: 'promotions', teamScoped: true },
  { name: 'promotion_usage', teamScoped: true },
  { name: 'revenue_facts', teamScoped: true },
  { name: 'sync_state', teamScoped: true },
  { name: 'sync_runs', teamScoped: true },
];

const DEFAULT_KEEP_LAST = 7;

function pluginRoot(): string {
  return join(homedir(), '.openclaw', 'kitchen', 'plugins', 'yot');
}
function liveDbPath(team: string): string {
  return join(pluginRoot(), `yot-${team}.db`);
}
function backupsRoot(team: string): string {
  return join(pluginRoot(), 'backups', team);
}
function utcStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

type Args = { _: string[]; [k: string]: string | boolean | string[] };

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(tok);
    }
  }
  return args;
}

function must(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v) throw new Error(`missing required --${key}`);
  return v;
}

// ---------------------------------------------------------------------------
// Lazy require for better-sqlite3 so the script can be typechecked without it
// ---------------------------------------------------------------------------

function openSqlite(path: string): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  return new Database(path);
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

async function doBackup(args: Args): Promise<void> {
  const team = must(args, 'team');
  const src = typeof args.src === 'string' ? args.src : liveDbPath(team);
  const outBase = typeof args.out === 'string' ? args.out : backupsRoot(team);
  const keepLast = parseInt(String(args['keep-last'] ?? DEFAULT_KEEP_LAST), 10) || DEFAULT_KEEP_LAST;

  if (!existsSync(src)) {
    throw new Error(`source DB does not exist: ${src}`);
  }

  const stamp = utcStamp();
  const outDir = join(outBase, stamp);
  mkdirSync(outDir, { recursive: true });

  const sqlite = openSqlite(src);
  sqlite.pragma('journal_mode = WAL');

  const manifest: Array<{ resource: string; file: string; rows: number }> = [];

  // Discover which tables actually exist in this DB — older DBs may not have
  // the slice-B tables yet. Missing tables produce an empty NDJSON file so
  // restore is still deterministic.
  const existingTables = new Set<string>(
    sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r: any) => r.name as string)
  );

  for (const res of RESOURCES) {
    const file = join(outDir, `${res.name}.ndjson`);
    let rows: any[] = [];
    if (existingTables.has(res.name)) {
      try {
        rows = res.teamScoped
          ? sqlite.prepare(`SELECT * FROM "${res.name}" WHERE team_id = ?`).all(team)
          : sqlite.prepare(`SELECT * FROM "${res.name}"`).all();
      } catch (err: any) {
        // e.g. table exists but team_id column doesn't — unlikely but be safe.
        process.stderr.write(`warn: read ${res.name}: ${err?.message || err}\n`);
        rows = [];
      }
    }
    const stream = createWriteStream(file, { encoding: 'utf8' });
    for (const row of rows) stream.write(`${JSON.stringify(row)}\n`);
    await new Promise<void>((done, fail) => { stream.end((err?: any) => (err ? fail(err) : done())); });
    manifest.push({ resource: res.name, file: basename(file), rows: rows.length });
  }

  const meta = {
    team,
    createdAt: new Date().toISOString(),
    sourceDb: src,
    schemaVersion: (() => {
      try {
        const row: any = sqlite.prepare('SELECT name FROM __yot_migrations ORDER BY name DESC LIMIT 1').get();
        return row?.name ?? null;
      } catch { return null; }
    })(),
    resources: manifest,
  };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  sqlite.close();

  // Retention
  pruneOldBackups(outBase, keepLast);

  process.stdout.write(`ok: backup complete -> ${outDir}\n`);
  for (const m of manifest) process.stdout.write(`  ${m.resource}: ${m.rows} rows\n`);
}

function pruneOldBackups(base: string, keepLast: number): void {
  if (!existsSync(base)) return;
  const entries = readdirSync(base)
    .filter((name) => {
      try { return statSync(join(base, name)).isDirectory(); } catch { return false; }
    })
    .sort(); // ISO-like stamps sort chronologically
  const toPrune = entries.slice(0, Math.max(0, entries.length - keepLast));
  for (const name of toPrune) {
    const full = join(base, name);
    try {
      rmSync(full, { recursive: true, force: true });
      process.stdout.write(`pruned old backup: ${full}\n`);
    } catch (err: any) {
      process.stderr.write(`warn: failed to prune ${full}: ${err?.message || err}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

async function doRestore(args: Args): Promise<void> {
  const team = must(args, 'team');
  const from = must(args, 'from');
  const toPath = typeof args.to === 'string' ? args.to : join(pluginRoot(), `yot-${team}.restored.db`);
  const force = Boolean(args.force);

  if (!existsSync(from)) throw new Error(`backup dir not found: ${from}`);
  const manifestPath = join(from, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json missing in ${from} — cannot verify backup integrity`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.team && manifest.team !== team) {
    throw new Error(`backup is for team=${manifest.team}, refusing to restore into team=${team}`);
  }

  // Refuse to overwrite a non-empty DB without --force
  if (existsSync(toPath)) {
    const size = statSync(toPath).size;
    if (size > 0 && !force) {
      throw new Error(`refusing to overwrite existing non-empty DB at ${toPath} (use --force to override)`);
    }
    if (force) {
      rmSync(toPath, { force: true });
    }
  }
  mkdirSync(dirname(toPath), { recursive: true });

  // Apply migrations to the fresh DB so schema exists.
  const sqlite = openSqlite(toPath);
  sqlite.pragma('journal_mode = WAL');
  applyMigrationsTo(sqlite);

  // Replay each resource's NDJSON
  const resourceFiles = (manifest.resources || []) as Array<{ resource: string; file: string; rows: number }>;
  for (const entry of resourceFiles) {
    const ndjsonPath = join(from, entry.file);
    if (!existsSync(ndjsonPath)) {
      process.stderr.write(`warn: missing ${ndjsonPath}, skipping ${entry.resource}\n`);
      continue;
    }
    const rows = await readNdjson(ndjsonPath);
    if (!rows.length) {
      process.stdout.write(`${entry.resource}: 0 rows\n`);
      continue;
    }
    // Derive column set from first row; use INSERT OR REPLACE to be idempotent
    // even if --force on a partially-populated DB.
    const cols = Object.keys(rows[0]!);
    const placeholders = cols.map(() => '?').join(', ');
    const colList = cols.map((c) => `"${c}"`).join(', ');
    const stmt = sqlite.prepare(`INSERT OR REPLACE INTO "${entry.resource}" (${colList}) VALUES (${placeholders})`);
    const tx = sqlite.transaction((items: any[]) => {
      for (const item of items) {
        const values = cols.map((c) => (item as any)[c] ?? null);
        stmt.run(...values);
      }
    });
    try {
      tx(rows);
      process.stdout.write(`${entry.resource}: ${rows.length} rows restored\n`);
    } catch (err: any) {
      throw new Error(`restore failed on ${entry.resource}: ${err?.message || err}`);
    }
  }

  sqlite.close();
  process.stdout.write(`ok: restore complete -> ${toPath}\n`);
}

async function readNdjson(path: string): Promise<any[]> {
  const rows: any[] = [];
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); }
    catch (err: any) {
      throw new Error(`bad NDJSON line in ${path}: ${err?.message || err}`);
    }
  }
  return rows;
}

function applyMigrationsTo(sqlite: any): void {
  const migrationsDir = findMigrationsDir();
  if (!migrationsDir) throw new Error('could not locate db/migrations/');

  sqlite.exec(`CREATE TABLE IF NOT EXISTS __yot_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);

  const applied = new Set<string>(
    sqlite.prepare('SELECT name FROM __yot_migrations').all().map((r: any) => r.name as string)
  );
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const raw = readFileSync(join(migrationsDir, file), 'utf8');
    const sql = raw.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      try { sqlite.exec(stmt + ';'); }
      catch (err: any) {
        if (!String(err?.message || '').match(/already exists|duplicate column/i)) throw err;
      }
    }
    sqlite.prepare('INSERT INTO __yot_migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
  }
}

function findMigrationsDir(): string | null {
  // script lives at <repo>/scripts/backup-and-restore.ts
  // migrations live at <repo>/db/migrations
  const here = __dirname;
  const candidates = [
    resolvePath(here, '..', 'db', 'migrations'),
    resolvePath(here, '..', '..', 'db', 'migrations'),
    resolvePath(process.cwd(), 'db', 'migrations'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [cmd] = args._;
  if (!cmd || cmd === 'help' || args.help) {
    process.stdout.write(`Usage:
  npx tsx scripts/backup-and-restore.ts backup  --team <team> [--out <dir>] [--keep-last N] [--src <dbFile>]
  npx tsx scripts/backup-and-restore.ts restore --team <team> --from <dir> [--to <dbFile>] [--force]
`);
    return;
  }
  if (cmd === 'backup') return doBackup(args);
  if (cmd === 'restore') return doRestore(args);
  throw new Error(`unknown command: ${cmd}`);
}

main().catch((err) => {
  process.stderr.write(`error: ${err?.message || err}\n`);
  process.exit(1);
});
