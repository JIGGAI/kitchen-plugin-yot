// CLI driver for the nightly new-client-cohort recompute job.
//
// Usage:
//   npx tsx scripts/run-new-client-cohort-retention.ts --team=hmx-marketing-team
//
// Optional --startMonth=YYYY-MM and --endMonth=YYYY-MM to override the
// default (last 6 months ending this month).

import { computeNewClientCohortRetention } from '../src/reports/compute-new-client-cohort-retention';

function parseArgs(argv: string[]): { teamId: string; startMonth?: string; endMonth?: string } {
  const map = new Map<string, string>();
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) map.set(a.slice(2), 'true');
    else map.set(a.slice(2, eq), a.slice(eq + 1));
  }
  const teamId = map.get('team') || map.get('teamId') || '';
  if (!teamId) throw new Error('--team=<id> is required');
  const startMonth = map.get('startMonth');
  const endMonth = map.get('endMonth');
  if (startMonth && !/^\d{4}-\d{2}$/.test(startMonth)) throw new Error('--startMonth must be YYYY-MM');
  if (endMonth && !/^\d{4}-\d{2}$/.test(endMonth)) throw new Error('--endMonth must be YYYY-MM');
  return { teamId, startMonth, endMonth };
}

const args = parseArgs(process.argv.slice(2));
const startedAt = Date.now();
const result = computeNewClientCohortRetention(args);
const elapsedMs = Date.now() - startedAt;
console.log(JSON.stringify({ ...result, elapsedMs }, null, 2));
