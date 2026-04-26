# 0116 — YOT revenue source findings

Live characterization of likely YOT revenue endpoints for the Hair Mechanix marketing-team tenant, run against `https://api2.youreontime.com/1/api` from the Mac Studio host on **2026-04-26**.

## Executive summary

- **No usable revenue source was proven on this tenant yet.**
- The published openapi spec exposes exactly **one revenue-shaped surface**: **`/1/api/export/invoices`**.
- On this tenant, `/export/invoices` was **not stable or ingestible** during probing:
  - some requests **timed out** without returning a body
  - other requests returned **HTTP 500** with a server-side `ArgumentNullException` from `YotApiController.InvoiceExport(... line 3171)`
- Guessed non-spec endpoints that would have been ideal for revenue ingestion — `/invoices`, `/sales`, `/receipts`, `/transactions`, `/reports` — all returned **HTTP 404**.
- Because no invoice payload was successfully returned, we could **not validate money fields** or prove **location**, **stylist**, or **date** rollup granularity.
- Result: **no revenue ingestion slice was implemented**. This PR lands the probe script and documentation only so ticket 0116 can proceed from concrete evidence instead of assumptions.

## Endpoints probed

### Working non-revenue baseline endpoints

| Endpoint | Result | Notes |
| --- | --- | --- |
| `/business` | 200 | Business resolved as Hair Mechanix; tenant is valid. |
| `/locations` | 200 | 35 locations returned; tenant key is healthy. |

These matter because they rule out a bad API key or a dead tenant as the reason revenue probing failed.

### Revenue candidates

| Endpoint | Example params | Result | What we learned |
| --- | --- | --- | --- |
| `/export/invoices` | `startDate=20260424&endDate=20260424&encoding=json` | timeout | Endpoint accepted the request but did not return a usable payload inside the probe timeout window. |
| `/export/invoices` | `startDate=20260424&endDate=20260424&encoding=csv` | 500 | Server threw `ArgumentNullException` while constructing response content. |
| `/export/invoices` | `startDate=20260401&endDate=20260407&encoding=json` | 500 | Same server-side failure. |
| `/export/invoices` | `startDate=20260401&endDate=20260407&encoding=csv` | timeout | Same instability pattern. |
| `/export/invoices` | `startDate=20260301&endDate=20260331&encoding=json` | 500 | Same server-side failure. |
| `/export/appointments` | `startDate=20260401&endDate=20260425&encoding=json` | timeout | Not a revenue endpoint, but probed as a sibling export surface for comparison. |
| `/invoices` | none | 404 | Not present on this tenant/path. |
| `/sales` | none | 404 | Not present on this tenant/path. |
| `/receipts` | none | 404 | Not present on this tenant/path. |
| `/receipt` | none | 404 | Not present on this tenant/path. |
| `/transactions` | none | 404 | Not present on this tenant/path. |
| `/reports` | none | 404 | Not present on this tenant/path. |
| `/report` | none | 404 | Not present on this tenant/path. |

## Money fields / granularity

### Money fields

**None proven.** No successful `/export/invoices` body was returned, so there is still no trustworthy evidence for fields like:

- gross sales
- discounts
- taxes
- tips
- net sales
- invoice totals
- payment / settlement amounts

### Granularity

| Granularity | Proven? | Why |
| --- | --- | --- |
| Location | No | No successful invoice/export payload to inspect for a location key. |
| Stylist | No | No successful invoice/export payload to inspect for staff linkage. |
| Date / day | No | Request is date-bounded, but no successful body came back, so row-level date fidelity is still unproven. |

## Trustworthiness assessment

At this point, **revenue is blocked on YOT endpoint viability**, not on local schema or implementation effort.

We already have a local `revenue_facts` table ready for daily location rollups, but populating it would be speculative until YOT returns a real invoice/sales payload with actual money fields.

## Why no implementation slice landed

A first revenue slice would only be safe if we had at least one proven source with:

1. actual money fields,
2. stable success behavior,
3. enough identifiers to roll up by location and date.

We did **not** get that evidence. Implementing ingestion now would mean coding against guessed fields or fabricated shapes, which would be worse than waiting.

## Recommended next slice

1. **Open a YOT support ticket for `/export/invoices`.** Include the concrete repros above and the observed `ArgumentNullException` in `YotApiController.InvoiceExport`.
2. Ask YOT to confirm:
   - whether `/export/invoices` is the intended revenue source for this tenant,
   - supported `encoding` values,
   - maximum allowed date range,
   - whether the export includes location, staff, invoice id, tax, tip, discount, and net/gross totals.
3. Once YOT returns one successful sample payload, land the first implementation slice as:
   - invoice export fetcher
   - mapper into daily `revenue_facts`
   - location-level totals/series endpoint backed by that table
4. If YOT says `/export/invoices` is not the right source, ask for the real endpoint path for invoice/sales/receipt data on API v1.

## Repro tooling

- Source: `scripts/characterize-revenue-source.ts`
- Expected usage:

```bash
npx tsx scripts/characterize-revenue-source.ts > /tmp/yot-revenue-probe.json
```

- Safety:
  - reads the API key once from `plugin_config`
  - never writes to the plugin DB
  - never logs the API key
  - probes only a small fixed request set with 500 ms pacing
