# 0114 — YOT slice B: local schema and backups

Companion doc for ticket 0114. Ships the durable local schema for the full
YOT data platform (clients, locations, stylists, appointments/revenue,
promotions) plus a flat-file backup/restore path.

> **Scope note.** This slice is schema-only. Actual ingestion of stylists,
> appointments, services, and promotions lands in slices D / F (see ticket
> 0119). The `appointments` shape here is intentionally provisional — once
> 0119 characterizes the real YOT payload, we may need a follow-up migration
> to tune types, nullability, or add columns.

---

## Tables and keys

Every domain table is team-partitioned via a `team_id TEXT NOT NULL` column.
IDs are stored as `TEXT` for forward-compat with YOT's mixed numeric/string
identifiers. Foreign keys are soft (no `FOREIGN KEY` constraints) because
ingestion order across resources can be out-of-order and SQLite's enforcement
rules would block otherwise legitimate upserts.

### `plugin_config`
| column | type | notes |
|---|---|---|
| team_id | TEXT | PK part |
| key | TEXT | PK part (e.g. `yot`) |
| value | TEXT | JSON-encoded blob |
| updated_at | TEXT | ISO timestamp |

### `clients` (from 0001 + 0002)
Already rich (identity, contact, address, `last_visit_at`, `total_visits`,
`total_spend`, `source_location_id`, `raw`). Indexed on `(team_id)`,
`(team_id, email)`, `(team_id, private_id)`, `(team_id, active)`,
`(team_id, full_name)`, `(team_id, mobile_phone)`, `(team_id, email_address)`,
`(team_id, source_location_id)`, `(team_id, last_visit_at)`.

### `locations` (from 0002)
Standard location identity + address + status + contact. Indexed on
`(team_id)`, `(team_id, active)`, `(team_id, name)`.

### `stylists` (new in 0003)
| column | type | notes |
|---|---|---|
| id | TEXT | PK — YOT stylist id |
| team_id | TEXT | |
| location_id | TEXT | soft FK → `locations.id` (primary location) |
| private_id | TEXT | YOT private identifier |
| given_name / surname / full_name | TEXT | |
| email_address / mobile_phone | TEXT | |
| active | INTEGER (boolean) | |
| source_location_id | TEXT | location used to fetch the roster |
| raw | TEXT | full YOT payload |
| synced_at | TEXT | ISO |

Indexes: `(team_id)`, `(team_id, location_id)`, `(team_id, active)`,
`(team_id, full_name)`.

### `appointments` (0001 + additive 0003)
Legacy columns from 0001 remain for back-compat:
`staff_id`, `starts_at`, `ends_at`, `total`.

0003 adds:

| column | type | notes |
|---|---|---|
| stylist_id | TEXT | soft FK → `stylists.id` (preferred over `staff_id`) |
| start_at / end_at | TEXT | ISO (preferred over `starts_at` / `ends_at`) |
| gross_amount / discount_amount / net_amount | REAL | revenue breakdown |
| created_at_remote / updated_at_remote | TEXT | YOT audit timestamps |

Indexes: `(team_id)`, `(team_id, location_id, start_at)`,
`(team_id, stylist_id, start_at)`, `(team_id, client_id)`,
`(team_id, start_at)`. The legacy `(team_id, starts_at)` and `(client_id)`
indexes from 0001 remain in place for existing queries.

### `services` (new in 0003)
| column | type | notes |
|---|---|---|
| id | TEXT | PK |
| team_id | TEXT | |
| location_id | TEXT | nullable — YOT catalog is often global per team |
| name | TEXT | |
| duration_minutes | INTEGER | |
| price | REAL | |
| active | INTEGER (boolean) | |
| raw | TEXT | |
| synced_at | TEXT | |

Indexes: `(team_id)`, `(team_id, location_id)`.

### `promotions` (new in 0003)
| column | type | notes |
|---|---|---|
| id | TEXT | PK |
| team_id | TEXT | |
| code / name | TEXT | |
| start_at / end_at | TEXT | ISO |
| discount_type | TEXT | e.g. `percent`, `amount` |
| discount_value | REAL | |
| location_id | TEXT | nullable — global if null |
| active | INTEGER (boolean) | |
| raw | TEXT | |
| synced_at | TEXT | |

Indexes: `(team_id)`, `(team_id, active)`, `(team_id, code)`.

