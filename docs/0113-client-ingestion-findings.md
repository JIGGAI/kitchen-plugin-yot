# 0113 Client Ingestion Findings

Live characterization of YOT `/clients`, `/export/clients`, and `/clients/{id}` endpoints for the Hair Mechanix marketing-team tenant, run against `https://api2.youreontime.com/1/api` from the Mac Studio host on 2026-04-24.

## Summary

- Pagination on `/clients` is the only viable bulk-ingestion path. `/export/clients` is broken on the server, and `/clients/{id}` is not usable for detail hydration.
- The real client universe for this tenant is **much larger than the current cache** — at least `175,000` unique clients are reachable through pagination (pages 5000 and 7000 returned fully disjoint ID sets with no overlap). The existing `125` rows in `yot-hmx-marketing-team.db` are an artifact of a prior `maxPages=5` smoke run, not a real ceiling.
- Page size is **fixed at 25 rows per page** on the server side. Client-provided `limit` and `pageSize` parameters are silently ignored.
- No incremental-sync parameter was observed to work on `/clients`. `modifiedSince` and `updatedSince` returned identical payloads to a no-filter request. Every full sync currently has to be a full walk of all pages.
- No `429` responses were ever observed. The only rate-limit-adjacent signal was the server starting to **time out past page ~7500** (30s no response), most likely a degrading OFFSET-based query rather than an explicit rate limit.

## Observed paging behavior on `/clients`

The probe walked `/clients?page=N` from `page=1` up to the local cap `MAX_BASELINE_PAGES=80` with a 500ms throttle between requests.

- All 80 pages returned `HTTP 200` with exactly `25` rows each.
- No empty page was ever hit in the 80-page window.
- Per-page latency: median ~1.85s, min ~1.70s, max ~3.32s (one outlier at page 52).
- Across those 80 pages, `2000` unique `id` values were observed with `0` duplicates.
- Probe stop reason (in-script): `"Reached MAX_BASELINE_PAGES=80 without an empty page"`.

Follow-up spot probes at higher page numbers (issued via `curl`, ~0.5s apart):

| page  | http | size (bytes) | count | first `id`  |
|-------|------|--------------|-------|-------------|
| 100   | 200  | 9324         | 25    | 6197824     |
| 200   | 200  | 9172         | 25    | 6052247     |
| 300   | 200  | 9243         | 25    | 1036319     |
| 500   | 200  | 9251         | 25    | 5738471     |
| 1000  | 200  | 9104         | 25    | 5015092     |
| 2000  | 200  | 9812         | 25    | 7159287     |
| 3000  | 200  | 9892         | 25    | 4878294     |
| 5000  | 200  | 10003        | 25    | 7211351     |
| 5500  | 200  | 9860         | 25    | (200 ok)    |
| 6000  | 200  | 9812         | 25    | (200 ok)    |
| 6500  | 200  | 9568         | 25    | (200 ok)    |
| 7000  | 200  | 9761         | 25    | 5706530     |
| 8000  | 000  | 0            | err   | `curl: (28) Operation timed out after 30055 ms` |
| 10000 | 000  | 0            | err   | `curl: (28) Operation timed out after 30043 ms` |
| 20000 | 000  | 0            | err   | timeout |
| 50000 | 000  | 0            | err   | timeout |

Cross-page uniqueness check: comparing the 25 IDs returned at `page=5000` against the 25 IDs at `page=7000` gives **zero overlap** — completely disjoint client records, not a page wrap or repeat.

### What this tells us

- The tenant almost certainly has on the order of **~175,000 unique clients** or more. Even a conservative lower bound is `≥7000 × 25 = 175,000` since we have direct evidence of distinct client IDs at page 7000.
- Pagination IS real and stable — not random, not wrapping — at least through page 7000. Past that the server starts timing out rather than returning an empty `[]`, which is consistent with a slow `OFFSET` query on a very large table rather than an authoritative "end of list" signal.
- The `id` column is **not monotonic** across pages. Page 1 began with `6708761`, page 300 began with `1036319`. The server sort is not by `id`, so any heuristic that assumes monotonic ordering (for example, "stop when `id` goes below last-seen max") will break.

### Page size parameter handling

The probe issued `page=1` with `limit=100|500|1000` and `pageSize=100|500|1000`. Every single variant returned `HTTP 200` with exactly `25` rows.

| param     | value | status | rows | inferred honored |
|-----------|-------|--------|------|------------------|
| limit     | 100   | 200    | 25   | false            |
| limit     | 500   | 200    | 25   | false            |
| limit     | 1000  | 200    | 25   | false            |
| pageSize  | 100   | 200    | 25   | false            |
| pageSize  | 500   | 200    | 25   | false            |
| pageSize  | 1000  | 200    | 25   | false            |

**Conclusion:** YOT's `/clients` endpoint has a server-fixed page size of 25. There is no way to enlarge the page. Full-tenant ingestion wall time is therefore bounded below by `(total_pages × (request_time + throttle))`.

