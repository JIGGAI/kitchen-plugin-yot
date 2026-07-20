# HMX GROUP Disbursements — Second Daily Branch CSV + Distribution Group

**Date:** 2026-07-20
**Status:** Approved design

## Goal

Add a second nightly Branch disbursement CSV and distribution group for **HAIR MX GROUP** (4 Florida locations, 32 staff), running alongside the existing **CORP** job without changing CORP's behavior. HMX GROUP pays no loan payments and no garnishments at this time.

## Background — what runs today

One nightly pipeline, all CORP:

| When | Job | Purpose |
|---|---|---|
| 21:00 ET Mon–Sat, 16:00 ET Sun | `scripts/export-branch-deposits.ts` | Builds the Branch upload CSV, emails disbursements |
| 22:00 ET daily | `scripts/branch-deposit-watchdog.ts` | Validates output, detects name typos, auto-appends missing staff to the roster tab, alerts RJ |
| 17:00 ET Sun | `scripts/combine-weekend-deposits.ts` | Stacks Sat+Sun disbursements CSVs, emails the combined file |

The export pulls the YOT StaffCashoutReport (org 11082), looks each paid stylist up in the `CSV MASTER` roster tab, applies garnishments and loan withholding, and emits:

- `~/hmx-reports/branch-deposits-<date>.csv` — the branchapp.com upload file
- `~/hmx-reports/disbursements-<date>.csv` — the emailed file
- `~/hmx-reports/branch-deposits-<date>.diagnostics.json` — consumed by the watchdog
- Google Sheets writes: a per-day `M/D/YY` tab on Branch Daily Totals (BRANCH MASTER: 15 location rows + TOTAL), a CSV mirror tab on the Branch DISPURSEMENTS sheet, plus garnishment/loan bookkeeping

## Findings that shaped this design

1. **One YOT report, not two.** The Florida locations already appear in the nightly org-11082 pull (Middleburg, Treaty Oaks, World of Golf, Yulee). They are excluded today only because their locations are absent from `CSV MASTER`, which is the script's in-scope gate (`supportedLocations`). This is a partitioning problem, not a new pipeline — no new data source or credentials.

2. **The rosters are fully disjoint.** CORP has 218 staff across 15 locations; HMX GROUP has 32 staff across 4. There is no shared location, staff ID, or name. A single codebase can safely serve both.

3. **`CSV MASTER` and `CORP CSV MASTER` are byte-identical duplicates** (248 rows each) and the script still reads the old name. Deleting the old tab before the constant changes would break the nightly payroll job.

4. **Seven YOT locations are on neither roster** — Clearwater, Jacksonville, Mandarin, Palm Harbor (FL), Grand Blanc, Rochester (MI), Washington (PA). They are paid through another system and remain silently skipped, exactly as today.

5. **`normalizeLocation` strips state suffixes** (`World of Golf FL.` → `world of golf`), so the GROUP roster's spellings already match YOT. This also means two same-named shops in different states would collide — not a problem today (verified no collisions), but a reason for the disjointness assertion below now that the system is multi-state by design.

## Approach

**Parameterize the existing scripts; do not fork.** A `GROUP_CONFIGS` registry keyed by group id, selected by a `--group=corp|hmx-group` flag (default `corp`). All group-varying values move into the config; the shared logic — transaction-ID encoding, fuzzy name matching, negative rebates, zero-net omission, re-run idempotency — stays single-sourced.

Rejected alternatives:
- *Fork a second script* — duplicates ~1,500 lines of subtle payout logic. This code has a history of expensive edge-case bugs; every future fix would have to land twice, and divergence is near-certain.
- *One run emitting both groups* — a single YOT pull and a consistent snapshot, but it couples the two groups' fate. Unacceptable for payroll: a GROUP failure must never stop CORP from paying.

The two groups run as **separate nightly invocations**, so code is shared but execution is isolated.

## Group configuration

| Field | `corp` | `hmx-group` |
|---|---|---|
| Roster tab | `CORP CSV MASTER` | `HAIR MX GROUP CSV MASTER` |
| Daily-totals spreadsheet | existing Branch Daily Totals | new dedicated spreadsheet |
| CSV mirror spreadsheet | existing Branch DISPURSEMENTS | same new spreadsheet |
| Email To | `Miranda.hmx.corp@hairmx.net` | `Miranda.hmx.corp@hairmx.net` |
| Email CC | `info@hairmx.com` | `rjdjohnston@gmail.com` |
| Branch upload file | `branch-deposits-<date>.csv` | `hmxgroup-branch-deposits-<date>.csv` |
| Emailed file | `disbursements-<date>.csv` | `hmxgroup-disbursements-<date>.csv` |
| Diagnostics | `branch-deposits-<date>.diagnostics.json` | `hmxgroup-branch-deposits-<date>.diagnostics.json` |
| Garnishments | enabled | **disabled** |
| Loan withholding | enabled | **disabled** |
| BRANCH MASTER locations | 15 | 4 |
| branchapp.com account | existing | separate company |