### `promotion_usage` (new in 0003)
| column | type | notes |
|---|---|---|
| id | TEXT | PK |
| team_id | TEXT | |
| promotion_id | TEXT | soft FK → `promotions.id` |
| location_id | TEXT | |
| appointment_id | TEXT | nullable |
| client_id | TEXT | nullable |
| used_at | TEXT | ISO |
| discount_amount | REAL | |
| raw | TEXT | |
| synced_at | TEXT | |

Indexes: `(team_id)`, `(team_id, promotion_id, used_at)`,
`(team_id, location_id, used_at)`.

### `revenue_facts` (new in 0003, rollup)
Compact daily rollup, keyed on `(team_id, location_id, date)`. Always
derivable from `appointments` + `promotion_usage`; this table is the fast
path for dashboard summaries.

| column | type | notes |
|---|---|---|
| team_id | TEXT | PK part |
| location_id | TEXT | PK part |
| date | TEXT | PK part — `YYYY-MM-DD` local to location |
| gross_amount / discount_amount / net_amount | REAL | |
| appointment_count | INTEGER | |
| unique_client_count | INTEGER | |
| last_updated_at | TEXT | ISO |

Indexes: `(team_id, date)`, `(team_id, location_id)`.

### `sync_state`
Unchanged shape; `(team_id, resource)` primary key accommodates the new
resources (`stylists`, `appointments`, `services`, `promotions`,
`promotion_usage`, `revenue_facts`) without modification. The canonical list
of resource names lives in `src/db/schema.ts` as `SYNC_RESOURCES`.

### `sync_runs`
Unchanged. One row per sync execution for audit.

### `__yot_migrations`
Created and managed by `src/db/index.ts`'s custom runner. One row per applied
`.sql` file; the highest `name` sorted ascending is our `schema_version` for
`/health` purposes.

---

## Index rationale

| Table | Index | Query shape it supports |
|---|---|---|
| clients | `(team_id, full_name)` | name prefix search (Clients tab) |
| clients | `(team_id, mobile_phone)` + `(team_id, email_address)` | phone / email lookup |
| clients | `(team_id, source_location_id)` | per-location client lists |
| clients | `(team_id, last_visit_at)` | churn / reactivation windows |
| locations | `(team_id, active)` / `(team_id, name)` | active-only dropdowns, sorted lists |
| stylists | `(team_id, location_id)` | roster per location |
| stylists | `(team_id, active)` / `(team_id, full_name)` | directory search |
| appointments | `(team_id, location_id, start_at)` | per-location daily views |
| appointments | `(team_id, stylist_id, start_at)` | stylist utilization / revenue by stylist |
| appointments | `(team_id, client_id)` | client history |
| appointments | `(team_id, start_at)` | team-wide windowed queries |
| services | `(team_id, location_id)` | per-location menu |
| promotions | `(team_id, active)` / `(team_id, code)` | current promos, lookup by code |
| promotion_usage | `(team_id, promotion_id, used_at)` | per-promo usage timeline |
| promotion_usage | `(team_id, location_id, used_at)` | per-location promo impact |
| revenue_facts | `(team_id, date)` | team-wide daily rollups |
| revenue_facts | `(team_id, location_id)` | per-location rollup slice |

---

## Backup format

- One directory per run: `~/.openclaw/kitchen/plugins/yot/backups/<team>/<UTC-timestamp>/`
- UTC timestamp matches `new Date().toISOString().replace(/[:.]/g, '-')`
  (e.g. `2026-04-24T05-12-33-512Z`), which sorts chronologically lexically.
- One file per resource, newline-delimited JSON:
  - `plugin_config.ndjson`
  - `clients.ndjson`
  - `locations.ndjson`
  - `stylists.ndjson`
  - `appointments.ndjson`
  - `services.ndjson`
  - `promotions.ndjson`
  - `promotion_usage.ndjson`
  - `revenue_facts.ndjson`
  - `sync_state.ndjson`
  - `sync_runs.ndjson`
- One `manifest.json` with: `team`, `createdAt`, `sourceDb`, `schemaVersion`
  (latest applied migration filename), and a `resources[]` array of
  `{ resource, file, rows }`.

Each NDJSON line is one row, serialized via `JSON.stringify(row)`. No
escaping beyond what JSON already does; SQLite `TEXT`/`REAL`/`INTEGER` map
cleanly to JSON primitives.

