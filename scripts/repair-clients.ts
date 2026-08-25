/**
 * Out-of-process roster repair — fetches missing clients BY ID.
 *
 * Runs in a short-lived process with its OWN SQLite connection that checkpoints
 * and closes on exit, for the same reason scripts/sync-clients.ts does: the
 * long-lived kitchen gateway accumulates connections and gets restarted by
 * launchd KeepAlive, and a torn WAL checkpoint mid-write is what corrupted the
 * 1.6 GB DB on 2026-06-18. Never route this through the gateway.
 *
 * Idempotent and interruptible — the work set is recomputed from the DB each
 * run, so re-running only picks up whatever is still missing.
 *
 * Usage:
 *   npx tsx scripts/repair-clients.ts [--team=hmx-marketing-team] [--sinceDays=540]
 *     [--concurrency=8] [--limit=N] [--refreshStaleDays=N] [--dryRun]
 */
import { repairClientsById, selectRepairCandidates } from '../src/sync/repair-clients';
import { NotConfiguredError } from '../src/sync/sync-clients';
import { initializeDatabase, closeDatabase } from '../src/db';
import { writeFileSync } from 'fs';

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (const part of argv) {
    if (!part.startsWith('--')) continue;
    const [key, ...rest] = part.slice(2).split('=');
    args.set(key, rest.join('=') || 'true');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const teamId = args.get('team') || 'hmx-marketing-team';
  const sinceDays = args.has('sinceDays') ? Number(args.get('sinceDays')) : null;
  const refreshStaleDays = args.has('refreshStaleDays') ? Number(args.get('refreshStaleDays')) : null;
  const concurrency = Number(args.get('concurrency')) || 8;
  const limit = args.has('limit') ? Number(args.get('limit')) : null;
  const dryRun = args.get('dryRun') === 'true';

  try {
    if (dryRun) {
      const { sqlite } = initializeDatabase(teamId);
      const ids = selectRepairCandidates(sqlite, { teamId, sinceDays, refreshStaleDays, limit });
      console.log(JSON.stringify({ ok: true, dryRun: true, candidates: ids.length, sample: ids.slice(0, 5) }));
      return;
    }

    const t0 = Date.now();
    const result = await repairClientsById({
      teamId, sinceDays, refreshStaleDays, concurrency, limit,
      onProgress: (done, total, written) => {
        const rate = done / Math.max(1, (Date.now() - t0) / 1000);
        const etaSec = Math.round((total - done) / Math.max(0.01, rate));
        console.log(`  ${done}/${total} fetched · ${written} written · ${rate.toFixed(1)}/s · eta ${Math.floor(etaSec / 60)}m${etaSec % 60}s`);
      },
    });
    const { brokenIds, ...summary } = result;
    console.log(JSON.stringify({ ...summary, broken: brokenIds.length }));
    if (brokenIds.length) {
      // These are permanently unfetchable upstream, not a reason to fail the run.
      const out = `${process.env.HOME}/.openclaw/logs/cron/yot-clients-repair.broken-ids.txt`;
      writeFileSync(out, brokenIds.join('\n') + '\n');
      console.log(`${brokenIds.length} id(s) unfetchable upstream (HTTP 500) -> ${out}`);
    }
  } finally {
    closeDatabase(teamId);
  }
}

main().catch((e) => {
  if (e instanceof NotConfiguredError) { console.error(`NOT_CONFIGURED: ${e.message}`); process.exit(2); }
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
