import { afterEach, describe, expect, it, vi } from 'vitest';
import type { sheets_v4 } from 'googleapis';
import {
  __setSheetsTestHooks,
  addTab,
  deleteTab,
  getValues,
  isTransientSheetsError,
  replaceValues,
  sheetsRetryFailures,
  updateValues,
} from '../google-sheets';

// What ended the corp export on 2026-11-16: node-fetch's AbortError, surfaced
// by googleapis with nothing but this message.
function aborted(): Error {
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}
function http(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status, response: { status } });
}

function fakeClient(overrides: {
  valuesGet?: ReturnType<typeof vi.fn>;
  valuesUpdate?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
  batchUpdate?: ReturnType<typeof vi.fn>;
}): sheets_v4.Sheets {
  return {
    spreadsheets: {
      values: { get: overrides.valuesGet, update: overrides.valuesUpdate },
      get: overrides.get,
      batchUpdate: overrides.batchUpdate,
    },
  } as unknown as sheets_v4.Sheets;
}

function install(client: sheets_v4.Sheets) {
  const sleeps: number[] = [];
  let now = 0;
  __setSheetsTestHooks({
    client,
    timing: { windowMs: 6 * 60_000, intervalMs: 20_000, now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } },
  });
  return sleeps;
}

afterEach(() => {
  __setSheetsTestHooks();
  vi.restoreAllMocks();
});

