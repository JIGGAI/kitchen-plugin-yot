// One-off, idempotent builder for the HMX GROUP Branch Daily Totals
// spreadsheet. Creates the two template tabs the nightly export needs:
//   BRANCH MASTER    — per-day tab template: two side-by-side tables
//                      (BRANCH at A-C, YOT at E-G) keyed by location.
//                      HMX GROUP has 4 locations, so they occupy rows 4-7
//                      and the TOTAL row is 10 (CORP uses 4-18 / 21).
//   CSV BLANK MASTER — header-only tab supplying the CSV mirror column
//                      layout, matching CORP's Branch upload format.
// Safe to re-run: existing tabs are left alone, values are rewritten.
import { addTab, deleteTab, listTabs, updateValues } from '../src/sheets/google-sheets';

const SHEET_ID = '1LsYEOuwjxmiCrbuTmAgD5-PTXxNL2gjCmKWaHhqxToc';
const BRANCH_MASTER_TAB = 'BRANCH MASTER';
const CSV_BLANK_TAB = 'CSV BLANK MASTER';
const LOCATIONS = [
  'Middleburg Fl',
  'Treaty Oaks St. Aug. FL.',
  'World of Golf Fl.',
  'Yulee Rt. 200 FL',
];
const FIRST_ROW = 4;
const TOTAL_ROW = 10;

async function ensureTab(title: string): Promise<void> {
  const tabs = await listTabs(SHEET_ID);
  if (tabs.some((t) => t.title === title)) {
    console.log(`tab '${title}' already exists`);
    return;
  }
  await addTab(SHEET_ID, title);
  console.log(`created tab '${title}'`);
}

async function main(): Promise<void> {
  await ensureTab(BRANCH_MASTER_TAB);
  await ensureTab(CSV_BLANK_TAB);

  const lastRow = FIRST_ROW + LOCATIONS.length - 1;
  const grid: (string | number)[][] = [];
  grid.push(['DATE', '', '', '', '', '', '']);
  grid.push(['LOCATION', 'BRANCH', 'NOTES', '', 'LOCATION', 'YOT', 'NOTES']);
  grid.push(['', '', '', '', '', '', '']);
  for (const loc of LOCATIONS) {
    grid.push([loc, '', '', '', loc, '', '']);
  }
  while (grid.length < TOTAL_ROW - 1) grid.push(['', '', '', '', '', '', '']);
  grid.push(['', 'TOTAL', `=sum(B${FIRST_ROW}:B${lastRow})`, '', '', 'TOTAL', `=SUM(F${FIRST_ROW}:F${lastRow})`]);
  await updateValues(SHEET_ID, `'${BRANCH_MASTER_TAB}'!A1:G${TOTAL_ROW}`, grid);
  console.log(`wrote ${BRANCH_MASTER_TAB}: ${LOCATIONS.length} locations rows ${FIRST_ROW}-${lastRow}, TOTAL row ${TOTAL_ROW}`);

  await updateValues(SHEET_ID, `'${CSV_BLANK_TAB}'!A1:H1`, [[
    'ID', 'First Name', 'Last Name', 'Type', 'Amount', 'Transaction ID', 'Location', 'Disbursement Date (YYYY-MM-DD)',
  ]]);
  console.log(`wrote ${CSV_BLANK_TAB} header`);

  // Drop the default empty tab Google created with the spreadsheet, but only
  // once both real tabs exist (a spreadsheet must always keep >= 1 tab).
  const after = await listTabs(SHEET_ID);
  const stray = after.find((t) => /^Sheet\d+$/.test(t.title));
  if (stray && after.length > 2) {
    await deleteTab(SHEET_ID, stray.sheetId);
    console.log(`deleted default tab '${stray.title}'`);
  }

  for (const t of await listTabs(SHEET_ID)) console.log('final tab:', JSON.stringify(t.title));
}

main().catch((err) => { console.error(err); process.exit(1); });
