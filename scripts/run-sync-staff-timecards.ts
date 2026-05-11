import { syncStaffTimecards } from '../src/reports/sync-staff-timecards';

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (const part of argv) {
    if (!part.startsWith('--')) continue;
    const [key, ...rest] = part.slice(2).split('=');
    if (key) args.set(key, rest.join('='));
  }
  return args;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonth(): string {
  return today().slice(0, 8) + '01';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const teamId = args.get('team-id') || args.get('team');
  if (!teamId) {
    process.stderr.write('--team-id is required\n');
    process.exit(2);
  }

  const startDate = args.get('start-date') || firstOfMonth();
  const endDate = args.get('end-date') || today();

  const organisationIdRaw = args.get('organisation-id') || args.get('org') || '11082';
  const organisationId = Number(organisationIdRaw);
  if (!Number.isFinite(organisationId)) {
    process.stderr.write(`Invalid --organisation-id: ${organisationIdRaw}\n`);
    process.exit(2);
  }

  const chunkDaysRaw = args.get('chunk-days');
  const chunkDays = chunkDaysRaw ? Number(chunkDaysRaw) : undefined;

  console.log(`[sync-staff-timecards] team=${teamId} ${startDate} → ${endDate} org=${organisationId}`);
  const result = await syncStaffTimecards({ teamId, startDate, endDate, organisationId, chunkDays });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[sync-staff-timecards] FAILED: ${message}\n`);
  process.exit(1);
});
