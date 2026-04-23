# @jiggai/kitchen-plugin-yot

ClawKitchen plugin that wraps the **You're On Time** CRM API (https://api2.youreontime.com) so HMX team workflows and dashboards can consume real CRM data without the dashboard holding credentials or direct API access.

## Why

The Hair Mechanix dashboard is a lightweight front end. Every external integration lives in a ClawKitchen plugin so:

- API credentials are per-team and server-side (never in the browser or dashboard runtime)
- Data can be cached locally in the plugin DB for fast dashboard reads
- Marketing workflows and team agents can read the same CRM data the dashboard does
- Each team gets its own YOT-local database file using the existing pattern `~/.openclaw/kitchen/plugins/yot/yot-<teamId>.db`

## Architecture

- **Source of truth:** You're On Time — all data ultimately belongs there
- **Local cache (SQLite):** `clients`, `locations`, `appointments`, `sync_state`, `sync_runs`
- **Config:** per-team API key stored in that team's YOT plugin DB under `plugin_config` (key: `yot`, value: `{ apiKey, baseUrl? }`)
- **Pull model:** dashboard hits `/api/plugins/yot/<resource>`, plugin serves from cache, periodic/manual sync refreshes from YOT
- **Exports:** flat-file JSON export snapshots can be written under `~/.openclaw/kitchen/plugins/yot/exports/<teamId>/...`

## HTTP surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/ping` | Check whether YOT is configured and whether the stored key validates |
| GET | `/health` | Return cache counts, sync state, and team-scoped DB info |
| GET | `/config` | Read stored YOT config from the team's YOT DB |
| POST | `/config` | Save YOT config (`{ yot: { apiKey, baseUrl? } }`) |
| GET | `/business` | Fetch live business/account metadata from YOT |
| GET | `/locations` | Read cached locations with search/active filters |
| POST | `/locations/sync` | Pull and cache live locations from YOT |
| GET | `/clients` | Read cached clients with paging and filters |
| GET | `/clients/:id` | Read a single cached client |
| POST | `/clients/sync` | Pull and cache live clients from YOT |
| GET | `/clients/paging-characterization` | Probe page sizes / empty-page behavior against the live YOT API |
| GET | `/sync-state` | Read aggregate sync status by resource |
| GET | `/sync-runs` | Read recent sync run history |
| POST | `/export` | Write a flat-file JSON snapshot of the local cache |

## Current status

Implemented now:
- team-local YOT DB usage
- config read/write
- cached health, clients, locations, sync state, sync runs
- client/location sync bookkeeping
- paging characterization endpoint
- local export snapshot endpoint

Still to come in later slices:
- appointments sync/read expansion
- stylist/revenue/promotion summary tables
- dashboard tabs/views inside this plugin

## Install

```bash
npm install
npm run build
# Install via Kitchen CLI or symlink dist/ into the Kitchen plugin directory
```

## References

- API spec: https://api2.youreontime.com/index.html
- Example integration: https://bitbucket.org/youreontime/youreontime-api-example/src/master/app.js