describe('isTransientSheetsError', () => {
  it('retries the abort that killed the 2026-11-16 corp export', () => {
    expect(isTransientSheetsError(aborted())).toBe(true);
    expect(isTransientSheetsError(new Error('The operation was aborted.'))).toBe(true);
  });

  it('retries timeouts, 5xx, 429 and network errors', () => {
    expect(isTransientSheetsError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTransientSheetsError(http(500))).toBe(true);
    expect(isTransientSheetsError(http(503, 'The service is currently unavailable.'))).toBe(true);
    expect(isTransientSheetsError(http(429, 'Quota exceeded'))).toBe(true);
    expect(isTransientSheetsError(Object.assign(new Error('request failed'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientSheetsError(new Error('request to https://sheets.googleapis.com/ failed, reason: read ETIMEDOUT'))).toBe(true);
    expect(isTransientSheetsError(Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ENETUNREACH') }))).toBe(true);
  });

  it('fails fast on auth, missing tabs and bad ranges', () => {
    expect(isTransientSheetsError(http(400, 'Unable to parse range: NOPE!A1'))).toBe(false);
    expect(isTransientSheetsError(http(401, 'invalid_grant'))).toBe(false);
    expect(isTransientSheetsError(http(403, 'The caller does not have permission'))).toBe(false);
    expect(isTransientSheetsError(http(404, 'Requested entity was not found.'))).toBe(false);
    expect(isTransientSheetsError(new Error('ENOENT: no such file or directory, open hmx-sheets-sa.json'))).toBe(false);
    expect(isTransientSheetsError('nope')).toBe(false);
  });
});

describe('Sheets calls retry transient failures', () => {
  it('a read that is aborted once succeeds on the second attempt', async () => {
    const valuesGet = vi.fn()
      .mockRejectedValueOnce(aborted())
      .mockResolvedValueOnce({ data: { values: [['0977', 'Ann']] } });
    const sleeps = install(fakeClient({ valuesGet }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getValues('sheet', "'CORP CSV MASTER'!A1:G500")).resolves.toEqual([['0977', 'Ann']]);
    expect(valuesGet).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([20_000]);
    expect(sheetsRetryFailures()).toEqual(["read 'CORP CSV MASTER'!A1:G500 attempt 1: The operation was aborted."]);
  });

  it('every request carries a timeout so a hung connection cannot stall the run', async () => {
    const valuesGet = vi.fn().mockResolvedValue({ data: { values: [] } });
    install(fakeClient({ valuesGet }));
    await getValues('sheet', 'A1:B2');
    expect(valuesGet.mock.calls[0]![1]).toEqual({ timeout: 60_000 });
  });

  it('a write is retried too', async () => {
    const valuesUpdate = vi.fn().mockRejectedValueOnce(http(503)).mockResolvedValueOnce({ data: {} });
    install(fakeClient({ valuesUpdate }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await updateValues('sheet', "'LOANS'!H7", [['$40.00']]);
    expect(valuesUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx', async () => {
    const valuesGet = vi.fn().mockRejectedValue(http(400, 'Unable to parse range'));
    const sleeps = install(fakeClient({ valuesGet }));
    await expect(getValues('sheet', 'NOPE!A1')).rejects.toThrow('Unable to parse range');
    expect(valuesGet).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('gives up after the window and says what it was doing', async () => {
    const valuesGet = vi.fn().mockRejectedValue(aborted());
    const sleeps = install(fakeClient({ valuesGet }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(getValues('sheet', 'LOANS!A1:J500')).rejects.toThrow(/Google Sheets read LOANS!A1:J500 still failing after 19 attempts.*operation was aborted/);
    expect(sleeps).toHaveLength(18);
  });
});

describe('non-repeatable calls check before repeating', () => {
  const tabs = (...list: Array<[string, number]>) => ({
    data: { sheets: list.map(([title, sheetId], index) => ({ properties: { title, sheetId, index } })) },
  });

  it('addTab: if the lost first request did create the tab, the retry returns it instead of adding again', async () => {
    const batchUpdate = vi.fn().mockRejectedValueOnce(aborted());
    const get = vi.fn().mockResolvedValue(tabs(['BRANCH MASTER', 1], ['11/16/26', 77]));
    install(fakeClient({ batchUpdate, get }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(addTab('sheet', '11/16/26')).resolves.toBe(77);
    expect(batchUpdate).toHaveBeenCalledTimes(1);
  });

  it('addTab: if the first request really failed, the retry adds the tab', async () => {
    const batchUpdate = vi.fn()
      .mockRejectedValueOnce(http(503))
      .mockResolvedValueOnce({ data: { replies: [{ addSheet: { properties: { sheetId: 88 } } }] } });
    const get = vi.fn().mockResolvedValue(tabs(['BRANCH MASTER', 1]));
    install(fakeClient({ batchUpdate, get }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(addTab('sheet', '11/16/26')).resolves.toBe(88);
    expect(batchUpdate).toHaveBeenCalledTimes(2);
  });

  it('deleteTab: if the lost first request did delete the tab, the retry does not delete again', async () => {
    const batchUpdate = vi.fn().mockRejectedValueOnce(aborted());
    const get = vi.fn().mockResolvedValue(tabs(['BRANCH MASTER', 1]));
    install(fakeClient({ batchUpdate, get }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(deleteTab('sheet', 77)).resolves.toBeUndefined();
    expect(batchUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('replaceValues rewrites a tab in one request', () => {
  const sized = (title: string, rowCount: number, columnCount: number) => ({
    data: { sheets: [{ properties: { title: 'OTHER', gridProperties: { rowCount: 5, columnCount: 5 } } }, { properties: { title, gridProperties: { rowCount, columnCount } } }] },
  });

  it('pads with blanks to the tab size so old rows below and beside are cleared by the same write', async () => {
    const valuesUpdate = vi.fn().mockResolvedValue({ data: {} });
    const get = vi.fn().mockResolvedValue(sized('LOAN PAYMENTS', 4, 30));
    install(fakeClient({ valuesUpdate, get }));

    await replaceValues('sheet', 'LOAN PAYMENTS', [['STAFF ID', 'DATE'], ["'0977", '2026-11-16']]);

    expect(valuesUpdate).toHaveBeenCalledTimes(1);
    const params = valuesUpdate.mock.calls[0]![0];
    expect(params.range).toBe("'LOAN PAYMENTS'!A1:Z4");
    expect(params.valueInputOption).toBe('USER_ENTERED');
    const grid = params.requestBody.values as string[][];
    expect(grid).toHaveLength(4);
    expect(grid.every((row) => row.length === 26)).toBe(true);
    expect(grid[1]!.slice(0, 3)).toEqual(["'0977", '2026-11-16', '']);
    expect(grid[2]!.every((cell) => cell === '')).toBe(true);
    expect(grid[3]!.every((cell) => cell === '')).toBe(true);
  });

  it('never clears first: a failed write leaves the tab as it was', async () => {
    const valuesUpdate = vi.fn().mockRejectedValue(http(400, 'nope'));
    const clear = vi.fn();
    const get = vi.fn().mockResolvedValue(sized('LOAN PAYMENTS', 4, 9));
    const client = fakeClient({ valuesUpdate, get });
    (client.spreadsheets.values as unknown as { clear: unknown }).clear = clear;
    install(client);
    await expect(replaceValues('sheet', 'LOAN PAYMENTS', [['a']])).rejects.toThrow('nope');
    expect(clear).not.toHaveBeenCalled();
  });

  it('writes past the current size when there are more rows than the tab has', async () => {
    const valuesUpdate = vi.fn().mockResolvedValue({ data: {} });
    const get = vi.fn().mockResolvedValue(sized('GARNISHMENTS PAYOUTS', 2, 8));
    install(fakeClient({ valuesUpdate, get }));
    await replaceValues('sheet', 'GARNISHMENTS PAYOUTS', [['h'], ['1'], ['2']]);
    expect(valuesUpdate.mock.calls[0]![0].range).toBe("'GARNISHMENTS PAYOUTS'!A1:H3");
  });

  it('fails clearly when the tab is missing', async () => {
    const get = vi.fn().mockResolvedValue(sized('LOAN PAYMENTS', 4, 9));
    install(fakeClient({ get, valuesUpdate: vi.fn() }));
    await expect(replaceValues('sheet', 'NOPE', [['a']])).rejects.toThrow("Tab 'NOPE' not found");
  });
});
