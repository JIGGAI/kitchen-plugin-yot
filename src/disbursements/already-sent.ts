/**
 * Has this group's payout for this date already gone out for real?
 *
 * The launchd job fires again a few times after the main run as a catch-up
 * (`--skip-if-sent`), so a run that crashed, exhausted its retry windows or
 * never started because the machine was asleep gets another go without
 * anyone noticing first. Those extra firings must do nothing on a normal
 * night, and this is the check that makes them do nothing.
 *
 * "For real" is strict on purpose — a second payout email is worse than a
 * redundant run being skipped, but a skipped payout is worse than both:
 *   - the diagnostics file is written last, after the email step, so its
 *     presence means the run reached the end;
 *   - a dry run or a --skip-email run leaves the same files behind and does
 *     not count (that is what masked a missed send on 2026-06-07);
 *   - a run redirected with --test-recipient does not count either.
 * Anything unreadable or unexpected answers "not sent", so the run proceeds.
 */
import { existsSync, readFileSync } from 'node:fs';

export type SentCheck = { sent: boolean; reason: string };

export function payoutAlreadySent(diagnosticsPath: string, expected: { date: string; groupId: string; recipient: string }): SentCheck {
  if (!existsSync(diagnosticsPath)) return { sent: false, reason: 'no diagnostics file for this date' };
  let diag: Record<string, unknown>;
  try {
    diag = JSON.parse(readFileSync(diagnosticsPath, 'utf8')) as Record<string, unknown>;
  } catch (err: any) {
    return { sent: false, reason: `diagnostics unreadable: ${err?.message || err}` };
  }
  if (!diag || typeof diag !== 'object') return { sent: false, reason: 'diagnostics is not an object' };
  if (diag.date !== expected.date) return { sent: false, reason: `diagnostics is for ${String(diag.date)}` };
  if (diag.groupId !== expected.groupId) return { sent: false, reason: `diagnostics is for group ${String(diag.groupId)}` };
  if (diag.dryRun !== false) return { sent: false, reason: 'last run was a dry run' };
  if (diag.skipEmail !== false) return { sent: false, reason: 'last run skipped the email' };
  if (diag.disbursementsEmailStatus !== 'sent') return { sent: false, reason: `email status is ${String(diag.disbursementsEmailStatus)}` };
  if (diag.disbursementsRecipient !== expected.recipient) return { sent: false, reason: `last run emailed ${String(diag.disbursementsRecipient)}, not the group's recipient` };
  return { sent: true, reason: `emailed ${expected.recipient} at ${String(diag.generatedAt)}` };
}
