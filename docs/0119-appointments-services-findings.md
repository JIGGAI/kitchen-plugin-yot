# 0119 Appointments / Services / Staff Characterization

Live characterization of the YOT `/appointmentsrange`, `/appointments`, `/{locationId}/services`, `/{locationId}/staff`, `/staff/profile/{id}`, and `/appointments/{id}` endpoints for the Hair Mechanix marketing-team tenant, run against `https://api2.youreontime.com/1/api` from the Mac Studio host on 2026-04-24.

This is a **characterization pass only** — it does no ingestion and writes nothing to the plugin DB. Its output is intended as input for ticket **0114 (local schema for appointments / services / stylists tables)**.

## Summary

- **`/appointmentsrange` is the only realistic bulk path for appointments** on this tenant. It returns every appointment at a given location inside a date window in a **single response** — there is no pagination and no page-size parameter is honored.
- **The openapi spec lies about this endpoint's parameters in three important ways**:
  1. `staffId` is marked optional but is **required** — omitting it, or sending `staffId=0`, causes a server-side `System.NullReferenceException` (HTTP 500, .NET stack trace in the body) from `YoureOnTime.Controllers.YotApiController.AppointmentsRange` at `ApiController.cs:line 2164`.
  2. `date` / `enddate` are documented as `Int64` without any format. In practice they are **unix milliseconds**. `YYYYMMDD` integers parse without error but return a window anchored at `1970-01-01` and therefore zero rows. `YYYY-MM-DD` strings return HTTP 400 (model binder rejects non-numeric). `unix-seconds` parses without error but again anchors in 1970 and returns zero rows.
  3. The spec describes the response as a list of appointments; the actual response is a **calendar-view DTO** with `data.appointments` as the real row array and many sibling configuration fields (`statuses`, `categories`, `staff`, `openHours`, `closedDays`, `breakStatuses`, etc.).
- **`staffId` is used as an actor ("currentUser") parameter, not a filter.** Two different `staffId` values against the same location + window returned byte-identical appointment lists (same count, same `appointmentId`s, same `resourceId` distribution). Per-staff filtering will have to be done client-side after ingest.
- **Appointments carry no revenue data.** No price, cost, tip, paid, tax, discount, or amount fields appear anywhere on the 1945-row, 30-day sample at loc=1347. Ticket 0116 (revenue analytics) will need a separate data source — `/1/api/export/invoices` is in the spec but is suspected to be broken in the same way `/export/clients` is (see followups below).
- **`/appointments/{id}` is broken.** Both the internal `id` (e.g. `23303248`) and the business-visible `appointmentId` (e.g. `17455434`) return HTTP 404 with an empty body. There is no working appointment-detail endpoint on this tenant, so no richer per-row hydration is possible beyond what `/appointmentsrange` returns.
- **`/services` does not exist at the global level; only `/{locationId}/services`.** Returns a nested shape: top-level array of **categories**, each with a `services` array. Each service carries a bloated `staffPrices` array (≈793 entries per service — apparently a cross product of all staff across all locations, almost all with empty prices) which should be dropped on ingest to save space.
- **`/staff` and `/stylists` do not exist globally; only `/{locationId}/staff`.** Also, the `services=true|false` query parameter is **required** (undocumented) — omitting it returns `HTTP 400 { "services": ["The services field is required."] }`.
- **Full appointment backfill across 35 locations is cheap** compared to clients: a 30-day window per location averages ~1.7s and ~1800 rows. A full year of history at 12 monthly slices × 35 locations ≈ **12.6 min of request time at 500ms throttle** (not counting the first/last second of each per-location window). Much smaller than the 5-hour `/clients` walk.

## Endpoint-by-endpoint

### `/1/api/appointmentsrange`

**Spec signature (openapi):**

```
GET /1/api/appointmentsrange
  ?locationId=<int64>   # optional per spec
  &staffId=<int64>      # optional per spec
  &date=<int64>         # optional per spec
  &enddate=<int64>      # optional per spec
```

