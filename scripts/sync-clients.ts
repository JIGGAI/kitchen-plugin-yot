/**
 * Out-of-process YOT clients sync.
 *
 * Runs the resumable clients walk in a dedicated, short-lived process with its
 * OWN single SQLite connection, then checkpoints the WAL and closes cleanly on
 * exit. This is the corruption-safe replacement for curling the long-lived
 * kitchen gateway's POST /clients/sync (see src/sync/sync-clients.ts header).
 *
 * Loops resumable chunks until a full pass completes (or a chunk errors after
 * its per-page retries). Resumes from the persisted cursor across runs, so it's
 * idempotent and safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/sync-clients.ts [--team=hmx-marketing-team] \
 *     [--maxPages=1000] [--maxChunks=50] [--pageTimeoutMs=60000] [--startPage=N]
 */
import { runClientsSync, NotConfiguredError } from '../src/sync/sync-clients';
import { closeDatabase } from '../src/db';

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
  const maxPages = Number(args.get('maxPages')) || 1000;
  const maxChunks = Number(args.get('maxChunks')) || 50;
  const pageTimeoutMs = Number(args.get('pageTimeoutMs')) || 60000;
  const startPageArg = args.get('startPage');
  const startPage = startPageArg ? Number(startPageArg) : undefined;

  let totalSynced = 0;
  let lastResult: any = null;
  let complete = false;

  try {
    for (let chunk = 1; chunk <= maxChunks; chunk++) {
      const result = await runClientsSync({
        teamId,
        // Only the first chunk honors an explicit startPage; later chunks resume
        // from the cursor the previous chunk persisted.
        startPage: chunk === 1 ? startPage : undefined,
        maxPages,
        pageTimeoutMs,
      });
      lastResult = result;
      totalSynced += result.synced;
      console.log(`chunk ${chunk}: synced=${result.synced} fromPage=${result.fromPage} lastPage=${result.lastPage} stop=${result.stoppedBecause} next=${result.nextPage ?? 'done'}`);
      if (result.complete) { complete = true; break; }
      if (result.stoppedBecause === 'error') break; // cursor preserved; next run resumes
    }
  } finally {
    // Checkpoint the WAL and release the file cleanly — the whole point of
    // running this out-of-process.
    closeDatabase(teamId);
  }

  const summary = {
    ok: true,
    complete,
    totalSynced,
    totalClients: lastResult?.totalClients ?? null,
    nextPage: lastResult?.nextPage ?? null,
    stoppedBecause: lastResult?.stoppedBecause ?? null,
    error: lastResult?.error ?? null,
  };
  console.log(JSON.stringify(summary));
  // Non-zero exit if we stopped on an error so launchd surfaces it (cursor is
  // preserved, so the next run picks up where this one left off).
  if (lastResult?.stoppedBecause === 'error') process.exit(1);
}

main().catch((e) => {
  if (e instanceof NotConfiguredError) { console.error(`NOT_CONFIGURED: ${e.message}`); process.exit(2); }
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