For HMX specifically: `~7000 pages × (~2.0s request + 0.5s throttle)` ≈ `~4.9 hours` for a single-threaded full sync.

### `active=true|false` filter handling

Running `/clients?page=1&active=true`, `…&active=false`, and no `active` param, the probe observed:

- All three variants returned 25 rows.
- All three variants returned the **same first three IDs** (`6708761`, `6721607`, `6721608`).
- Response sizes and latencies were indistinguishable.

**Conclusion:** The `active` query parameter appears to be silently ignored. Any filtering by active/inactive has to happen client-side after ingestion.

### Incremental-sync parameters (`modifiedSince`, `updatedSince`)

Spot-checks issued via `curl`:

- `/clients?page=1&modifiedSince=2026-04-01` → `HTTP 200`, identical first IDs as no-filter.
- `/clients?page=1&updatedSince=2026-04-01` → `HTTP 200`, identical first IDs as no-filter.

**Conclusion:** These parameter names are not honored by this endpoint. A true incremental-sync path was not found in this probe. Either the API does not support it, or the correct parameter name/location (query vs header) is different and undocumented. This is a followup to resolve before we can avoid walking all ~7000 pages on every sync.

## `/1/api/export/clients`

The bundled `docs/youreontime-openapi.json` lists `startDate`, `endDate`, `locationId`, and `encoding` as **optional** query params on `/export/clients`. The live server disagrees.

### Required-params check

`GET /export/clients` (no params) → `HTTP 400 application/problem+json`:

```json
{
  "errors": {
    "endDate":   ["The endDate field is required."],
    "encoding":  ["The encoding field is required."],
    "startDate": ["The startDate field is required."]
  },
  "type":  "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "traceId": "00-f6eb075a56141ac2d69187199b454054-14aa3fce38b94d72-00"
}
```

So `startDate`, `endDate`, and `encoding` are **required** on this tenant, contrary to the spec.

### Date-format check

| startDate / endDate format | http | body snippet |
|----------------------------|------|--------------|
| `2024-01-01`               | 500  | `"Invalid date 2024-01-01"` |
| `01/01/2024`               | 500  | `"Invalid date 01/01/2024"` |
| `2024-01-01T00:00:00Z`     | 500  | `"Invalid date 2024-01-01T00:00:00Z"` |
| `1/1/2024`                 | 500  | `"Invalid date 1/1/2024"` |
| `01-01-2024`               | 500  | `"Invalid date 01-01-2024"` |
| `20240101` (YYYYMMDD)      | 200  | wrapper object (see below) |

Only the undocumented `YYYYMMDD` compact format was accepted.

### `/export/clients` response shape is broken server-side

With all three required params set and a plausible date range (`startDate=20200101&endDate=20260424&encoding=json`), the server returns `HTTP 200` but the body is not the actual export — it is a serialized **`HttpResponseMessage`** object with `Content-Type: application/json`:

```json
{
  "version": "1.1",
  "content": {
    "headers": [
      { "key": "Content-Type",        "value": ["text/csv"] },
      { "key": "Content-Disposition", "value": ["attachment; filename=clients.csv"] }
    ]
  },
  "statusCode": 200,
  "reasonPhrase": "OK",
  "headers": [],
  "trailingHeaders": [],
  "requestMessage": null,
  "isSuccessStatusCode": true
}
```

The body payload itself (CSV or JSON records) is missing — the server is leaking its response-builder wrapper instead of streaming the actual content. Both `encoding=json` and `encoding=csv` behave this way.

**Conclusion:** `/export/clients` is **not usable** for bulk ingestion against this tenant until YOT fixes the backend. The endpoint validates and accepts parameters but returns a serialized wrapper instead of the actual client list.

## `/1/api/clients/{id}` detail hydration

Both identifier forms were tried against the first client observed in `/clients?page=1`:

- `GET /clients/6708761` (numeric `id`)  → `HTTP 404`, empty body
- `GET /clients/35c95d18-ece5-47fd-86bd-4c62596587a1` (UUID `privateId`) → `HTTP 404`, empty body

**Conclusion:** `/clients/{id}` is **not usable** for detail hydration on this tenant with either key form. Either the route is disabled, uses a different path shape, or requires a different identifier type. Because the endpoint is unreachable, we could not determine whether a richer field set exists beyond what `/clients` list already returns.

### Fields confirmed present in `/clients` list response

From the 2000-row live sample, the list response exposes this field set on each record:

```
active, birthday, businessPhone, country, emailAddress, gender,
givenName, homePhone, id, initial, mobilePhone, name, otherName,
phone, postcode, privateId, state, street, suburb, surname
```

All other `INTERESTING_DETAIL_FIELDS` the probe looks for on the detail endpoint (`lastVisitAt`, `totalVisits`, `totalSpend`, `tags`, `notes`, `loyaltyPoints`, `preferredStaffId`, `preferredLocationId`, `marketingOptIn`, etc.) could not be confirmed present or absent because the detail endpoint returned 404.

