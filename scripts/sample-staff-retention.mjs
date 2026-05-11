#!/usr/bin/env node
// Probe script: pulls the StaffRetentionDay report once and dumps its
// structure so we can write the parser against real columns. Run with:
//   node scripts/sample-staff-retention.mjs --team-id=hmx-marketing-team
//
// Outputs:
//   logs/staff-retention-sample-<ts>.xlsx  (raw XLSX for inspection / fixture copy)
//   console: sheet names, first 40 rows with column positions, color-bearing cells

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const { initializeDatabase } = require('../dist/index.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const REPORTS_BASE_URL = 'https://youreontime-reports.azurewebsites.net';
const DEFAULT_ORG_ID = 11082;
const REPORT_TYPE = 'YoureOnTime.Web.TelerikReports.StaffRetentionDay, YoureOnTime.Reports';
const REPORT_NAME = 'StaffRetentionDayReport';
const REPORT_CLASS = 'StaffRetentionDay';
const POLL_DELAY_MS = 1500;
const MAX_POLLS = 120;

// ─── Arg parsing ───────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  }),
);

const teamId = args['team-id'] || args['teamId'] || 'hmx-marketing-team';
const today = new Date().toISOString().slice(0, 10); // 2026-05-10
const firstOfMonth = today.slice(0, 8) + '01';      // 2026-05-01
const startDate = args['start-date'] || args['startDate'] || firstOfMonth;
const endDate = args['end-date'] || args['endDate'] || today;

// ─── Read YOT config from SQLite ──────────────────────────────────────────────
function readYotConfig(teamId) {
  const { sqlite } = initializeDatabase(teamId);
  const row = sqlite.prepare('SELECT value FROM plugin_config WHERE team_id = ? AND key = ?').get(teamId, 'yot');
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed?.apiKey) return null;
    return { apiKey: String(parsed.apiKey), baseUrl: parsed.baseUrl || null };
  } catch {
    return null;
  }
}

const config = readYotConfig(teamId);
if (!config) {
  console.error(`No YOT config for team ${teamId}. POST /config first.`);
  process.exit(1);
}

