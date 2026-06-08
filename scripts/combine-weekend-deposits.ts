// Weekend Branch disbursements combiner.
//
// Runs Sundays at 21:30 ET (30 min after the Sunday nightly export) via
// ~/Library/LaunchAgents/com.hairmx.weekend-deposit-combine.plist. Reads the
// two per-day disbursements CSVs the nightly export already wrote —
//   ~/hmx-reports/disbursements-<saturday>.csv
//   ~/hmx-reports/disbursements-<sunday>.csv
// — stacks their rows under one header (a stylist who worked both days keeps
// one row per day, each with its own date-encoded transaction id), writes
//   ~/hmx-reports/disbursements-weekend-<saturday>-to-<sunday>.csv
// and emails the combined file to Miranda.
//
// This is ADDITIVE: the individual Saturday and Sunday emails still go out at
// their normal 21:00 ET times. This job does NOT touch the export, the live
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

const NEW_YORK_TZ = 'America/New_York';
const DEFAULT_OUTPUT_DIR = path.join(homedir(), 'hmx-reports');
const DEFAULT_ACCOUNT = 'govna.assistant@gmail.com';
const DEFAULT_RECIPIENT = 'Miranda.hmx.corp@hairmx.net';
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

  const satPath = path.join(args.outputDir, `disbursements-${saturday}.csv`);
  const sunPath = path.join(args.outputDir, `disbursements-${sunday}.csv`);
  const combinedPath = path.join(args.outputDir, `disbursements-weekend-${saturday}-to-${sunday}.csv`);

  const missing = [satPath, sunPath].filter((p) => !existsSync(p));
  if (missing.length) {
    const msg = `Weekend disbursements combine for ${saturday} + ${sunday} could not run — missing input file(s):\n${missing.join('\n')}\n\nThe nightly export likely didn't produce one of the days. Check the nightly export / watchdog, then re-run manually:\n  cd ~/kitchen-plugin-yot && npx tsx scripts/combine-weekend-deposits.ts --sunday=${sunday}`;
    console.error(msg);
    if (!args.dryRun && !args.skipEmail) await sendFailureAlert(args.account, `[HMX] Weekend deposit combine FAILED for ${saturday}+${sunday} — missing file`, msg);
    process.exit(1);
  }

  const satLines = readCsvLines(satPath);
  const sunLines = readCsvLines(sunPath);
  const header = satLines[0] ?? '';
  if (header !== (sunLines[0] ?? '')) {
    const msg = `Weekend disbursements combine aborted — the two files have different headers, so stacking them would misalign columns.\n  ${saturday}: ${satLines[0]}\n  ${sunday}: ${sunLines[0]}`;
    console.error(msg);
    if (!args.dryRun && !args.skipEmail) await sendFailureAlert(args.account, `[HMX] Weekend deposit combine FAILED for ${saturday}+${sunday} — header mismatch`, msg);
    process.exit(1);
  }

  const satRows = satLines.slice(1);
  const sunRows = sunLines.slice(1);
  const combinedRows = [...satRows, ...sunRows];
  const combinedCsv = `${[header, ...combinedRows].join('\n')}\n`;

  mkdirSync(args.outputDir, { recursive: true });
  writeFileSync(combinedPath, combinedCsv, 'utf8');

  // Amount is column index 4 in the disbursements CSV (ID, First, Last, Type,
  // Amount, …). Sum it for the email summary; never let a parse blip throw.
  const amountColumn = 4;
  let total = 0;
  for (const row of combinedRows) {
    const cell = parseCsvLine(row)[amountColumn] ?? '';
    const n = Number(cell.replace(/[$,\s]/g, ''));
    if (Number.isFinite(n)) total += n;
  }
  const totalStr = total.toFixed(2);

  const recipient = args.testRecipient || DEFAULT_RECIPIENT;
  const subject = `HMX Disbursements WEEKEND ${saturday} + ${sunday} — ${combinedRows.length} deposits, $${totalStr}`;
  const body = `Combined Saturday + Sunday disbursements file is attached.

  Saturday ${saturday}: ${satRows.length} deposits
  Sunday   ${sunday}: ${sunRows.length} deposits
  Combined: ${combinedRows.length} deposits, $${totalStr}

This file stacks the two nightly disbursements CSVs you already received for ${saturday} and ${sunday} into one upload. Each row keeps its own day's transaction id and disbursement date. Auto-generated Sunday night.`;

  let emailStatus: 'sent' | 'skipped' | 'failed' = 'skipped';
  if (args.dryRun || args.skipEmail) {
    console.error(`[${args.dryRun ? 'dry-run' : 'skip-email'}] would email ${combinedPath} to ${recipient}: ${subject}`);
  } else {
    try {
      await sendGmail({
        from: args.account,
        to: recipient,
        subject,
        text: body,
        attachments: [{ filename: path.basename(combinedPath), path: combinedPath }],
      });
      emailStatus = 'sent';
    } catch (err: any) {
      emailStatus = 'failed';
      const errMsg = err?.message || String(err);
      console.error(`weekend combine email to ${recipient} failed: ${errMsg}`);
      await sendFailureAlert(args.account, `[HMX] Weekend deposit combine email to ${recipient} FAILED for ${saturday}+${sunday}`,
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
    combinedRowCount: combinedRows.length,
    totalAmount: Number(totalStr),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
