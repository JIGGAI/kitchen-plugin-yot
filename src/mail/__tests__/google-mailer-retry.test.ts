import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTransientSmtpError, sendGmail } from '../google-mailer';

const smtp = (fields: Record<string, unknown>, message = 'smtp error') => Object.assign(new Error(message), fields);

afterEach(() => vi.restoreAllMocks());

describe('isTransientSmtpError', () => {
  it('retries "try again later" replies and connection failures', () => {
    expect(isTransientSmtpError(smtp({ responseCode: 421, code: 'EENVELOPE' }, '421 4.7.0 Try again later'))).toBe(true);
    expect(isTransientSmtpError(smtp({ responseCode: 451 }))).toBe(true);
    expect(isTransientSmtpError(smtp({ code: 'ETIMEDOUT', command: 'CONN' }, 'Connection timeout'))).toBe(true);
    expect(isTransientSmtpError(smtp({ code: 'ESOCKET' }))).toBe(true);
    expect(isTransientSmtpError(smtp({ code: 'EDNS' }))).toBe(true);
    expect(isTransientSmtpError(smtp({ code: 'ECONNECTION' }))).toBe(true);
  });

  it('fails fast on bad credentials and permanent rejections', () => {
    expect(isTransientSmtpError(smtp({ responseCode: 535, code: 'EAUTH' }, '535-5.7.8 Username and Password not accepted (BadCredentials)'))).toBe(false);
    expect(isTransientSmtpError(smtp({ code: 'EAUTH' }))).toBe(false);
    expect(isTransientSmtpError(smtp({ responseCode: 550, code: 'EENVELOPE' }))).toBe(false);
    expect(isTransientSmtpError(smtp({ responseCode: 552, code: 'EMESSAGE' }))).toBe(false);
    expect(isTransientSmtpError(new Error('Gmail app password is empty'))).toBe(false);
  });
});

describe('sendGmail retry', () => {
  const args = { to: 'someone@example.com', subject: 'HMX Disbursements 2026-11-16', text: 'attached' };
  function timing() {
    const sleeps: number[] = [];
    let now = 0;
    return { sleeps, now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };
  }

  it('sends once when Gmail accepts it', async () => {
    const t = timing();
    const send = vi.fn().mockResolvedValue({ messageId: '<a>' });
    await expect(sendGmail(args, { send, ...t })).resolves.toEqual({ messageId: '<a>', attempts: 1 });
    expect(t.sleeps).toEqual([]);
  });

  it('retries a dropped connection and reports how many sends it took', async () => {
    const t = timing();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn()
      .mockRejectedValueOnce(smtp({ code: 'ETIMEDOUT', command: 'CONN' }, 'Connection timeout'))
      .mockRejectedValueOnce(smtp({ responseCode: 421 }, '421 Try again later'))
      .mockResolvedValueOnce({ messageId: '<b>' });
    await expect(sendGmail(args, { send, ...t })).resolves.toEqual({ messageId: '<b>', attempts: 3 });
    expect(t.sleeps).toEqual([30_000, 30_000]);
  });

  it('does not retry bad credentials', async () => {
    const t = timing();
    const send = vi.fn().mockRejectedValue(smtp({ responseCode: 535, code: 'EAUTH' }, '535 BadCredentials'));
    await expect(sendGmail(args, { send, ...t })).rejects.toThrow('BadCredentials');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('gives up after the window', async () => {
    const t = timing();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn().mockRejectedValue(smtp({ code: 'ESOCKET' }, 'socket closed'));
    await expect(sendGmail(args, { send, ...t })).rejects.toThrow(/Email send still failing after 11 attempts.*socket closed/);
  });
});
