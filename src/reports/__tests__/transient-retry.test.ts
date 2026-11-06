import { describe, expect, it, vi } from 'vitest';
import { isTransientReportError, retryTransient } from '../transient-retry';

// The exact error that killed the corp export on 2026-10-12 and again on
// 2026-11-05: YOT's Telerik report server timing out on its own SQL.
const SQL_TIMEOUT =
  'Report request failed (POST /instances): 500 ' +
  '{"message":"An error has occurred.","exceptionMessage":"Execution Timeout Expired.  The timeout period elapsed prior to completion of the operation or the server is not responding.","exceptionType":"SqlException","stackTrace":null}';

const XLSX_OUTAGE =
  'Report request failed (GET /instances/49304b7b09f/documents/c01530c87a8b71d9e28cc8/info): 500 ' +
  '{"message":"","exceptionMessage":"XLSX rendering format is not available.","exceptionType":"DocumentRenderException","stackTrace":null}';

describe('isTransientReportError', () => {
  it('treats the YOT SQL timeout as transient', () => {
    expect(isTransientReportError(new Error(SQL_TIMEOUT))).toBe(true);
  });

  it('treats other report-server 5xx and 429 responses as transient', () => {
    expect(isTransientReportError(new Error('Report request failed (POST /instances): 502 Bad Gateway'))).toBe(true);
    expect(isTransientReportError(new Error('Report request failed (GET /instances/x/documents/y/info): 503 '))).toBe(true);
    expect(isTransientReportError(new Error('Report request failed (POST /parameters): 504 '))).toBe(true);
    expect(isTransientReportError(new Error('Report client creation failed: 500 '))).toBe(true);
    expect(isTransientReportError(new Error('Report request failed (POST /instances): 429 '))).toBe(true);
  });

  it('prefers a status attached to the error over the message text', () => {
    expect(isTransientReportError(Object.assign(new Error('boom'), { status: 503 }))).toBe(true);
    expect(isTransientReportError(Object.assign(new Error('Report request failed (POST /instances): 500 x'), { status: 400 }))).toBe(false);
  });

  it('treats network-level failures as transient', () => {
    expect(isTransientReportError(new Error('fetch failed'))).toBe(true);
    expect(isTransientReportError(new Error('connect ETIMEDOUT 20.0.0.1:443'))).toBe(true);
    expect(isTransientReportError(new Error('read ECONNRESET'))).toBe(true);
    expect(isTransientReportError(new Error('socket hang up'))).toBe(true);
    expect(isTransientReportError(new Error('getaddrinfo EAI_AGAIN youreontime-reports.azurewebsites.net'))).toBe(true);
  });

  it('does not retry the XLSX renderer outage — that has its own CSV fallback', () => {
    expect(isTransientReportError(new Error(XLSX_OUTAGE))).toBe(false);
  });

  it('fails fast on auth, client and data errors', () => {
    expect(isTransientReportError(new Error('Report client creation failed: 401 '))).toBe(false);
    expect(isTransientReportError(new Error('Report request failed (POST /instances): 400 bad parameters'))).toBe(false);
    expect(isTransientReportError(new Error('Report request failed (GET /instances/x): 404 '))).toBe(false);
    expect(isTransientReportError(new Error('Staff cashout CSV rows ($100.00) do not reconcile with the report total ($120.00)'))).toBe(false);
    expect(isTransientReportError(new Error('Invalid --date value: nope'))).toBe(false);
    expect(isTransientReportError(null)).toBe(false);
    expect(isTransientReportError('a string, not an Error')).toBe(false);
  });
});

function harness() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => { sleeps.push(ms); now += ms; },
    sleeps,
    advance: (ms: number) => { now += ms; },
  };
}

describe('retryTransient', () => {
  it('returns the first result without sleeping when the call succeeds', async () => {
    const h = harness();
    const fn = vi.fn(async () => 'rows');
    const result = await retryTransient(fn, { windowMs: 50 * 60_000, intervalMs: 5 * 60_000, now: h.now, sleep: h.sleep });
    expect(result).toEqual({ value: 'rows', attempts: 1, failures: [] });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it('waits one interval between transient failures and returns the eventual value', async () => {
    const h = harness();
    const onRetry = vi.fn();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error(SQL_TIMEOUT);
      return 'rows';
    });
    const result = await retryTransient(fn, { windowMs: 50 * 60_000, intervalMs: 5 * 60_000, now: h.now, sleep: h.sleep, onRetry });
    expect(result.value).toBe('rows');
    expect(result.attempts).toBe(3);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toContain('Execution Timeout Expired');
    expect(h.sleeps).toEqual([5 * 60_000, 5 * 60_000]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 2, nextAttemptAt: 10 * 60_000, deadline: 50 * 60_000 }));
  });

  it('rethrows a non-transient error immediately', async () => {
    const h = harness();
    const fn = vi.fn(async () => { throw new Error('Report client creation failed: 401 '); });
    await expect(retryTransient(fn, { windowMs: 50 * 60_000, intervalMs: 5 * 60_000, now: h.now, sleep: h.sleep }))
      .rejects.toThrow('401');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it('stops when the next attempt would start after the deadline and rethrows the last error', async () => {
    // A 50-minute window at 5-minute spacing, each attempt taking ~3 minutes:
    // attempts start at 0, 8, 16, 24, 32, 40, 48 — the next would be 56 > 50.
    const h = harness();
    const fn = vi.fn(async () => { h.advance(3 * 60_000); throw new Error(SQL_TIMEOUT); });
    await expect(retryTransient(fn, { windowMs: 50 * 60_000, intervalMs: 5 * 60_000, now: h.now, sleep: h.sleep }))
      .rejects.toThrow(/Execution Timeout Expired/);
    expect(fn).toHaveBeenCalledTimes(7);
    expect(h.sleeps).toHaveLength(6);
  });

  it('a zero window means a single attempt', async () => {
    const h = harness();
    const fn = vi.fn(async () => { throw new Error(SQL_TIMEOUT); });
    await expect(retryTransient(fn, { windowMs: 0, intervalMs: 5 * 60_000, now: h.now, sleep: h.sleep }))
      .rejects.toThrow(/Execution Timeout Expired/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it('names the attempt count on the final error without losing the original message', async () => {
    const h = harness();
    const fn = vi.fn(async () => { throw new Error(SQL_TIMEOUT); });
    let err: Error | undefined;
    await retryTransient(fn, { windowMs: 5 * 60_000, intervalMs: 5 * 60_000, now: h.now, sleep: h.sleep }).catch((e: Error) => { err = e; });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/after 2 attempts over 5 min/);
    expect(err?.message).toContain('Execution Timeout Expired');
  });
});
