#!/usr/bin/env node
//
// Fetch one full StaffDensity (or StaffTimeCard) report from Telerik and dump
// (a) the raw XLSX bytes to /tmp, (b) the parameter list, and (c) the column
// headers the parser will need to recognize. Used once to derisk the parser
// before writing tests.
//
// Usage:
//   node scripts/sample-coverage-report.mjs --apiKey=KEY --orgId=N --locationId=N \
//     [--report=staff-density|staff-time-card] [--date=YYYY-MM-DD]

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

const REPORTS_BASE_URL = 'https://youreontime-reports.azurewebsites.net';

const REPORTS = {
  'staff-density': {
    reportType: 'YoureOnTime.Web.TelerikReports.StaffDensity, YoureOnTime.Reports',
    discoveryExtras: { Title: 'Staff Density', ReportName: 'StaffDensityReport', ReportClass: 'StaffDensity', FrameView: 'True' },
    instanceShape: ({ date, orgId, locationId }) => ({
      StartDate: date,
      EndDate: date,
      OrganisationId: Number(orgId),
      LocationId: locationId ? Number(locationId) : null,
      FranchiseId: null,
    }),
  },
  'staff-time-card': {
    reportType: 'YoureOnTime.Web.TelerikReports.StaffTimeCard, YoureOnTime.Reports',
    discoveryExtras: { Title: 'Staff Time Card', ReportName: 'StaffTimeCardReport', ReportClass: 'StaffTimeCard', FrameView: 'True' },
    instanceShape: ({ date, orgId, locationId }) => ({
      StartDate: date,
      EndDate: date,
      OrganisationId: Number(orgId),
      LocationId: locationId ? Number(locationId) : null,
      StaffId: null,
    }),
  },
};

function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function newClient() {
  const r = await fetch(`${REPORTS_BASE_URL}/api/reports/clients`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error(`clients POST ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return JSON.parse(await r.text()).clientId;
}

async function call(clientId, path, method, body) {
  const r = await fetch(`${REPORTS_BASE_URL}/api/reports/clients/${clientId}${path}`, {
    method,
    headers: { accept: 'application/json, text/plain, */*', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function fetchBuffer(clientId, path) {
  const r = await fetch(`${REPORTS_BASE_URL}/api/reports/clients/${clientId}${path}`, { method: 'GET', headers: { accept: '*/*' } });
  if (!r.ok) throw new Error(`GET ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return Buffer.from(await r.arrayBuffer());
}

function inspectXlsx(buffer) {
  const zip = new AdmZip(buffer);
  const sharedStringsEntry = zip.getEntry('xl/sharedStrings.xml');
  const shared = [];
  if (sharedStringsEntry) {
    const xml = sharedStringsEntry.getData().toString('utf8');
    for (const m of xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) shared.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  }
  const sheetEntries = zip.getEntries().filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.entryName));
  const sheets = [];
  for (const e of sheetEntries) {
    const xml = e.getData().toString('utf8');
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c[^>]*?(?:t="([^"]*)")?[^>]*>([\s\S]*?)<\/c>/g)) {
        const t = cellMatch[1];
        const v = cellMatch[2];
        const valueMatch = v.match(/<v>([\s\S]*?)<\/v>/);
        const inlineMatch = v.match(/<is><t[^>]*>([\s\S]*?)<\/t><\/is>/);
        if (inlineMatch) cells.push(inlineMatch[1]);
        else if (!valueMatch) cells.push('');
        else if (t === 's') cells.push(shared[Number(valueMatch[1])] || '');
        else cells.push(valueMatch[1]);
      }
      rows.push(cells);
    }
    sheets.push({ name: e.entryName, rows });
  }
  return sheets;
}

async function main() {
  const args = parseArgs();
  const reportKey = args.report || 'staff-density';
  const cfg = REPORTS[reportKey];
  if (!cfg) { console.error(`Unknown --report=${reportKey}. Try staff-density or staff-time-card.`); process.exit(1); }
  if (!args.apiKey || !args.orgId) { console.error('Missing --apiKey and/or --orgId'); process.exit(1); }
  const date = args.date || new Date().toISOString().slice(0, 10);

  const clientId = await newClient();
  const discovery = {
    DateRange: 'Custom',
    StartDate: date,
    EndDate: date,
    FranchiseId: '',
    LocationId: args.locationId || '',
    StaffId: '',
    DoNothing: '',
    OrganisationId: args.orgId,
    Key: args.apiKey,
    ...cfg.discoveryExtras,
  };
  console.log(`\n=== Probing ${reportKey} parameters ===`);
  const params = await call(clientId, '/parameters', 'POST', { report: cfg.reportType, parameterValues: discovery });
  console.log(`Got ${params.length} parameter(s):`);
  for (const p of params) console.log(`  - ${p.name} (${p.type})`);

  const instanceParams = cfg.instanceShape({ date, orgId: args.orgId, locationId: args.locationId });
  console.log(`\n=== Creating instance ===`);
  console.log('  parameterValues:', JSON.stringify(instanceParams));
  const instance = await call(clientId, '/instances', 'POST', { report: cfg.reportType, parameterValues: instanceParams });
  console.log(`  instanceId=${instance.instanceId}`);

  console.log(`\n=== Creating document (XLSX) ===`);
  const doc = await call(clientId, `/instances/${instance.instanceId}/documents`, 'POST', { format: 'XLSX' });
  console.log(`  documentId=${doc.documentId}`);

  for (let i = 0; i < 30; i++) {
    const info = await call(clientId, `/instances/${instance.instanceId}/documents/${doc.documentId}/info`, 'GET');
    if (info.documentReady === true) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('  document ready, downloading...');
  const buffer = await fetchBuffer(clientId, `/instances/${instance.instanceId}/documents/${doc.documentId}`);
  const filePath = join(tmpdir(), `yot-${reportKey}-${date}.xlsx`);
  writeFileSync(filePath, buffer);
  console.log(`  saved ${buffer.byteLength} bytes to ${filePath}`);

  console.log(`\n=== Sheet inspection ===`);
  const sheets = inspectXlsx(buffer);
  for (const sheet of sheets) {
    console.log(`\n[${sheet.name}] ${sheet.rows.length} rows`);
    const preview = sheet.rows.slice(0, 12);
    preview.forEach((row, i) => console.log(`  row ${i}: ${row.map((c) => JSON.stringify(c)).join(' | ')}`));
    if (sheet.rows.length > 12) console.log(`  …and ${sheet.rows.length - 12} more rows`);
  }
}

main().catch((err) => { console.error(err); process.exit(2); });
