// Weekend Branch disbursements combiner.
//
// Runs Sundays at 17:00 ET (1h after the Sunday nightly export's 16:00 ET run)
// via ~/Library/LaunchAgents/com.hairmx.weekend-deposit-combine.plist. Reads
// the two per-day disbursements CSVs the nightly export already wrote —
//   ~/hmx-reports/disbursements-<saturday>.csv
//   ~/hmx-reports/disbursements-<sunday>.csv
// — merges them under one header, writes
//   ~/hmx-reports/disbursements-weekend-<saturday>-to-<sunday>.csv
// and emails the combined file to Miranda.
//
// Merge rule: group by (staff id, location). A stylist who worked the SAME
// shop on both days collapses to one row with the two amounts summed and a
// fresh transaction id encoding the summed amount (Branch rejects duplicate
// ids). Entries at DIFFERENT locations are kept as separate rows. Single-day
// stylists pass through unchanged except for their disbursement date. Every
// row in the combined file is dated Monday — Branch doesn't pay out on the
// weekend, so the Saturday rows' Sunday date is moved forward to Monday.
//
// This is ADDITIVE: the individual Saturday and Sunday emails still go out at
// their normal export times. This job does NOT touch the export, the live
// Google Sheets, or the nightly watchdog — it only re-packages two files that
// already exist and sends one extra email.
//
// If either day's CSV is missing, or the two headers disagree, or the send
// fails, it alerts RJ (rjdjohnston@gmail.com) and exits non-zero rather than
// emailing Miranda a partial/garbled file.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { sendGmail } from '../src/mail/google-mailer';
import { resolveGroupConfig, type DisbursementGroupConfig } from '../src/disbursements/group-config';

const NEW_YORK_TZ = 'America/New_York';
const DEFAULT_OUTPUT_DIR = path.join(homedir(), 'hmx-reports');
const DEFAULT_ACCOUNT = 'govna.assistant@gmail.com';
// Where missing-file / send-failure alerts go — RJ's personal Gmail, kept
// independent of the corporate inbox the combined file is destined for.
const FAILURE_ALERT_TO = 'rjdjohnston@gmail.com';

type Args = {
  sunday: string;
  outputDir: string;
  account: string;
  testRecipient: string | null;
  dryRun: boolean;
  skipEmail: boolean;
  group: DisbursementGroupConfig;
};

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) map.set(arg.slice(2), 'true');
    else map.set(arg.slice(2, eq), arg.slice(eq + 1));
  }
  const sunday = map.get('sunday') || map.get('date') || todayIsoInTimezone(NEW_YORK_TZ);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sunday)) throw new Error(`Invalid --sunday value: ${sunday}`);
  return {
    sunday,
    outputDir: expandHome(map.get('outputDir') || DEFAULT_OUTPUT_DIR),
    account: map.get('account') || DEFAULT_ACCOUNT,
    testRecipient: map.get('test-recipient') || null,
    dryRun: (map.get('dry-run') ?? 'false') !== 'false',
    skipEmail: (map.get('skip-email') ?? 'false') !== 'false',
    group: resolveGroupConfig(map.get('group')),
  };
}

function expandHome(value: string): string {
  return value.startsWith('~') ? path.join(homedir(), value.slice(1)) : value;
}