**Actual server signature (from the 500 stack traces):**

```
AppointmentsRange(Int64 locationId, Int64 staffId, Int64 date, Int64 enddate)
  — all four are required (null → NullReferenceException)
  — date / enddate are unix milliseconds
  — staffId is the "actor" (currentUser), not a filter
```

**Probed date formats** (window: 7 days back → now, locationId=1347, staffId=84738):

| Format        | Example              | Status | Rows | Notes |
|---------------|----------------------|--------|------|-------|
| `YYYYMMDD`    | `20260417`           | 200    | 0    | Parsed as ms-since-epoch → 1970; window is empty |
| `YYYY-MM-DD`  | `2026-04-17`         | 400    | 0    | Model binder rejects (not an Int64) |
| unix-seconds  | `1776406073`         | 200    | 0    | Parsed as ms-since-epoch → 1970; window is empty |
| **unix-ms**   | `1776406073020`      | 200    | 463  | **Only correct format** |

**Per-location 30-day-window probe** (date = now − 30d → now, unix-ms, staffId=84738):

| locationId | name       | http | rows | duration | size     |
|------------|------------|------|------|----------|----------|
| 1347       | Westland   | 200  | 1879 | 1766 ms  | 3.0 MB   |
| 1348       | Waterford  | 200  | 1632 | 1505 ms  | 2.8 MB   |
| 1349       | Livonia MI | 200  | 2066 | 1791 ms  | 3.4 MB   |

**Window tolerance** (loc=1347, staffId=84738):

| window days | rows  | duration | http |
|-------------|-------|----------|------|
| 1           | 94    | <1.0 s   | 200  |
| 7           | 463   | 1.7 s    | 200  |
| 14          | 896   | 2.2 s    | 200  |
| 30          | 1879  | 6.1 s    | 200  |
| 90          | 5579  | 86.9 s   | 200  |
| 365         | –     | >60 s    | client timeout (curl 60s cap) |

90-day windows work but take ~90 seconds. 30-day windows are ~2–6s and are a safer ingestion slice size.

One transient 500 was observed on a 30-day window for loc=1347 after ~26s wall-time; retries on the exact same URL returned 200 in ~6s with 1879 rows. So transient 500s do happen and should be retried.

**Paging / page-size parameter handling** (loc=1347, staffId=84738, 30-day window):

| variant                 | http | rows | firstRowId | notes |
|-------------------------|------|------|------------|-------|
| no-page                 | 200  | 1879 | 23303248   | baseline |
| `page=1`                | 200  | 1879 | 23303248   | identical payload |
| `page=2`                | 200  | 1879 | 23303248   | identical payload |
| `page=3`                | 200  | 1879 | 23303248   | identical payload |
| `limit=500`             | 200  | 1879 | 23303248   | ignored |
| `pageSize=500`          | 200  | 1879 | 23303248   | ignored |

**Conclusion:** `/appointmentsrange` is **window-based, not page-based**. There is no pagination primitive. The only way to shrink the response is to shrink the date window. `page`, `limit`, `pageSize` are silently ignored. Full-tenant sync strategy should be "per-location × per-month rolling window".

**Top-level response shape** (keys sorted):

```
allowBlocks, allowClass, allowGoogleCalendarSync, allowPastAppointments,
appointmentBreaksOnMonth, appointmentBreaksOnWeek, appointmentColumns,
appointmentCompactMode, appointmentDisableDragDrop, appointmentShowStaffPhoto,
breakStatuses, cancelledWaitingListStatus, cancelledWaitingListStatusDark,
categories, closedDays, colorType, completedWaitingListStatus,
completedWaitingListStatusDark, currentDay, currentHour, currentMonth,
currentUser, currentYear, data, day, debugInfo, defaultTab, disableHover,
firstHour, hasAgendaView, hasMonthView, hasResources, hasWaitingList, hour,
lastHour, locationId, minute, month, openHours, organisationId,
remindersEnabled, resources, staff, staffOnlyBookOwn, startDay,
startedWaitingListStatus, startedWaitingListStatusDark, statuses, step,
waitingWaitingListStatus, waitingWaitingListStatusDark, year
```