Missing tables (e.g. a pre-0003 DB that doesn't yet have `stylists`)
produce an empty NDJSON file rather than erroring — restore is still
deterministic.

---

## Backup command

```sh
npx tsx scripts/backup-and-restore.ts backup \
  --team hmx-marketing-team \
  [--out /custom/path] \
  [--keep-last 7] \
  [--src /path/to/yot-<team>.db]   # defaults to the live plugin DB
```

> **Operational note.** Do NOT run the backup against a DB that is actively
> being written (e.g. while `scripts/bulk-capture-clients.ts` is in flight).
> SQLite WAL makes a crashed read non-fatal, but you can still capture a
> torn view mid-transaction. Run backups when ingestion is idle.

---

## Restore command

```sh
npx tsx scripts/backup-and-restore.ts restore \
  --team hmx-marketing-team \
  --from ~/.openclaw/kitchen/plugins/yot/backups/hmx-marketing-team/<timestamp> \
  [--to /path/to/new.db]   # defaults to yot-<team>.restored.db
  [--force]                # required to overwrite a non-empty target
```

### Restore procedure

1. Verifies `manifest.json` exists in `--from` and its `team` field matches
   `--team` (prevents cross-team restore accidents).
2. Refuses to touch a non-empty `--to` path unless `--force` is passed.
3. Creates a fresh DB at `--to`, applies every migration in
   `db/migrations/` (via the same lightweight runner the plugin uses), then
   replays each resource's NDJSON with `INSERT OR REPLACE`.
4. Records each applied migration in `__yot_migrations` so the restored DB
   reports the correct `schemaVersion` on `/health`.

To make a restored DB the live DB, stop the kitchen plugin process, swap
files (`mv yot-<team>.db yot-<team>.db.bak && mv yot-<team>.restored.db
yot-<team>.db`), then restart the plugin. That step is intentionally manual.

---

## Retention policy

- Default: keep the last **7** runs per team.
- Overridable per invocation with `--keep-last N`.
- Pruning happens at the end of a successful backup; older timestamped
  directories are removed via `rm -rf`.
- Prune failures are warned but non-fatal (we'd rather keep stale backups
  than abort a good one).

---

## `/health` endpoint additions

The `/health` endpoint (`src/api/handler.ts`) now returns:

```jsonc
{
  "ok": true,
  "teamId": "hmx-marketing-team",
  "yotConfigured": true,
  "dbMode": "yot-hmx-marketing-team.db",
  "migrations": {
    "version": "0003_slice_b_schema_expansion.sql",
    "applied": ["0001_initial.sql", "0002_slice1_clients_locations.sql", "0003_slice_b_schema_expansion.sql"]
  },
  "counts": {
    "clients": 12345,
    "locations": 24,
    "stylists": 0,
    "appointments": 0,
    "services": 0,
    "promotions": 0,
    "promotion_usage": 0,
    "revenue_facts": 0
  },
  "lastSuccessByResource": {
    "clients": "2026-04-24T05:00:00Z",
    "locations": "2026-04-23T22:00:00Z",
    "stylists": null,
    "appointments": null,
    "services": null,
    "promotions": null,
    "promotion_usage": null,
    "revenue_facts": null
  },
  "syncState": [ /* raw rows */ ]
}
```

Count and sync-state lookups are wrapped in try/catch so a missing table
(e.g. DB not yet migrated to 0003) degrades gracefully to `0` / `null`
instead of 500ing.

---

## Known gaps / follow-ups

- **`appointments` is provisional.** Schema is modelled against the 0114
  ticket description, not against real YOT payloads. Slice D/F (ticket 0119)
  will characterize the actual fields returned by YOT and may need a 0004
  migration to tighten types, add missing columns, or rename (e.g. merging
  `staff_id` into `stylist_id` once a YOT→local map is known).
- **No FK constraints.** Soft references only — enforce at write time in the
  ingestion layer (slice D/F).
- **Running the migration in prod is a follow-up.** Ticket 0113's bulk
  client ingest is currently using the live DB; 0003 should be applied only
  after that ingest completes, under RJ's supervision.
- **`/health` version-gating.** The ticket's "fail closed if DB migration
  version is behind the running code" item is deferred — the plugin
  currently auto-applies pending migrations on `initializeDatabase`, which
  already narrows that window. A strict version gate can land once we have
  a coordinated deploy + migrate flow.
- **Restore into the live DB file.** Intentionally not supported by the
  script. Swap files manually while the plugin is stopped.
