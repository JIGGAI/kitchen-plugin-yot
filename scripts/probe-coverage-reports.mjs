#!/usr/bin/env node
//
// Probe Telerik for the LocationAvailability and StaffTimeCard reports.
//
// Uses the same flow that src/reports/client.ts implements:
//   1. POST /api/reports/clients              → { clientId }
//   2. POST /api/reports/clients/<id>/parameters with { report, parameterValues }
//      → ParameterDefinition[]  (or an error if reportType is wrong)
//
// We only call (1) and (2) — no instance, no document, no polling — so this
// is a sub-second sanity check.
//
// Usage:
//   node scripts/probe-coverage-reports.mjs --apiKey=<KEY> --orgId=<N> [--locationId=<N>]
//
// Run with `--apiKey=$(openclaw config get plugins.entries.yot.config.apiKey)`
// or paste the value inline.

const REPORTS_BASE_URL = 'https://youreontime-reports.azurewebsites.net';

function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function createReportsClient() {
  const res = await fetch(`${REPORTS_BASE_URL}/api/reports/clients`, {
    method: 'POST',
    headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json' },
    body: '{}',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`clients POST failed: ${res.status} ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  if (!data.clientId) throw new Error('clients POST returned no clientId');
  return String(data.clientId);
}

async function getParameters(clientId, reportType, parameterValues) {
  const res = await fetch(`${REPORTS_BASE_URL}/api/reports/clients/${clientId}/parameters`, {
    method: 'POST',
    headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json' },
    body: JSON.stringify({ report: reportType, parameterValues }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return JSON.parse(text);
}

function summarizeParameter(p) {
  const visibility = p.isVisible ? '' : ' [hidden]';
  const nullable = p.allowNull ? ' [nullable]' : '';
  let extra = '';
  if (Array.isArray(p.availableValues) && p.availableValues.length > 0) {
    if (p.availableValues.length <= 6) {
      extra = ' values=' + JSON.stringify(p.availableValues.map((v) => v?.value ?? v));
    } else {
      extra = ` (${p.availableValues.length} available values)`;
    }
  }
  return `  - ${p.name} (${p.type})${visibility}${nullable}${extra}`;
}

async function probe(label, reportType, parameterValues) {
  const clientId = await createReportsClient();
  console.log(`\n=== ${label}\n    reportType: ${reportType}`);
  try {
    const params = await getParameters(clientId, reportType, parameterValues);
    console.log(`    OK — ${params.length} parameter(s):`);
    for (const p of params) console.log(summarizeParameter(p));
    return { ok: true, reportType, params };
  } catch (err) {
    const status = err.status || 'ERR';
    const snippet = (err.body || err.message || '').toString().slice(0, 240).replace(/\s+/g, ' ');
    console.log(`    FAIL — ${status}: ${snippet}`);
    return { ok: false, reportType, error: err };
  }
}

async function main() {
  const args = parseArgs();
  if (!args.apiKey) {
    console.error('Missing --apiKey=<YOT_API_KEY>');
    console.error('  e.g. node scripts/probe-coverage-reports.mjs --apiKey=$(openclaw config get plugins.entries.yot.config.apiKey)');
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const baseDiscovery = {
    DateRange: 'Custom',
    StartDate: today,
    EndDate: today,
    FranchiseId: '',
    LocationId: args.locationId || '',
    StaffId: '',
    DoNothing: '',
    OrganisationId: args.orgId || '',
    Key: args.apiKey,
  };

  const candidates = [
    {
      label: 'LocationAvailability — guess A',
      reportType: 'YoureOnTime.Web.TelerikReports.LocationAvailability, YoureOnTime.Reports',
      values: { ...baseDiscovery, OnlyShowWorking: 'Rostered', Title: 'Location Availability', ReportName: 'LocationAvailabilityReport', ReportClass: 'LocationAvailability', FrameView: 'True' },
    },
    {
      label: 'LocationAvailability — guess B (StaffDensity)',
      reportType: 'YoureOnTime.Web.TelerikReports.StaffDensity, YoureOnTime.Reports',
      values: { ...baseDiscovery, OnlyShowWorking: 'Rostered', Title: 'Staff Density', ReportName: 'StaffDensityReport', ReportClass: 'StaffDensity', FrameView: 'True' },
    },
    {
      label: 'StaffTimeCard — guess A',
      reportType: 'YoureOnTime.Web.TelerikReports.StaffTimeCard, YoureOnTime.Reports',
      values: { ...baseDiscovery, Title: 'Staff Time Card', ReportName: 'StaffTimeCardReport', ReportClass: 'StaffTimeCard', FrameView: 'True' },
    },
  ];

  const results = [];
  for (const c of candidates) {
    results.push(await probe(c.label, c.reportType, c.values));
  }

  console.log('\n--- Summary ---');
  const successes = results.filter((r) => r.ok);
  const failures = results.filter((r) => !r.ok);
  console.log(`Successes: ${successes.length}`);
  for (const r of successes) console.log(`  ✓ ${r.reportType}`);
  console.log(`Failures: ${failures.length}`);
  for (const r of failures) console.log(`  ✗ ${r.reportType}`);

  if (successes.length === 0) process.exit(2);
}

main().catch((err) => { console.error(err); process.exit(2); });