Reference data worth capturing once (or per-location, once) rather than per-appointment:

- `statuses` — array of `{ id, description, code, color, custom }` (e.g. `id=18538 description="Complete" code=4`). These are the values used in the row-level `status` field.
- `categories` — array of `{ id, description, color }` (e.g. `id=26148 description="Haircut"`). Row-level `category` is an int referencing this.
- `staff` — array of `{ id, name, initial }` at this location. Same set as `/{loc}/staff?services=true` but lighter-weight.
- `openHours` / `closedDays` — location metadata; probably duplicates what `/locations` already returns.

### Appointment row shape (`data.appointments[]`)

46-field set observed across all three probed locations' 30-day windows (no location introduced new keys; the field set is stable).

```
id, appointmentId, year, month, day, hour, minute,
startHour, startMinute, endHour, endMinute,
resourceId, serviceResourceId, resource,
description, descriptionWeek, service,
status, category, isClass, processingLength,
clientId, clientName, clientPhone, clientNotes,
clientHasMobile, clientHasEmail,
referrer, classFull, clientWaiting,
newClient, outstandingForms,
lockStaff, lockTime,
promotionCode, arrivalNote, labels,
reminderSent, cancelled, onlineBooking,
color, updatedAt, updatedBy, createdAt, createdBy,
showNewClient
```

Representative row (loc=1347, appointmentId=17455434):

```json
{
  "id": 23303248,
  "appointmentId": 17455434,
  "year": 2026, "month": 3, "day": 25,
  "hour": 10, "minute": 22,
  "startHour": 10, "startMinute": 0,
  "endHour": 10, "endMinute": 25,
  "resourceId": 34795,
  "serviceResourceId": 0,
  "resource": null,
  "service": "Classic Clipper",
  "status": 18538,
  "category": 26148,
  "isClass": false,
  "processingLength": 0,
  "clientId": 7091445,
  "clientName": "Nick Darmits",
  "clientPhone": "",
  "clientNotes": "Preferred provider Lashell.",
  "clientHasMobile": true,
  "clientHasEmail": true,
  "referrer": "",
  "classFull": false,
  "clientWaiting": null,
  "newClient": false,
  "outstandingForms": false,
  "lockStaff": false, "lockTime": false,
  "promotionCode": null,
  "arrivalNote": null,
  "labels": null,
  "reminderSent": false,
  "cancelled": false,
  "onlineBooking": true,
  "color": null,
  "updatedAt": "03/25/2026 9:49 AM",
  "updatedBy": "Lashell",
  "createdAt": "03/25/2026 8:23 AM",
  "createdBy": "Master",
  "showNewClient": true
}
```

**Key observations about field semantics:**

