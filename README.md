# @jiggai/kitchen-plugin-yot

ClawKitchen plugin that wraps the **You're On Time** CRM API (https://api2.youreontime.com) so HMX team workflows and dashboards can consume real CRM data without the dashboard holding credentials or direct API access.

## Why

The Hair Mechanix dashboard is a lightweight front end. Every external integration lives in a ClawKitchen plugin so:

- API credentials are per-team and server-side (never in the browser or dashboard runtime)
- Data can be cached locally in the plugin DB for fast dashboard reads
- Marketing workflows and team agents can read the same CRM data the dashboard does

## Architecture

- **Source of truth:** You're On Time — all data ultimately belongs there
- **Local cache (SQLite):** `clients`, `appointments`, `sync_state` tables in the plugin DB
- **Config:** per-team API key stored in `plugin_config` (key: `yot`, value: `{ apiKey }`)
- **Pull model:** dashboard hits `/api/plugins/yot/<resource>`, plugin serves from cache, periodic sync job refreshes

## HTTP surface (planned)

| Method | Path | Purpose |
|---|---|---|
| GET | `/config` | Read stored YOT config |
| POST | `/config` | Save YOT config (`{ yot: { apiKey } }`) |
| GET | `/clients` | Cached client list |
| POST | `/clients/sync` | Trigger full client sync from YOT |
| GET | `/appointments` | Cached appointments (TBD) |
| POST | `/appointments/sync` | Trigger appointment sync (TBD) |
| GET | `/ping` | Health |

Only `/ping`, `/config`, and minimal `/clients` scaffolding are wired in the initial skeleton — the rest expand as the integration grows.

## Install

```bash
npm install
npm run build
# Install via Kitchen CLI or symlink dist/ into the Kitchen plugin directory
```

## References

- API spec: https://api2.youreontime.com/index.html
- Example integration: https://bitbucket.org/youreontime/youreontime-api-example/src/master/app.js