function todayIsoInTimezone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function prevDayIso(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function nextDayIso(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function weekdayName(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

// Split one CSV line into fields, honoring double-quoted cells with escaped
// ("") quotes — matches the export's formatCsvCell output.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// Non-empty lines of a CSV file (drops the trailing blank from the final \n).
function readCsvLines(filePath: string): string[] {
  return readFileSync(filePath, 'utf8').split('\n').filter((l) => l.length > 0);
}

function parseAmount(cell: string | undefined): number {
  const n = Number(String(cell ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// The next three mirror export-branch-deposits.ts (buildTransactionId /
// formatTransactionDate / formatCsvCell). Kept in sync by hand — importing that
// script would execute its top-level main() and run a real export.
function formatTransactionDate(dateIso: string): string {
  const m = dateIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid ISO date: ${dateIso}`);
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
}
function buildTransactionId(lastName: string, staffId: string, amount: number, dateIso: string, location: string): string {
  return `${lastName}${staffId}${Math.floor(amount)}${formatTransactionDate(dateIso)}${location.replace(/\s+/g, '')}`;
}
function formatCsvCell(value: string | number): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function sendFailureAlert(account: string, subject: string, body: string): Promise<void> {
  try {
    await sendGmail({ from: account, to: FAILURE_ALERT_TO, subject, text: body });
  } catch (err: any) {
    console.error(`failure-alert email to ${FAILURE_ALERT_TO} also failed: ${err?.message || err}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sunday = args.sunday;
  const saturday = prevDayIso(sunday);

  if (weekdayName(sunday) !== 'Sunday') {
    console.error(`[warn] --sunday=${sunday} is a ${weekdayName(sunday)}, not a Sunday. Combining ${saturday} (${weekdayName(saturday)}) + ${sunday} (${weekdayName(sunday)}) anyway.`);
  }

  const satPath = path.join(args.outputDir, `${args.group.filePrefix}disbursements-${saturday}.csv`);
  const sunPath = path.join(args.outputDir, `${args.group.filePrefix}disbursements-${sunday}.csv`);
  const combinedPath = path.join(args.outputDir, `${args.group.filePrefix}disbursements-weekend-${saturday}-to-${sunday}.csv`);

  const missing = [satPath, sunPath].filter((p) => !existsSync(p));
  if (missing.length) {
    const msg = `Weekend disbursements combine for ${saturday} + ${sunday} could not run — missing input file(s):\n${missing.join('\n')}\n\nThe nightly export likely didn't produce one of the days. Check the nightly export / watchdog, then re-run manually:\n  cd ~/kitchen-plugin-yot && npx tsx scripts/combine-weekend-deposits.ts --sunday=${sunday}`;
    console.error(msg);
    if (!args.dryRun && !args.skipEmail) await sendFailureAlert(args.account, `[${args.group.emailSubjectPrefix}] Weekend deposit combine FAILED for ${saturday}+${sunday} — missing file`, msg);
    process.exit(1);
  }

  const satLines = readCsvLines(satPath);
  const sunLines = readCsvLines(sunPath);
  const header = satLines[0] ?? '';
  if (header !== (sunLines[0] ?? '')) {
    const msg = `Weekend disbursements combine aborted — the two files have different headers, so stacking them would misalign columns.\n  ${saturday}: ${satLines[0]}\n  ${sunday}: ${sunLines[0]}`;
    console.error(msg);
    if (!args.dryRun && !args.skipEmail) await sendFailureAlert(args.account, `[${args.group.emailSubjectPrefix}] Weekend deposit combine FAILED for ${saturday}+${sunday} — header mismatch`, msg);
    process.exit(1);
  }

  // disbursements columns: ID, First, Last, Type, Amount, Transaction ID,
  // Location, Disbursement Date (YYYY-MM-DD), Description.
  const ID = 0, FIRST = 1, LAST = 2, TYPE = 3, AMOUNT = 4, LOCATION = 6, DATE = 7, DESCRIPTION = 8;
  const satRows = satLines.slice(1).map((raw) => ({ raw, fields: parseCsvLine(raw) }));
  const sunRows = sunLines.slice(1).map((raw) => ({ raw, fields: parseCsvLine(raw) }));

  // Group by (staff id, location). A stylist who worked the SAME shop on both
  // days collapses into one row with their two amounts summed and a fresh
  // transaction id (Branch rejects duplicate ids, and an id encodes its
  // amount). Entries at DIFFERENT locations are never combined — they stay as
  // separate rows. Single-entry stylists pass through with only their
  // Disbursement Date column rewritten to Monday (see below). Sat rows are
  // inserted before Sun rows so output order is stable.
  const groups = new Map<string, Array<{ raw: string; fields: string[] }>>();
  const order: string[] = [];
  for (const row of [...satRows, ...sunRows]) {
    const key = `${row.fields[ID] ?? ''}|${row.fields[LOCATION] ?? ''}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(row);
  }

  // All weekend disbursements settle on Monday — the nightly export stamps each
  // day's rows as run-date + 1 (Saturday rows → Sunday, Sunday rows → Monday),
  // but Branch doesn't pay out on the weekend, so every row in the combined
  // file is forced onto Monday's date (merged rows below are built with it
  // directly; single-day rows have only their date column rewritten).
  const monday = nextDayIso(sunday);
  let mergedStylistCount = 0;
  const outRows: string[] = [];
  for (const key of order) {
    const list = groups.get(key)!;
    if (list.length === 1) {
      // Single-day entry: keep every cell as-is, just move its disbursement
      // date to Monday (Saturday-only rows would otherwise read Sunday).
      const f = [...list[0]!.fields];
      while (f.length <= DESCRIPTION) f.push('');
      f[DATE] = monday;
      outRows.push(f.map(formatCsvCell).join(','));
      continue;
    }
    mergedStylistCount += 1;
    const f = list[0]!.fields;
    const staffId = f[ID] ?? '';
    const lastName = f[LAST] ?? '';
    const location = f[LOCATION] ?? '';
    const sum = list.reduce((s, r) => s + parseAmount(r.fields[AMOUNT]), 0);
    const amountStr = Number.isInteger(sum) ? String(sum) : sum.toFixed(2);
    const txn = buildTransactionId(lastName, staffId, sum, sunday, location);
    const merged = [staffId, f[FIRST] ?? '', lastName, f[TYPE] ?? 'Deposit', amountStr, txn, location, monday, ''];
    outRows.push(merged.map(formatCsvCell).join(','));
  }

  const combinedCsv = `${[header, ...outRows].join('\n')}\n`;
  mkdirSync(args.outputDir, { recursive: true });
  writeFileSync(combinedPath, combinedCsv, 'utf8');

  // Total is unchanged by merging — sum of every input amount.
  const total = [...satRows, ...sunRows].reduce((s, r) => s + parseAmount(r.fields[AMOUNT]), 0);
  const totalStr = total.toFixed(2);

  const recipient = args.testRecipient || args.group.emailTo;
  const sendTo: string | string[] = args.testRecipient
    ? recipient
    : [recipient, ...args.group.emailCc];
  const subject = `${args.group.emailSubjectPrefix} Disbursements WEEKEND ${saturday} + ${sunday} — ${outRows.length} deposits, $${totalStr}`;
  const mergedNote = mergedStylistCount
    ? `${mergedStylistCount} stylist${mergedStylistCount > 1 ? 's' : ''} who worked both days were merged into a single summed row each.`
    : 'No stylist worked both days, so nothing needed merging.';
  const body = `Combined Saturday + Sunday disbursements file is attached.

  Saturday ${saturday}: ${satRows.length} deposits
  Sunday   ${sunday}: ${sunRows.length} deposits
  Combined: ${outRows.length} deposits, $${totalStr}

${mergedNote} A stylist who worked two DIFFERENT locations over the weekend keeps a separate row per location. Every row carries a Monday (${monday}) disbursement date, and merged rows also carry a fresh transaction id for the summed amount. Auto-generated Sunday afternoon.`;

  let emailStatus: 'sent' | 'skipped' | 'failed' = 'skipped';
  if (args.dryRun || args.skipEmail) {
    const displayRecipients = Array.isArray(sendTo) ? sendTo.join(', ') : sendTo;
    console.error(`[${args.dryRun ? 'dry-run' : 'skip-email'}] would email ${combinedPath} to ${displayRecipients}: ${subject}`);
  } else {
    try {
      await sendGmail({
        from: args.account,
        to: sendTo,
        subject,
        text: body,
        attachments: [{ filename: path.basename(combinedPath), path: combinedPath }],
      });
      emailStatus = 'sent';
    } catch (err: any) {
      emailStatus = 'failed';
      const errMsg = err?.message || String(err);
      console.error(`weekend combine email to ${recipient} failed: ${errMsg}`);
      await sendFailureAlert(args.account, `[${args.group.emailSubjectPrefix}] Weekend deposit combine email to ${recipient} FAILED for ${saturday}+${sunday}`,
        `The combined weekend disbursements email failed to deliver to ${recipient}.\nError: ${errMsg}\nThe file is on disk at ${combinedPath} — send it manually.`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    saturday,
    sunday,
    combinedPath,
    recipient,
    emailStatus,
    saturdayRowCount: satRows.length,
    sundayRowCount: sunRows.length,
    combinedRowCount: outRows.length,
    mergedStylistCount,
    totalAmount: Number(totalStr),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
