import { syncRevenueFactsFromDailyRevenueSummary } from '../src/reports/sync-revenue-facts';

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (const part of argv) {
    if (!part.startsWith('--')) continue;
    const [key, ...rest] = part.slice(2).split('=');
    args.set(key, rest.join('='));
  }
  return args;
}

function asDateIso(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing --${label}=YYYY-MM-DD`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  throw new Error(`Invalid --${label} value: ${value}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const teamId = args.get('team') || 'hmx-marketing-team';
  const startDateIso = asDateIso(args.get('start'), 'start');
  const endDateIso = asDateIso(args.get('end'), 'end');
  const organisationIdRaw = args.get('organisationId') || args.get('org') || '11082';
  const organisationId = Number(organisationIdRaw);
  if (!Number.isFinite(organisationId)) throw new Error(`Invalid organisationId: ${organisationIdRaw}`);
  const locationIdRaw = args.get('locationId');
  const staffIdRaw = args.get('staffId');
  const dayOfWeekRaw = args.get('dayOfWeek');

  const result = await syncRevenueFactsFromDailyRevenueSummary({
    teamId,
    startDateIso,
    endDateIso,
    organisationId,
    locationId: locationIdRaw ? Number(locationIdRaw) : null,
    staffId: staffIdRaw ? Number(staffIdRaw) : null,
    dayOfWeek: dayOfWeekRaw ? Number(dayOfWeekRaw) : null,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