CORP's filenames, recipients, spreadsheets, and schedule are unchanged — the watchdog, weekend-combine job, and the operator's routine all depend on them. The recipient lists are plain arrays so addresses can be added later with a one-line edit.

Email subject keeps the existing shape with a group label for HMX GROUP, e.g. `HMX GROUP Disbursements <date> — N deposits, $X`.

## Safety: cross-roster collision guard

The partition is only sound while the two rosters stay disjoint. Rather than assume it, each run loads **both** rosters and checks its own payable rows against the other group's roster.

A colliding staff — one whose staff ID or normalized location appears on both rosters — is **excluded from the CSV and reported**, in both groups' runs. Neither group pays them automatically; they surface in diagnostics and the watchdog email for manual handling, the same path already used for staff missing from a roster.

Two rejected alternatives, and why:

- *Abort the whole run on collision.* A single bad roster row would stop payment for all 218 CORP stylists, and a GROUP roster edit could block CORP payroll — breaking the isolation this design exists to provide.
- *Let each group pay independently.* That is the double-payment this guard exists to prevent.

Excluding the ambiguous row is the only option that pays everyone unambiguous, never pays anyone twice, and keeps one group's roster mistake from affecting the other's payroll.

Reading the other group's roster is one extra sheet read per run and does not otherwise couple the jobs: a collision degrades one stylist to manual handling, never the run.

This is the only genuinely new business logic and it is unit-tested: disjoint rosters pay normally; a shared staff ID is excluded and reported in both groups; a shared normalized location is excluded and reported, including across state suffixes (e.g. `Monroe` vs `Monroe FL`, which `normalizeLocation` renders identical).

## Feature flags for garnishments and loans

When a group config disables garnishments and loans, the export skips loading the rules, applies no withholding, and performs no writes to the GARNISHMENTS PAYOUTS / LOAN PAYMENTS / LOANS ranges. HMX GROUP therefore never touches the garnishments spreadsheet at all — its payout equals the YOT bank-to-bank amount. Diagnostics still emit the corresponding counters as zero so the watchdog's shape is unchanged.

## New spreadsheet

Create "HMX GROUP Branch Daily Totals" under the `govna.assistant@gmail.com` account with two template tabs:

- `BRANCH MASTER` — same two-table layout as CORP (BRANCH at columns A–C, YOT at E–G) keyed by location, with the 4 HMX GROUP locations and a TOTAL row carrying the same formula shape
- `CSV BLANK MASTER` — the column layout used for the per-day CSV mirror, matching CORP's header

Its spreadsheet id becomes the `hmx-group` config's sheet target. The link is shared with RJ after creation.

## Support jobs

Both support jobs take the same `--group` flag and operate entirely within that group's config:

- **Watchdog** — validates that the group's file exists and is non-empty, runs the same typo/fuzzy detection, auto-appends genuinely-missing staff to *that group's* roster tab, and emails RJ with the group named in the subject.
- **Weekend combine** — globs that group's Sat+Sun disbursements files, writes `hmxgroup-disbursements-weekend-<sat>-to-<sun>.csv`, and emails that group's recipients.

## Scheduling

Each group gets its own launchd plist with its own `shlock` lock file, so neither group's run can block the other. HMX GROUP is staggered 10 minutes after CORP to avoid YOT API contention:

| Job | CORP | HMX GROUP |
|---|---|---|
| Export | 21:00 Mon–Sat, 16:00 Sun | 21:10 Mon–Sat, 16:10 Sun |
| Watchdog | 22:00 daily | 22:10 daily |
| Weekend combine | 17:00 Sun | 17:10 Sun |

New labels: `com.hairmx.branch-deposit-export-hmxgroup`, `com.hairmx.branch-deposit-watchdog-hmxgroup`, `com.hairmx.weekend-deposit-combine-hmxgroup`, with lock files named to match.

## Testing

- Unit tests for group-config resolution (correct roster tab, recipients, filenames, and flags per group id; unknown group id rejected).
- Unit tests for the collision guard: disjoint rosters pay normally; a staff id on both rosters is excluded and reported; a normalized-location collision is excluded and reported; the exclusion happens in both groups' runs.
- Unit test that a garnishments-and-loans-disabled group produces a payout equal to the YOT bank-to-bank amount.
- Manual dry-run verification against a past date for both groups before any live send, comparing the GROUP CSV row-by-row against the roster.

## Rollout

1. Land the `CSV MASTER` → `CORP CSV MASTER` constant change and verify a CORP dry run still produces the expected CSV. Only then does RJ delete the stale `CSV MASTER` tab.
2. Create the HMX GROUP spreadsheet with both templates; record its id.
3. Implement the group config, feature flags, and collision guard; add `--group` to all three scripts.
4. Dry-run `--group=hmx-group` for a past date; inspect the CSV against the roster by hand.
5. Install the three new launchd plists, with the GROUP disbursements email routed to RJ only for the first few nights.
6. Switch the GROUP email to the real recipient list once verified.

## Out of scope

- Loan payments and garnishments for HMX GROUP (explicitly deferred).
- Re-homing the seven unrostered YOT locations; they continue to be skipped silently.
- Any change to CORP's outputs, recipients, spreadsheets, or schedule.