// ─── Telerik report API helpers ───────────────────────────────────────────────
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'accept': 'application/json, text/plain, */*', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function apiGet(url) {
  const res = await fetch(url, { headers: { 'accept': 'application/json, text/plain, */*' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function apiFetchBuffer(url) {
  const res = await fetch(url, { headers: { 'accept': '*/*' } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── XLSX inspection helpers (using adm-zip, same approach as src/reports/xlsx.ts) ──
function decodeXmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripNamespaces(xml) {
  return xml.replace(/<(\/?)(?:[A-Za-z0-9_]+:)/g, '<$1');
}

function colToIndex(ref) {
  let result = 0;
  for (const ch of ref) {
    if (ch < 'A' || ch > 'Z') break;
    result = result * 26 + (ch.charCodeAt(0) - 64);
  }
  return result - 1;
}

function decodeSharedStrings(xml) {
  const normalizedXml = stripNamespaces(xml);
  const values = [];
  const siMatches = normalizedXml.match(/<si[\s\S]*?<\/si>/g) || [];
  for (const si of siMatches) {
    const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlEntities(m[1]));
    values.push(parts.join(''));
  }
  return values;
}

/**
 * Parse cells from a worksheet XML. Returns an array of rows.
 * Each row is a sparse string array (blanks filled with '').
 * Also returns raw cell objects for style inspection.
 */
function decodeWorksheetWithStyles(xml, sharedStrings) {
  const normalizedXml = stripNamespaces(xml);
  const rows = [];
  const cellMeta = []; // parallel array: cellMeta[r][c] = { s: styleIndex, v: rawValue }
  const rowMatches = normalizedXml.match(/<row\b[\s\S]*?<\/row>/g) || [];
  for (const rowXml of rowMatches) {
    const rowAttrMatch = rowXml.match(/<row\b([^>]*)>/);
    const rowAttr = rowAttrMatch ? rowAttrMatch[1] : '';
    const rAttr = rowAttr.match(/\br="(\d+)"/);
    const rowIdx = rAttr ? parseInt(rAttr[1], 10) - 1 : rows.length;
    while (rows.length <= rowIdx) { rows.push([]); cellMeta.push([]); }
    const row = rows[rowIdx];
    const meta = cellMeta[rowIdx];

    const cellMatches = rowXml.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || [];
    for (const cellXml of cellMatches) {
      const refMatch = cellXml.match(/\br="([A-Z]+)(\d+)"/);
      const colRef = refMatch ? refMatch[1] : null;
      const index = colRef !== null ? colToIndex(colRef) : row.length;
      while (row.length <= index) { row.push(''); meta.push(null); }

      const typeMatch = cellXml.match(/\bt="([^"]+)"/);
      const styleMatch = cellXml.match(/\bs="(\d+)"/);
      const vMatch = cellXml.match(/<v>([\s\S]*?)<\/v>/);
      const isMatch = cellXml.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
      let value = '';
      if (isMatch) {
        value = decodeXmlEntities(isMatch[1]);
      } else if (vMatch) {
        value = decodeXmlEntities(vMatch[1]);
        if (typeMatch?.[1] === 's') {
          const idx = Number(value);
          value = Number.isFinite(idx) ? (sharedStrings[idx] ?? '') : '';
        }
      }
      row[index] = value;
      meta[index] = { s: styleMatch ? Number(styleMatch[1]) : null, rawV: vMatch ? vMatch[1] : null, t: typeMatch?.[1] ?? null };
    }
  }
  return { rows, cellMeta };
}

/**
 * Parse xl/styles.xml to extract fill colors and font colors for each style index.
 * Returns an array of style objects: { fgColor, fontColor }
 */
function parseStyles(xml) {
  if (!xml) return [];
  const norm = stripNamespaces(xml);
  // Extract fills
  const fillsMatch = norm.match(/<fills[^>]*>([\s\S]*?)<\/fills>/);
  const fills = [];
  if (fillsMatch) {
    const fillXmls = fillsMatch[1].match(/<fill\b[\s\S]*?<\/fill>/g) || [];
    for (const fillXml of fillXmls) {
      const fgMatch = fillXml.match(/<fgColor\s+(?:rgb="([^"]*)"[^>]*|theme="([^"]*)"[^>]*|[^>]*)\/>/);
      if (fgMatch) {
        fills.push({ fgColor: fgMatch[1] || `theme:${fgMatch[2]}` || null });
      } else {
        fills.push({ fgColor: null });
      }
    }
  }

  // Extract fonts
  const fontsMatch = norm.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/);
  const fonts = [];
  if (fontsMatch) {
    const fontXmls = fontsMatch[1].match(/<font\b[\s\S]*?<\/font>/g) || [];
    for (const fontXml of fontXmls) {
      const colorMatch = fontXml.match(/<color\s+(?:rgb="([^"]*)"[^>]*|theme="([^"]*)"[^>]*|[^>]*)\/>/);
      if (colorMatch) {
        fonts.push({ fontColor: colorMatch[1] || `theme:${colorMatch[2]}` || null });
      } else {
        fonts.push({ fontColor: null });
      }
    }
  }

  // Extract xf records from cellXfs
  const cellXfsMatch = norm.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  const styles = [];
  if (cellXfsMatch) {
    const xfXmls = cellXfsMatch[1].match(/<xf\b[^>]*\/?>/g) || [];
    for (const xfXml of xfXmls) {
      const fillIdMatch = xfXml.match(/fillId="(\d+)"/);
      const fontIdMatch = xfXml.match(/fontId="(\d+)"/);
      const fillId = fillIdMatch ? Number(fillIdMatch[1]) : 0;
      const fontId = fontIdMatch ? Number(fontIdMatch[1]) : 0;
      styles.push({
        fgColor: fills[fillId]?.fgColor ?? null,
        fontColor: fonts[fontId]?.fontColor ?? null,
      });
    }
  }
  return styles;
}

function readWorkbook(buffer) {
  const zip = new AdmZip(buffer);

  const workbookEntry = zip.getEntry('xl/workbook.xml');
  const relsEntry = zip.getEntry('xl/_rels/workbook.xml.rels');
  if (!workbookEntry || !relsEntry) return [];

  const workbookXml = stripNamespaces(workbookEntry.getData().toString('utf8'));
  const relsXml = stripNamespaces(relsEntry.getData().toString('utf8'));

  const sharedEntry = zip.getEntry('xl/sharedStrings.xml');
  const sharedStrings = sharedEntry ? decodeSharedStrings(sharedEntry.getData().toString('utf8')) : [];

  const stylesEntry = zip.getEntry('xl/styles.xml');
  const styles = stylesEntry ? parseStyles(stylesEntry.getData().toString('utf8')) : [];

  const relMap = new Map();
  for (const match of relsXml.matchAll(/<Relationship[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"|<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    const target = match[1] || match[4];
    const id = match[2] || match[3];
    if (id && target) relMap.set(id, target);
  }

  const sheets = [];
  for (const match of workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*(?:r:id|id)="([^"]+)"/g)) {
    const name = decodeXmlEntities(match[1]);
    const rid = match[2];
    const target = relMap.get(rid);
    if (!target) continue;
    const normalizedTarget = target.startsWith('/xl/')
      ? target.slice(1)
      : target.startsWith('xl/')
        ? target
        : `xl/${target.replace(/^\//, '')}`;
    const entry = zip.getEntry(normalizedTarget);
    if (!entry) continue;
    const { rows, cellMeta } = decodeWorksheetWithStyles(entry.getData().toString('utf8'), sharedStrings);
    sheets.push({ name, rows, cellMeta, styles });
  }
  return sheets;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const baseUrl = (config.baseUrl || REPORTS_BASE_URL).replace(/\/+$/, '');
const organisationId = DEFAULT_ORG_ID;

console.log(`Team:       ${teamId}`);
console.log(`Date range: ${startDate} → ${endDate}`);
console.log(`OrgId:      ${organisationId}`);
console.log(`ApiKey:     ${config.apiKey.slice(0, 8)}…`);
console.log('');

// Step 1: Create a report client
console.log('Creating Telerik report client…');
const clientData = await apiPost(`${baseUrl}/api/reports/clients`, {});
const clientId = clientData.clientId;
console.log(`  clientId=${clientId}`);

// Step 2: Parameter discovery (confirms the report type works)
const paramDiscovery = {
  DateRange: 'Custom',
  StartDate: `${startDate}T00:00:00`,
  EndDate: `${endDate}T23:59:59`,
  FranchiseId: '',
  LocationId: '',
  StaffId: '',
  DoNothing: '',
  Title: 'Staff Retention Report',
  ReportName: REPORT_NAME,
  FrameView: 'True',
  OrganisationId: String(organisationId),
  ReportClass: REPORT_CLASS,
  Key: config.apiKey,
};

console.log('Fetching parameter definitions…');
let paramDefs = [];
try {
  paramDefs = await apiPost(
    `${baseUrl}/api/reports/clients/${clientId}/parameters`,
    { report: REPORT_TYPE, parameterValues: paramDiscovery },
  );
  console.log(`  Got ${paramDefs.length} parameter(s):`);
  for (const p of paramDefs) {
    console.log(`    - ${p.name} (${p.type})${p.isVisible ? '' : ' [hidden]'}`);
  }
} catch (e) {
  console.warn(`  Parameter discovery failed (non-fatal): ${e.message}`);
}

// Step 3: Create instance
const instanceParams = {
  StartDate: `${startDate}T00:00:00`,
  EndDate: `${endDate}T23:59:59`,
  OrganisationId: organisationId,
  LocationId: null,
  StaffId: null,
  FranchiseId: null,
};

console.log('\nCreating report instance…');
const instance = await apiPost(
  `${baseUrl}/api/reports/clients/${clientId}/instances`,
  { report: REPORT_TYPE, parameterValues: instanceParams },
);
const instanceId = instance.instanceId;
console.log(`  instanceId=${instanceId}`);

// Step 4: Create document
console.log('Creating XLSX document…');
const docReq = await apiPost(
  `${baseUrl}/api/reports/clients/${clientId}/instances/${instanceId}/documents`,
  { format: 'XLSX' },
);
const documentId = docReq.documentId;
console.log(`  documentId=${documentId}`);

// Step 5: Poll until ready
console.log('Polling for document readiness…');
let ready = false;
for (let i = 1; i <= MAX_POLLS; i++) {
  const info = await apiGet(
    `${baseUrl}/api/reports/clients/${clientId}/instances/${instanceId}/documents/${documentId}/info`,
  );
  if (info.documentReady === true) { ready = true; break; }
  process.stdout.write(`  poll ${i}/${MAX_POLLS}…\r`);
  await sleep(POLL_DELAY_MS);
}
if (!ready) { console.error('\nDocument never became ready. Aborting.'); process.exit(1); }
console.log('  Document ready!      ');

// Step 6: Download
console.log('Downloading XLSX…');
const buffer = await apiFetchBuffer(
  `${baseUrl}/api/reports/clients/${clientId}/instances/${instanceId}/documents/${documentId}`,
);
console.log(`  ${buffer.byteLength} bytes received`);

// Step 7: Save to logs/
const logsDir = join(REPO_ROOT, 'logs');
mkdirSync(logsDir, { recursive: true });
const xlsxPath = join(logsDir, `staff-retention-sample-${Date.now()}.xlsx`);
writeFileSync(xlsxPath, buffer);
console.log(`\nSaved raw XLSX: ${xlsxPath}`);

// Step 8: Parse and print layout
console.log('\n' + '='.repeat(70));
console.log('WORKBOOK LAYOUT INSPECTION');
console.log('='.repeat(70));

const sheets = readWorkbook(buffer);
console.log(`\nSheets (${sheets.length}): ${sheets.map((s) => s.name).join(', ')}`);

for (const sheet of sheets) {
  const { rows, cellMeta, styles } = sheet;
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`Sheet: "${sheet.name}"  (${rows.length} rows total)`);
  console.log('─'.repeat(70));

  // Print first 40 rows with column positions
  const preview = rows.slice(0, 40);
  preview.forEach((row, idx) => {
    const cells = row.map((v, i) => `[${i}] ${v == null || v === '' ? '·' : String(v).slice(0, 25)}`).join('  ');
    console.log(`  r${String(idx).padStart(2, '0')}: ${cells}`);
  });

  if (rows.length > 40) {
    console.log(`  … (${rows.length - 40} more rows not shown)`);
  }

  // Print color/style metadata for first 20 rows
  console.log('\n--- Cell styles (first 20 rows, colored cells only) ---');
  let coloredFound = 0;
  for (let r = 0; r < Math.min(20, rows.length); r++) {
    const metaRow = cellMeta[r] || [];
    for (let c = 0; c < metaRow.length; c++) {
      const m = metaRow[c];
      if (!m || m.s == null) continue;
      const style = styles[m.s];
      if (!style) continue;
      const hasFg = style.fgColor && style.fgColor !== '00000000' && style.fgColor !== 'FFFFFFFF';
      const hasFont = style.fontColor && style.fontColor !== '00000000' && style.fontColor !== 'FF000000';
      if (hasFg || hasFont) {
        const colLetter = String.fromCharCode(65 + c);
        console.log(`  r${r}c${c}(${colLetter}${r + 1}) value="${rows[r][c]}"  styleIdx=${m.s}  fgColor=${style.fgColor ?? 'none'}  fontColor=${style.fontColor ?? 'none'}`);
        coloredFound++;
      }
    }
  }
  if (coloredFound === 0) {
    console.log('  (no colored cells in first 20 rows — late/early likely encoded as numeric value, not color)');
  }

  // Print all unique non-empty values in column 0 to map row types
  console.log('\n--- Column [0] unique values (row type sniffer) ---');
  const col0Values = [...new Set(rows.map((r) => r[0]).filter((v) => v && String(v).trim()))];
  col0Values.slice(0, 30).forEach((v) => console.log(`  "${v}"`));
  if (col0Values.length > 30) console.log(`  … and ${col0Values.length - 30} more`);
}

console.log('\n' + '='.repeat(70));
console.log('PROBE COMPLETE');
console.log('='.repeat(70));
console.log(`\nXLSX saved to: ${xlsxPath}`);
console.log('Next step: document column layout in scripts/sample-staff-retention-findings.md');
