// Refresh the stored YOT MVC session cookie for a team.
//
// The MVC web-app cookie (app.youreontime.com) expires after a while. When it
// does, YOT does NOT bounce AJAX list endpoints to /Account/Login — it returns
// HTTP 200 with an empty list and a blank "Welcome," header (a "zombie"
// session). This script re-logs in via the stored credentials and persists a
// fresh cookie to plugin_config.
//
// Usage: npx tsx scripts/refresh-mvc-cookie.ts [--team=hmx-marketing-team]

import Database from 'better-sqlite3';
import { loginToMvc } from '../src/drivers/yot-mvc-client';
import type { YotConfig } from '../src/types';

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (const part of argv) {
    if (!part.startsWith('--')) continue;
    const [key, ...rest] = part.slice(2).split('=');
    args.set(key, rest.join('='));
  }
  return args;
}

function dbPathForTeam(teamId: string): string {
  return `/Users/hairmx/.openclaw/kitchen/plugins/yot/yot-${teamId}.db`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const teamId = args.get('team') || 'hmx-marketing-team';
  const db = new Database(dbPathForTeam(teamId));

  const row = db
    .prepare("SELECT value FROM plugin_config WHERE team_id = ? AND key = 'yot'")
    .get(teamId) as { value?: string } | undefined;
  if (!row?.value) throw new Error(`No YOT config found for team ${teamId}`);
  const config = JSON.parse(row.value) as YotConfig;
  if (!config.mvcUserName || !config.mvcPassword || !config.mvcOrganisation) {
    throw new Error(`Team ${teamId} has no MVC login credentials; cannot auto-refresh.`);
  }

  const cookie = await loginToMvc(config);
  db.prepare("UPDATE plugin_config SET value = json_set(value, '$.mvcCookie', ?) WHERE team_id = ? AND key = 'yot'")
    .run(cookie, teamId);

  process.stdout.write(`Refreshed mvcCookie for ${teamId} (${cookie.length} chars, ${cookie.split(';').length} cookies).\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