## Rate-limit signals

No `429` responses were observed during this characterization.

The only rate-limit-adjacent behavior was:

- Server start-to-timeout at page `≥ 8000` on `/clients?page=N` (30-second read timeout, no body returned).

This is more consistent with backend query degradation on deep OFFSETs than with an explicit rate-limit policy. Any real `429`/backoff behavior remains uncharacterized.

## Recommended ingestion strategy

Given the observed constraints, the most conservative viable strategy:

1. **Bulk path: paginated `/clients?page=N` only.**
   - `/export/clients` is broken server-side and cannot be relied on.
   - `/clients/{id}` is 404 and cannot hydrate detail.
   - Fixed 25 rows per page; `limit` and `pageSize` do not help.
2. **Full-sync budget: ~5 hours single-threaded.**
   - Plan for at least `~7000` pages for the HMX tenant.
   - Use the existing 500ms throttle as a floor, not a target.
   - Expected wall time: `~7000 × (2.0s + 0.5s) ≈ 4.9 h`.
3. **Page-termination contract.**
   - Do **not** trust "empty page" as a signal within the expected working range — in this tenant it may never arrive before server timeouts begin.
   - Stop the walk on any of:
     - a configurable `MAX_PAGES` ceiling (default well above expected true count, e.g. `10000`),
     - `N` consecutive timeouts or 5xx responses,
     - a `429`, or
     - no new unique `id` observed across `K` consecutive pages (dedupe-based termination).
4. **Resumability.**
   - Persist `last_successful_page` in the existing `sync_state` table.
   - On retry/resume, start from `last_successful_page + 1`, not from page 1.
   - Keep committing new rows in batches (e.g. every N pages) so a long full sync is crash-safe.
5. **Upserts.**
   - Upsert by numeric `id` (observed to be unique across 2000 rows and across spot-checked high pages).
   - Do **not** assume `id` ordering — it is not monotonic across server pages.
6. **No server-side filtering.**
   - `active`, `modifiedSince`, `updatedSince` had no observable effect in this probe.
   - Treat every run as a full walk for now.
   - Apply any active/inactive or modified-since filtering client-side after ingestion.
7. **Defer detail hydration.**
   - Do not build detail-hydration into the first ingestion implementation. `/clients/{id}` needs a separate tracked fix before it can be used.
   - The list response is already rich enough to support the Kitchen Clients view and basic marketing audience features.
8. **Defer export path.**
   - Do not try to use `/export/clients` until YOT fixes the missing body. It is currently unusable.

## Followups that should become their own tickets

- **YOT support ticket — `/export/clients` missing body.** Endpoint returns a serialized `HttpResponseMessage` wrapper instead of the CSV/JSON payload. Reproducible with `?startDate=20200101&endDate=20260424&encoding=json` or `encoding=csv`. Request status, target fix timeline, and whether our tenant is affected specifically or it is global.
- **YOT support ticket — `/clients/{id}` returns 404.** Both numeric `id` and UUID `privateId` forms fail. Confirm the endpoint is still published on this tenant and, if so, the correct path and identifier form. If a detail endpoint genuinely exists with extra fields (visits, spend, tags, loyalty, opt-in flags), we want it back.
- **YOT support ticket — incremental-sync parameters.** Confirm whether `/clients` supports any server-side incremental filter (e.g. `modifiedSince`, `changedSince`, `sinceId`) and document the exact param name, location, and accepted date format. Without this we are stuck doing full ~5-hour walks.
- **YOT support ticket — `active` filter on `/clients`.** The parameter appears to be silently ignored. Document whether that is intentional or a bug.
- **New probe ticket — true end-of-list.** Binary-search between page `7000` and `8000` with generous per-request timeouts to find the actual last-non-empty page for this tenant, so we can pin a real `MAX_PAGES` ceiling in ingestion config.
- **New probe ticket — parallelism tolerance.** Check whether YOT tolerates 2–4 concurrent page fetches from the same key. If yes, full-sync wall time drops linearly.
- **Ingestion implementation ticket (follow-on to 0113).** Reference: use the strategy above, accept the single-source paginated approach, and commit to "every sync is a full walk" until a working incremental filter is confirmed.

## Repro / probe tooling

- Source: `scripts/characterize-clients.ts` (requires `npx tsx`, reads the live API key from `plugin_config` in `yot-hmx-marketing-team.db`, emits progress to stderr and a full JSON summary to stdout).
- Most recent live summary: `/tmp/yot-probe-stdout.json` on the Mac Studio host that generated this document.
- The script is **safe**: it never logs the API key, uses the `APIKey:` header per YOT spec, throttles at 500ms minimum, stops the baseline paging loop at `MAX_BASELINE_PAGES=80` by default, and caps consecutive 5xx responses at 2.
