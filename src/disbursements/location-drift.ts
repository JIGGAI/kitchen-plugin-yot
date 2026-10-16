// Roster-vs-YOT location drift for the disbursement pipeline.
//
// The export matches a YOT cashout row to the roster by NAME (location only
// breaks ties between duplicate names) and then writes the ROSTER row's
// location into the deposit CSV, the CSV mirror tab, and the daily-totals
// BRANCH column. So a stylist filed under the wrong shop on the roster is
// still paid the right amount, but under the wrong location — and that shop's
// BRANCH total is off from its YOT total by exactly their amount. Nothing
// else in the pipeline notices (2026-10-15: two HMX Group stylists had been
// swapped between Middleburg and Yulee since before the group went live).
//
// This records each such row so the export email and the watchdog can name
// the stylist and the row to move. Reporting only — the payout is unchanged.
import { normalizeLocation, normalizeText } from './normalize';

export type LocationDriftRow = {
  /** 1-based row on the roster tab. */
  csvMasterRowNumber: number;
  csvMasterName: string;
  staffId: string;
  /** Location as written on the roster (what the CSV carries). */
  csvMasterLocation: string;
  /** Location as YOT reported it for this day. */
  reportLocation: string;
  /** Signed YOT bank-to-bank amount for the day. */
  bankToBankAmount: number;
};

/** Same shop when the normalized names are equal, or one is the other with
 *  extra words — corp's roster says "Sterling" and "Clinton" where YOT says
 *  "Sterling Warren MI" and "Macomb - Clinton MI". Compared as whole words so
 *  "Troy" never swallows "Troyville". */
export function isSameShop(rosterLocation: string | null | undefined, reportLocation: string | null | undefined): boolean {
  const a = normalizeLocation(rosterLocation);
  const b = normalizeLocation(reportLocation);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return ` ${long} `.includes(` ${short} `);
}

/** True when both sides name a location and they are different shops. */
export function isLocationDrift(rosterLocation: string | null | undefined, reportLocation: string | null | undefined): boolean {
  const a = normalizeLocation(rosterLocation);
  const b = normalizeLocation(reportLocation);
  if (!a || !b) return false;
  return !isSameShop(a, b);
}

/** Email section listing drifted rows, or null when there are none. Shared
 *  by the export's own email and the watchdog so the two never disagree. */
export function formatLocationDriftSection(rosterTab: string, rows: LocationDriftRow[]): string | null {
  if (!rows.length) return null;
  const lines = rows.map((r) => {
    const amount = `$${Math.abs(r.bankToBankAmount).toFixed(2)}`;
    return `- ${r.csvMasterName} (staff id ${r.staffId}) worked at "${r.reportLocation}" today per YOT (${amount}), but ${rosterTab} only lists them at "${r.csvMasterLocation}" (row ${r.csvMasterRowNumber}). They were paid in full; the deposit is just filed under "${r.csvMasterLocation}", so that shop's BRANCH total is ${amount} high and "${r.reportLocation}" is ${amount} low. If they float between shops, add a row for them under "${r.reportLocation}" too (one row per shop they work, like the other floaters). If they have transferred, move the row instead.`;
  });
  return `${rosterTab} does not list these stylists at the shop YOT paid them at today (paid correctly, filed under the roster's shop):\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Duplicate roster rows. A stylist listed under SEVERAL shops is deliberate:
// that is how floaters are rostered (corp lists Carissa Benedict under four
// shops) and the matcher picks the row whose shop agrees with YOT that day.
// The same person listed twice under the SAME shop is a leftover from a
// copy-paste and only adds confusion, so flag that. (2026-10-15 corp: Chelsea
// Desselles on Monroe rows 141 and 146, Dawn Rowe on Sterling rows 216 and 219.)
export type RosterRowRef = {
  rowNumber: number;
  staffId: string;
  firstName: string;
  lastName: string;
  location: string;
};

export type RosterDuplicate = {
  /** 'staff-id' when the same id is on several rows of one shop, 'name' when
   *  the same person's name is (ids may differ when one row has a typo). */
  kind: 'staff-id' | 'name';
  value: string;
  rows: { rowNumber: number; staffId: string; name: string; location: string }[];
};

export function findRosterDuplicates(rows: RosterRowRef[]): RosterDuplicate[] {
  const out: RosterDuplicate[] = [];
  const byId = new Map<string, RosterRowRef[]>();
  const byName = new Map<string, RosterRowRef[]>();
  for (const r of rows) {
    const shop = normalizeLocation(r.location);
    const id = String(r.staffId || '').trim();
    const name = normalizeText(`${r.firstName} ${r.lastName}`);
    if (id) byId.set(`${id}|${shop}`, [...(byId.get(`${id}|${shop}`) || []), r]);
    if (name) byName.set(`${name}|${shop}`, [...(byName.get(`${name}|${shop}`) || []), r]);
  }
  const describe = (r: RosterRowRef) => ({
    rowNumber: r.rowNumber,
    staffId: String(r.staffId || '').trim(),
    name: `${r.firstName} ${r.lastName}`.trim(),
    location: r.location,
  });
  const idDupRows = new Set<number>();
  for (const [key, group] of byId) {
    if (group.length < 2) continue;
    out.push({ kind: 'staff-id', value: key.split('|')[0]!, rows: group.map(describe) });
    for (const r of group) idDupRows.add(r.rowNumber);
  }
  for (const [key, group] of byName) {
    if (group.length < 2) continue;
    // Already reported under the id when every row shares it.
    if (group.every((r) => idDupRows.has(r.rowNumber))) continue;
    out.push({ kind: 'name', value: key.split('|')[0]!, rows: group.map(describe) });
  }
  return out;
}

export function formatRosterDuplicateSection(rosterTab: string, dups: RosterDuplicate[]): string | null {
  if (!dups.length) return null;
  const lines = dups.map((d) => {
    const rows = d.rows.map((r) => `row ${r.rowNumber} (${r.name}, id ${r.staffId || '?'}, "${r.location}")`).join(' and ');
    const what = d.kind === 'staff-id' ? `Staff id ${d.value}` : `"${d.rows[0]!.name}"`;
    return `- ${what} is on ${rows} — the same shop twice. Delete one of the rows. (Listing a floater under several different shops is fine and is not reported here.)`;
  });
  return `${rosterTab} duplicate rows (same person listed twice under one shop):\n${lines.join('\n')}`;
}
