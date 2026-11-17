import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { payoutAlreadySent } from '../already-sent';

const dir = mkdtempSync(path.join(tmpdir(), 'already-sent-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const expected = { date: '2026-11-16', groupId: 'corp', recipient: 'payroll@example.com' };
const sentRun = {
  date: '2026-11-16',
  groupId: 'corp',
  generatedAt: '2026-11-17T02:35:56.000Z',
  dryRun: false,
  skipEmail: false,
  disbursementsRecipient: 'payroll@example.com',
  disbursementsEmailStatus: 'sent',
};
let n = 0;
function file(content: unknown): string {
  const p = path.join(dir, `diag-${n++}.json`);
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

describe('payoutAlreadySent', () => {
  it('is true only for a completed real run that emailed the group recipient', () => {
    expect(payoutAlreadySent(file(sentRun), expected).sent).toBe(true);
  });

  it('is false when the main run never wrote diagnostics (crashed, or never started)', () => {
    expect(payoutAlreadySent(path.join(dir, 'missing.json'), expected)).toEqual({ sent: false, reason: 'no diagnostics file for this date' });
  });

  it('does not count a dry run or a --skip-email run left on disk', () => {
    expect(payoutAlreadySent(file({ ...sentRun, dryRun: true, disbursementsEmailStatus: 'skipped' }), expected).sent).toBe(false);
    expect(payoutAlreadySent(file({ ...sentRun, dryRun: true }), expected).sent).toBe(false);
    expect(payoutAlreadySent(file({ ...sentRun, skipEmail: true, disbursementsEmailStatus: 'skipped' }), expected).sent).toBe(false);
  });

  it('does not count a failed email', () => {
    expect(payoutAlreadySent(file({ ...sentRun, disbursementsEmailStatus: 'failed' }), expected).sent).toBe(false);
  });

  it('does not count a run redirected with --test-recipient', () => {
    expect(payoutAlreadySent(file({ ...sentRun, disbursementsRecipient: 'someone-else@example.com' }), expected).sent).toBe(false);
  });

  it('does not count another date, another group, or legacy diagnostics without the fields', () => {
    expect(payoutAlreadySent(file({ ...sentRun, date: '2026-11-15' }), expected).sent).toBe(false);
    expect(payoutAlreadySent(file({ ...sentRun, groupId: 'hmx-group' }), expected).sent).toBe(false);
    expect(payoutAlreadySent(file({ date: '2026-11-16', groupId: 'corp' }), expected).sent).toBe(false);
  });

  it('treats an unreadable file as not sent, so the run proceeds', () => {
    expect(payoutAlreadySent(file('{ truncated'), expected).sent).toBe(false);
    expect(payoutAlreadySent(file('null'), expected).sent).toBe(false);
  });
});