- **Two id fields.** `id` is a dense internal row id (e.g. 23303248). `appointmentId` is the business-visible id (e.g. 17455434). Both appear unique within a window. **Upsert on `appointmentId`** — it's the stable business key.
- **No revenue fields.** Across the 1945-row, 30-day sample at loc=1347: no `price`, `cost`, `total`, `amount`, `paid`, `tip`, `tax`, `discount`, `revenue`, `sale`, `charge`, or `duration` field is present on any row. Revenue has to come from a different endpoint.
- **Dates are exploded into ints**, not ISO strings. `year`, `month`, `day`, `startHour`, `startMinute`, `endHour`, `endMinute` are all integers. `createdAt` / `updatedAt` are `"MM/DD/YYYY H:MM AM/PM"` localized strings, without timezone — we should treat them as `America/Detroit` local (the business's timezone) unless proven otherwise.
- **Duration is implicit.** Computed as `(endHour*60 + endMinute) - (startHour*60 + startMinute)`. Sample p5/p50/p95: 10 / 25 / 40 minutes. `processingLength` is a separate integer and is usually 0 in the sample.
- **Status is an int code.** Observed distribution for the 30-day loc=1347 window:

  | code  | description      | count | % |
  |-------|------------------|-------|---|
  | 18538 | Complete         | 1820  | 93.6% |
  | 18542 | Cancelled        | 51    | 2.6%  |
  | 18539 | No Show          | 39    | 2.0%  |
  | 18536 | Booked           | 35    | 1.8%  |

  The `cancelled: boolean` field was `false` for every row in the sample (even for the 51 rows with status=Cancelled), so **do not trust the `cancelled` boolean — use the `status` code**.
- **`category` is an integer categoryId** (e.g. `26148` → "Haircut") mapping to the top-level `categories` lookup.
- **`service` is a string name** ("Classic Clipper"), not an id. There is no `serviceId` on the appointment row. Joining to the services catalog has to be by name (which is fragile — case / trailing whitespace matters; we observed `"Scissor Cut "` with a trailing space 129 times in the same window). Recommend keeping the raw string AND storing a normalized lookup that tolerates whitespace and case.
- **`resourceId` is the stylist id**, matching `/{loc}/staff` `id`. 13 distinct `resourceId`s were seen at loc=1347 in the 30-day window.
- **`clientId` is the YOT client id**, matching `/clients` id.
- **HTML in descriptions.** `description` and `descriptionWeek` contain HTML markup (`<strong>`, icons, emoji-as-span, client notes). Store raw, derive plain text on read.
- **`resource`, `resources`, `serviceResourceId`** are all 0 / null / empty in the HMX sample. Likely unused on this tenant.

### Fields present vs absent vs ambiguous

**Definitely present** (on every row in the 1945-row sample):

```
id, appointmentId, year, month, day, hour, minute,
startHour, startMinute, endHour, endMinute,
resourceId, serviceResourceId,
status, category, isClass, processingLength,
clientId, clientName, clientPhone,
clientHasMobile, clientHasEmail,
classFull, newClient, outstandingForms,
lockStaff, lockTime, reminderSent, cancelled, onlineBooking,
updatedAt, updatedBy, createdAt, createdBy, showNewClient
```

**Nullable / sometimes empty string** (observed both null and populated):

```
resource, description, descriptionWeek, service,
clientNotes, clientWaiting, promotionCode,
arrivalNote, labels, color, referrer
```

**Definitely absent** (searched across 1945 rows):

```
price, priceValue, cost, amount, total, revenue,
paid, tip, gratuity, tax, discount, promotionValue,
duration (as a direct field — compute from start/end),
services (as an array — `service` is a single string),
staffId (as a separate field on the row — only resourceId),
serviceId, invoiceId, transactionId
```

### `/1/api/appointments` (non-range)

Same server-side controller shape: `Appointments(Int64 locationId, Int64 staffId, Int64 date)`. Also **requires all three args non-null** — omitting any of them returns the same .NET NullReferenceException (HTTP 500).

| variant                            | http | rows | notes |
|------------------------------------|------|------|-------|
| no params                          | 500  | 0    | NullReferenceException |
| `date=<today-ms>`                  | 500  | 0    | locationId missing |
| `locationId=1347&date=<today-ms>`  | 500  | 0    | staffId missing |
| `locationId=1347`                  | 500  | 0    | staffId + date missing |
| `locationId=1347&staffId=84738&date=<today-ms>` | 200 | 62 | works |

When the full trio is provided, `/appointments` returns **one day's worth** of the same calendar-view DTO as `/appointmentsrange` (same wrapper, same `data.appointments[]` row shape, same fields).

`/appointmentsrange` is strictly more useful for ingestion because it accepts a window. Treat `/appointments` as a redundant alternative and do not use it.

### `/1/api/{locationId}/services`

Global `/1/api/services` returns **HTTP 404**. Only the per-location form works.

| endpoint             | http | top-level shape   | top-level rows | notes |
|----------------------|------|-------------------|----------------|-------|
| `/services`          | 404  | empty             | 0              | not a real endpoint |
| `/1347/services`     | 200  | array of categories | 9 categories   | 32 total services |
| `/1348/services`     | 200  | array of categories | 9 categories   | |
| `/1349/services`     | 200  | array of categories | 9 categories   | |

**Response shape** — top-level is an array of categories:

```json
[
  {
    "category": "Haircut",
    "services": [
      {
        "categoryId": 26148,
        "categoryName": "Haircut",
        "serviceId": 310107,
        "serviceName": "Buzz Cut",
        "price": "$22.00",
        "priceValue": 22.0,
        "length": "15 min",
        "description": "One length haircut all over.",
        "staffPrices": [
          { "staff": " Ashleigh ", "price": "" },
          { "staff": " Auburn Hills Hmx", "price": "" },
          /* ... ~793 entries per service, most with "price": "" ... */
        ]
      }
    ]
  }
]
```

Service field set:

```
categoryId, categoryName, serviceId, serviceName,
price (string, e.g. "$22.00"),
priceValue (number, e.g. 22.0),
length (string, e.g. "15 min"),
description,
staffPrices[] (bloat)
```

**Ingestion caveats:**

- `price` is a formatted **string** ("$22.00"); `priceValue` is the numeric value (22.0). Persist both, lean on `priceValue` for math.
- `length` is a formatted **string** ("15 min", "1 hr 15 min"); parse to minutes on ingest.
- `staffPrices` is a **massive bloated array** (≈793 entries per service) that appears to be a cross-join of every service × every staff member across the entire business, almost all with empty `price`. This is 90%+ of the response payload. **Drop it on ingest** unless we actually need per-stylist override pricing (and if we do, filter to rows where `price !== ""`).
- The services response does **not** include a `locationId` field on the service row itself — we have to tag it client-side as we ingest per-location.

### `/1/api/{locationId}/staff`

Global `/1/api/staff` and `/1/api/stylists` both return **HTTP 404**. Only the per-location form works, and the `services=true` query parameter is **required** (undocumented):

```
GET /1/api/{locationId}/staff?services=true
```

Without `services=true` returns `HTTP 400 { "services": ["The services field is required."] }`. With `services=true` or `services=false` returns 200.

| locationId | rows | sample keys |
|------------|------|-------------|
| 1347       | 12   | `id`, `name`, `jobDescription` |
| 1348       | 15   | `id`, `name`, `jobDescription` |
| 1349       | 15   | `id`, `name`, `jobDescription` |

Representative row:

```json
{ "id": 84738, "name": "Kristin", "jobDescription": null }
```

`/1/api/staff/profile/{id}` works (confirmed status 200 for id=84738) and returns a richer per-staff payload with `name, jobTitle, jobDescription, serviceCategories[...]` where `serviceCategories` is the same nested category-of-services shape as `/{loc}/services` but filtered to the services this staff member performs. Useful if we ever want per-stylist service menus; not required for 0114 schema.

**Ingestion caveats:**

- `id` here is the same as `resourceId` in the appointment rows — this is the join key.
- The same staff member MAY appear at multiple locations (the Westland `staff` field list inside the appointmentsrange response also surfaced staff with names like "Charles Shattelroe", "Alaysa" that clearly travel). Recommend a `(staff_id, location_id)` composite, or a `staff` table with an explicit `staff_location_link` bridge table.
- `jobDescription` was `null` for 11/12 rows at loc=1347 in the sample. Low-signal field.

### `/1/api/appointments/{id}` detail

Tried against a real `id` (`23303248`) observed in the range probe. Response: **HTTP 404, empty body**.

Also previously tried `appointmentId` (`17455434`) manually with the same result.

**Conclusion:** There is no working appointment-detail endpoint on this tenant with either identifier form. This matches the analogous finding from ticket 0113 for `/clients/{id}`. The list response from `/appointmentsrange` is the only source of row data.

## Rate-limit signals

No `429` responses were observed in this probe. The notable signals were:

- Per-location, per-30-day-window appointmentsrange: ~1.5–1.8s median.
- 90-day window: 86.9s / 5579 rows / 8.8 MB — server completed but it's slow.
- 365-day window: curl gave up at 60s — server may still be processing but it's not practical.
- One transient 500 on a 30-day window that succeeded on retry — plan for retries with backoff, not for rate-limit-specific behavior.
- The bulk client ingest was running concurrently against `/clients` at 3.6s/page on the same API key; no interference was observed on the appointment / service / staff calls from this probe.

## Recommended schema for ticket 0114

### `appointments` table (one row per appointmentId per-location)

```sql
CREATE TABLE appointments (
  team_id             TEXT    NOT NULL,
  location_id         INTEGER NOT NULL,        -- from ingest context, not in row
  appointment_id      INTEGER NOT NULL,        -- YOT business key (stable)
  internal_id         INTEGER,                 -- YOT row id (dense, may reshuffle)
  client_id           INTEGER,                 -- joins to clients.id
  stylist_id          INTEGER,                 -- resourceId; joins to staff.id
  service_name_raw    TEXT,                    -- raw service string ("Scissor Cut " trailing-space)
  service_name_norm   TEXT,                    -- lower+trim'd for joins
  service_id          INTEGER,                 -- nullable; resolved by name→services.service_id lookup
  category_id         INTEGER,                 -- row.category → categories.id
  status_code         INTEGER NOT NULL,        -- row.status (18538=Complete, 18542=Cancelled, etc.)
  status_description  TEXT,                    -- resolved once against wrapper.statuses
  start_at_local      TEXT,                    -- ISO-ish "YYYY-MM-DD HH:MM" built from year/month/day/startHour/startMinute
  end_at_local        TEXT,                    -- ditto for endHour/endMinute
  duration_minutes    INTEGER,                 -- (endHour*60+endMinute) - (startHour*60+startMinute)
  is_class            INTEGER NOT NULL DEFAULT 0,
  online_booking      INTEGER NOT NULL DEFAULT 0,
  new_client          INTEGER NOT NULL DEFAULT 0,
  client_name         TEXT,
  client_phone        TEXT,
  client_notes        TEXT,                    -- raw text
  description_html    TEXT,                    -- raw row.description
  description_text    TEXT,                    -- stripped plaintext derivative
  referrer            TEXT,
  promotion_code      TEXT,
  arrival_note        TEXT,
  reminder_sent       INTEGER NOT NULL DEFAULT 0,
  created_at_raw      TEXT,                    -- "MM/DD/YYYY H:MM AM/PM" as returned
  created_by          TEXT,
  updated_at_raw      TEXT,
  updated_by          TEXT,
  synced_at           TEXT NOT NULL,           -- ISO UTC when we fetched the row
  raw                 TEXT NOT NULL,           -- full JSON of the original row
  PRIMARY KEY (team_id, location_id, appointment_id)
);

CREATE INDEX idx_appointments_start_local ON appointments(team_id, start_at_local);
CREATE INDEX idx_appointments_client      ON appointments(team_id, client_id);
CREATE INDEX idx_appointments_stylist     ON appointments(team_id, stylist_id);
CREATE INDEX idx_appointments_status      ON appointments(team_id, status_code);
```

Notes:

- **No revenue columns on this table.** The YOT appointments endpoint does not return money. Revenue will attach from a separate invoices/sales table in ticket 0116. Use `(team_id, location_id, appointment_id)` as the join key when that lands.
- **Keep `raw`** for forward compatibility. The `lockStaff`, `lockTime`, `labels`, `classFull`, `outstandingForms`, etc. fields are low-signal today but cheap to preserve.
- **Composite primary key on `(team_id, location_id, appointment_id)`** — `appointmentId` is believed to be globally unique from the samples, but preserving `location_id` in the PK is cheap insurance and simplifies per-location partition scans.
- **`internal_id` should not be the upsert key.** It's a dense row id that may churn on the YOT side.

### `services` table (one row per serviceId per-location)

```sql
CREATE TABLE services (
  team_id         TEXT    NOT NULL,
  location_id     INTEGER NOT NULL,
  service_id      INTEGER NOT NULL,
  service_name    TEXT    NOT NULL,
  category_id     INTEGER,
  category_name   TEXT,
  price_display   TEXT,     -- "$22.00"
  price_value     REAL,     -- 22.0
  length_display  TEXT,     -- "15 min"
  length_minutes  INTEGER,  -- parsed
  description     TEXT,
  synced_at       TEXT NOT NULL,
  raw             TEXT NOT NULL,   -- original service object MINUS staffPrices
  PRIMARY KEY (team_id, location_id, service_id)
);

CREATE INDEX idx_services_name ON services(team_id, lower(trim(service_name)));
```

Notes:

- **Drop `staffPrices` on ingest** unless a specific workflow (per-stylist pricing) asks for it. It is ~90% of response size and almost entirely empty.
- Same `service_id` probably appears at many locations with different prices; do not collapse to a global unique key on `service_id` alone.
- The `category_id` here matches the `appointments.category_id` (e.g. 26148 = Haircut), so categories are shared across locations.

### `service_categories` table (small shared lookup)

```sql
CREATE TABLE service_categories (
  team_id        TEXT    NOT NULL,
  category_id    INTEGER NOT NULL,
  category_name  TEXT    NOT NULL,
  synced_at      TEXT    NOT NULL,
  PRIMARY KEY (team_id, category_id)
);
```

Sourced either from the `categories` array on every `/appointmentsrange` response (they're included) or derived from the services ingest. Either works; the former is free (already coming back) and keeps us safe if a location hasn't been probed.

### `appointment_statuses` table (small shared lookup)

```sql
CREATE TABLE appointment_statuses (
  team_id      TEXT    NOT NULL,
  status_id    INTEGER NOT NULL,   -- e.g. 18538
  status_code  INTEGER NOT NULL,   -- e.g. 4 = Complete
  description  TEXT    NOT NULL,
  color        INTEGER,
  custom       INTEGER NOT NULL DEFAULT 0,
  synced_at    TEXT    NOT NULL,
  PRIMARY KEY (team_id, status_id)
);
```

Captured from the top-level `statuses` array on any `/appointmentsrange` response. Useful for "Complete", "Cancelled", "No Show" display labels without re-fetching.

### `stylists` table (one row per staff per-location)

```sql
CREATE TABLE stylists (
  team_id          TEXT    NOT NULL,
  location_id      INTEGER NOT NULL,
  stylist_id       INTEGER NOT NULL,   -- matches appointments.stylist_id (resourceId)
  name             TEXT    NOT NULL,
  initial          TEXT,
  job_title        TEXT,
  job_description  TEXT,
  synced_at        TEXT    NOT NULL,
  raw              TEXT    NOT NULL,
  PRIMARY KEY (team_id, location_id, stylist_id)
);

CREATE INDEX idx_stylists_stylist_id ON stylists(team_id, stylist_id);
```

Notes:

- Same `stylist_id` can appear at multiple locations — `(location_id, stylist_id)` is the real uniqueness, not `stylist_id` alone.
- `initial` comes from the appointmentsrange wrapper's `staff` array (`"initial": "KC"`); `job_title` / `job_description` come from the per-location `/staff?services=true` endpoint or `/staff/profile/{id}`.

## Estimated full-history ingest time

Ballpark per the 30-day window probe (~1.7s median request + ~0.5s throttle ≈ 2.2s per per-location per-month slice):

- Per location, 12 months of history at one month per request: `12 × 2.2s ≈ 26s`.
- 35 locations: `35 × 26s ≈ 15 minutes` total.

Sensitivity:

- 7-day slices instead of 30-day: `7× the request count`, trades row-count-per-call (smaller, faster, more retry-friendly) for total wall time. Still only ~1.8 hours worst case.
- 90-day slices: 4 requests per location × 87s = ~58 minutes total across 35 locations. Bigger request size, more likely to hit the 60s-ish threshold that triggered the 365-day timeout.

**Recommended slice size for the first ingest: 30 days** — it's the sweet spot between call count and per-call duration.

Concurrency was not probed. `/clients` bulk ingest is running at the same time on the same API key and both endpoints coexisted without 429s, so at least 2-way concurrency across different endpoints is tolerated. Per-endpoint concurrency (multiple `/appointmentsrange` in flight at once) has not been tested and should be added to a followup probe before assuming it works.

## Followups that should become their own tickets

- **YOT support ticket — `staffId` required on `/appointmentsrange` and `/appointments`.** Spec says optional; server throws NullReferenceException if it's missing. Also confirm whether `staffId=0` can be supported as "any staff" (currently also NREs) so that plugin code doesn't have to bootstrap with a real staff id to do a full-location read.
- **YOT support ticket — `date` / `enddate` format documentation.** Spec says `Int64` with no format. Actual format is unix-ms and it silently returns empty windows for `YYYYMMDD` or unix-seconds values that happen to be valid Int64 but are misinterpreted as ms-since-epoch.
- **YOT support ticket — `/appointments/{id}` returns 404 with both id forms.** Same followup shape as the `/clients/{id}` 404 noted in 0113. Confirm whether a detail endpoint is supposed to exist on this tenant.
- **YOT support ticket — `/export/invoices` / `/export/appointments` viability.** Both are listed in the openapi spec. Given `/export/clients` is known-broken (returns a serialized `HttpResponseMessage` wrapper instead of payload — see 0113), suspect the same applies here. Verify before ticket 0116 (revenue analytics) starts blocking on it.
- **Probe — revenue source.** Since `/appointmentsrange` has no money fields, find where YOT exposes completed-invoice totals, tips, and discounts. Candidates: `/invoices`, `/export/invoices`, `/sales`, `/receipts`. This is a blocker for ticket 0116 and should come right after 0114 lands the schema.
- **Probe — `/appointmentsrange` concurrency tolerance.** We observed coexistence with the `/clients` ingest, but did not test multiple simultaneous `/appointmentsrange` calls. Check whether 2–4 concurrent in-flight calls are tolerated; if yes, 35-location backfill wall time drops linearly.
- **Probe — `/{locationId}/staff?services=false`.** We only tested `services=true`. If `services=false` returns a slimmer / different shape it's worth noting before committing to the ingest query shape.
- **Probe — updatedAt-based incremental sync.** The appointments carry `updatedAt` timestamps. Check whether YOT has a server-side filter (`updatedSince`, `modifiedSince`, or similar) on `/appointmentsrange` so that nightly incremental syncs don't have to re-pull every full window. If not, we can do client-side filtering on `updatedAt` but then we still paid the full-pull cost.

## Repro / probe tooling

- Source: `scripts/characterize-appointments-services.ts` (requires `npx tsx`, reads the live API key from the `plugin_config` table via a **readonly** SQLite handle opened once and closed immediately, emits progress to stderr and a full JSON summary to stdout).
- Most recent live summary: `/tmp/yot-appts-probe.json` on the Mac Studio host that generated this document.
- Safety: never logs the API key, uses `APIKey:` header per YOT spec, throttles at 500 ms minimum between requests, stops on 429, caps consecutive 5xx responses at 2 per endpoint. No plugin DB writes under any path.
- Runs cleanly alongside the bulk `/clients` ingest (`scripts/bulk-capture-clients.ts`) — no lock contention or 429 signal observed during the probe.
