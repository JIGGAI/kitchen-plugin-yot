import { describe, it, expect, vi } from 'vitest';
import { isMvcSessionLive, withAutoLogin, MvcAuthExpiredError } from '../yot-mvc-client';
import type { YotConfig } from '../../types';

// Real welcome-menu fragments captured from app.youreontime.com. A live session
// renders the logged-in staff's ProfilePic id and name; a "zombie" session
// (recognized cookie, no user/org bound) renders ProfilePic/0 and a blank name.
const AUTHED_HTML =
  '<div id="welcome-menu" class="welcome first"><img class="staff-photo" src="/Administration/Staff/ProfilePic/34422">' +
  '<a class="dropit-button" id="system-menu"><span>Welcome,</span>Master &nbsp;<i></i></a></div>';
const ZOMBIE_HTML =
  '<div id="welcome-menu" class="welcome first"><img class="staff-photo" src="/Administration/Staff/ProfilePic/0">' +
  '<a class="dropit-button" id="system-menu"><span>Welcome,</span> &nbsp;<i></i></a></div>';
const LOGIN_HTML = '<form class="login-form" action="/Account/Login"><input name="UserName"></form>';

describe('isMvcSessionLive', () => {
  it('returns true when a staff profile id is bound to the session', () => {
    expect(isMvcSessionLive(AUTHED_HTML)).toBe(true);
  });

  it('returns false for a zombie session (ProfilePic/0, blank welcome)', () => {
    expect(isMvcSessionLive(ZOMBIE_HTML)).toBe(false);
  });

  it('returns false for the login page', () => {
    expect(isMvcSessionLive(LOGIN_HTML)).toBe(false);
  });
});

const CREDS: YotConfig = {
  apiKey: 'k',
  mvcCookie: 'stale',
  mvcUserName: 'u',
  mvcPassword: 'p',
  mvcOrganisation: '2121',
};

describe('withAutoLogin empty-list detection', () => {
  it('re-logs in when op returns an empty result and the session is not live', async () => {
    const op = vi
      .fn()
      .mockResolvedValueOnce('') // first call: zombie returns empty
      .mockResolvedValueOnce('<li itemId="1">data</li>'); // after relogin: real data
    const login = vi.fn().mockResolvedValue('fresh-cookie');
    const persist = vi.fn();

    const result = await withAutoLogin(CREDS, persist, op, {
      looksEmpty: (r) => r === '',
      verifySession: async () => false, // session is dead
      login,
    });

    expect(login).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith('fresh-cookie');
    expect(op).toHaveBeenCalledTimes(2);
    expect(result).toBe('<li itemId="1">data</li>');
  });

  it('returns the empty result without re-login when the session is genuinely live', async () => {
    const op = vi.fn().mockResolvedValue('');
    const login = vi.fn();
    const persist = vi.fn();

    const result = await withAutoLogin(CREDS, persist, op, {
      looksEmpty: (r) => r === '',
      verifySession: async () => true, // session is fine; list is just empty
      login,
    });

    expect(login).not.toHaveBeenCalled();
    expect(op).toHaveBeenCalledOnce();
    expect(result).toBe('');
  });

  it('still re-logs in on a thrown MvcAuthExpiredError (existing behavior)', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new MvcAuthExpiredError(302))
      .mockResolvedValueOnce('ok');
    const login = vi.fn().mockResolvedValue('fresh-cookie');
    const persist = vi.fn();

    const result = await withAutoLogin(CREDS, persist, op, { login });

    expect(login).toHaveBeenCalledOnce();
    expect(result).toBe('ok');
  });

  it('does not verify-loop: a still-empty result after relogin is returned as-is', async () => {
    const op = vi.fn().mockResolvedValue(''); // always empty (genuinely no data)
    const verifySession = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const login = vi.fn().mockResolvedValue('fresh-cookie');
    const persist = vi.fn();

    const result = await withAutoLogin(CREDS, persist, op, {
      looksEmpty: (r) => r === '',
      verifySession,
      login,
    });

    expect(login).toHaveBeenCalledOnce();
    expect(op).toHaveBeenCalledTimes(2); // initial + one retry, no infinite loop
    expect(result).toBe('');
  });
});
