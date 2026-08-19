import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ADMIN_COOKIE,
  adminClearCookie,
  adminKeyStatus,
  adminSessionCookie,
  constantTimeEqual,
  isAdminConfigured,
  isAuthorisedAdmin,
  MIN_ADMIN_KEY_LENGTH,
  verifyAdminKey,
} from '@/server/admin-auth';

const GOOD_KEY = 'admin_key_long_enough_to_be_a_lock';

const original = process.env.SIGIL_ADMIN_KEY;

beforeEach(() => { delete process.env.SIGIL_ADMIN_KEY; });
afterEach(() => {
  if (original === undefined) delete process.env.SIGIL_ADMIN_KEY;
  else process.env.SIGIL_ADMIN_KEY = original;
});

/**
 * THE IMPORTANT SUITE.
 *
 * /admin lists real people's addresses, and NEXT_PUBLIC_SIGIL_PUBLIC=1 removes
 * the passcode gate entirely. If this lock ever defaults open when its variable
 * is missing, the public deployment publishes the list. Every path below asserts
 * the closed outcome.
 */
describe('admin fails closed with no key set', () => {
  it('reports itself unconfigured', () => {
    expect(adminKeyStatus()).toBe('unset');
    expect(isAdminConfigured()).toBe(false);
  });

  it('refuses every submitted key, including the empty string', async () => {
    for (const attempt of ['', 'anything', GOOD_KEY, undefined, null, 0, {}]) {
      expect(await verifyAdminKey(attempt)).toBe(false);
    }
  });

  it('refuses every cookie, including one that would be valid if a key were set', async () => {
    process.env.SIGIL_ADMIN_KEY = GOOD_KEY;
    const valid = await adminSessionCookie();
    expect(valid).not.toBeNull();
    const value = /=([0-9a-f]+);/.exec(valid ?? '')?.[1];
    expect(value).toBeDefined();

    delete process.env.SIGIL_ADMIN_KEY;
    expect(await isAuthorisedAdmin(value)).toBe(false);
    for (const cookie of ['', undefined, null, 'anything']) {
      expect(await isAuthorisedAdmin(cookie)).toBe(false);
    }
  });

  it('issues no session cookie at all', async () => {
    expect(await adminSessionCookie()).toBeNull();
  });

  /* An empty string is a set variable in some deploy UIs. It must not count. */
  it('treats an empty or whitespace variable as unset', async () => {
    process.env.SIGIL_ADMIN_KEY = '   ';
    expect(adminKeyStatus()).toBe('unset');
    expect(await verifyAdminKey('   ')).toBe(false);
  });

  /*
   * A four-character key on a public URL is not a lock. Refusing is louder than
   * accepting it, and the page says why.
   */
  it('refuses a key too short to be worth guessing', async () => {
    process.env.SIGIL_ADMIN_KEY = 'a'.repeat(MIN_ADMIN_KEY_LENGTH - 1);
    expect(adminKeyStatus()).toBe('too-short');
    expect(isAdminConfigured()).toBe(false);
    expect(await verifyAdminKey(process.env.SIGIL_ADMIN_KEY)).toBe(false);
    expect(await adminSessionCookie()).toBeNull();
  });
});

describe('admin auth with a key set', () => {
  beforeEach(() => { process.env.SIGIL_ADMIN_KEY = GOOD_KEY; });

  it('accepts the key and nothing near it', async () => {
    expect(await verifyAdminKey(GOOD_KEY)).toBe(true);
    expect(await verifyAdminKey(`${GOOD_KEY} `)).toBe(false);
    expect(await verifyAdminKey(GOOD_KEY.toUpperCase())).toBe(false);
    expect(await verifyAdminKey(GOOD_KEY.slice(0, -1))).toBe(false);
  });

  it('round-trips its own cookie and rejects a tampered one', async () => {
    const header = await adminSessionCookie();
    const value = /=([0-9a-f]+);/.exec(header ?? '')?.[1] ?? '';
    expect(await isAuthorisedAdmin(value)).toBe(true);
    expect(await isAuthorisedAdmin(value.slice(0, -1))).toBe(false);
    expect(await isAuthorisedAdmin(`${value.slice(0, -1)}0`)).toBe(false);
  });

  /*
   * The gate stores a bare sha256(SIGIL_PASSCODE) in `sigil-key`. If the owner set
   * both secrets to the same string, a bare hash here would mean a friend's gate
   * cookie was also an admin cookie. The domain-separating prefix is what stops
   * that, so it is asserted rather than assumed.
   */
  it('does not accept the gate cookie a shared secret would produce', async () => {
    const digest = await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(GOOD_KEY),
    );
    const gateStyle = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(await isAuthorisedAdmin(gateStyle)).toBe(false);
  });

  it('sets an HttpOnly, Secure, path-scoped cookie', async () => {
    const header = await adminSessionCookie() ?? '';
    expect(header.startsWith(`${ADMIN_COOKIE}=`)).toBe(true);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Path=/admin');
    // The raw key must never travel in the cookie.
    expect(header).not.toContain(GOOD_KEY);
  });

  it('clears the cookie on the same path it set it', () => {
    const header = adminClearCookie();
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('Path=/admin');
  });
});

describe('constant-time comparison', () => {
  it('matches only identical strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
