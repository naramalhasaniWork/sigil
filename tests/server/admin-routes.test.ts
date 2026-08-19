import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/*
 * `cookies()` only exists inside a Next request, so the jar is faked and driven
 * from the test. Everything else in these routes is the real code path.
 */
const jar = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string): { name: string; value: string } | undefined => (
      jar.value === undefined ? undefined : { name, value: jar.value }
    ),
  }),
}));

const { POST, DELETE } = await import('../../app/admin/api/session/route');
const { GET: EXPORT } = await import('../../app/admin/export/route');
const { getSignupStore, resetSignupStoreCache } = await import('@/server/signup-store');
const { ADMIN_COOKIE } = await import('@/server/admin-auth');

const GOOD_KEY = 'admin_key_long_enough_to_be_a_lock';

const originalKey = process.env.SIGIL_ADMIN_KEY;
const originalUrl = process.env.DATABASE_URL;

beforeEach(() => {
  delete process.env.SIGIL_ADMIN_KEY;
  delete process.env.DATABASE_URL;
  jar.value = undefined;
  resetSignupStoreCache();
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.SIGIL_ADMIN_KEY;
  else process.env.SIGIL_ADMIN_KEY = originalKey;
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
  resetSignupStoreCache();
});

let ipCounter = 0;
function signIn(key: unknown, ip = `192.0.2.${++ipCounter}`): Promise<Response> {
  return POST(new Request('http://localhost/admin/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ key }),
  }));
}

function cookieFrom(res: Response): string | undefined {
  return /=([0-9a-f]+);/.exec(res.headers.get('Set-Cookie') ?? '')?.[1];
}

describe('admin session, no key configured', () => {
  it('refuses to sign anyone in and issues no cookie', async () => {
    const res = await signIn('anything');
    expect(res.status).toBe(503);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('cannot be signed in to with the empty string', async () => {
    const res = await signIn('');
    expect(res.status).toBe(503);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('refuses the CSV export outright', async () => {
    const res = await EXPORT();
    expect(res.status).toBe(404);
  });
});

describe('admin session with a key configured', () => {
  beforeEach(() => { process.env.SIGIL_ADMIN_KEY = GOOD_KEY; });

  it('signs in with the right key and sets an HttpOnly cookie', async () => {
    const res = await signIn(GOOD_KEY);
    expect(res.status).toBe(200);
    const header = res.headers.get('Set-Cookie') ?? '';
    expect(header).toContain(`${ADMIN_COOKIE}=`);
    expect(header).toContain('HttpOnly');
    expect(header).not.toContain(GOOD_KEY);
  });

  it('rejects a wrong key without hinting how wrong', async () => {
    const res = await signIn('definitely_not_the_admin_key');
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(await res.json()).toEqual({ ok: false, error: 'Not it.' });
  });

  it('rejects a non-string key', async () => {
    for (const key of [undefined, null, 42, { key: GOOD_KEY }]) {
      expect((await signIn(key)).status).toBe(401);
    }
  });

  it('limits guesses per IP', async () => {
    const ip = '192.0.2.200';
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await signIn(`guess-${i}`, ip)).status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    // Even the correct key waits once the budget is gone.
    expect((await signIn(GOOD_KEY, ip)).status).toBe(429);
  });

  it('signs out by clearing the cookie', () => {
    const res = DELETE();
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});

describe('CSV export', () => {
  beforeEach(async () => {
    process.env.SIGIL_ADMIN_KEY = GOOD_KEY;
    const store = await getSignupStore();
    await store.add({ email: 'someone@example.com', intent: 'plugin', source: 'landing' });
  });

  it('serves the list to a signed-in admin', async () => {
    jar.value = cookieFrom(await signIn(GOOD_KEY));
    const res = await EXPORT();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    // A file of real addresses must not be cached by a proxy or the browser.
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const body = await res.text();
    expect(body).toContain('someone@example.com');
    expect(body.split('\r\n')[0]).toBe('email,intent,created_at,updated_at,source');
  });

  it('refuses with no cookie, a wrong cookie, or the key itself as a cookie', async () => {
    for (const value of [undefined, 'nope', 'a'.repeat(64), GOOD_KEY]) {
      jar.value = value;
      const res = await EXPORT();
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('someone@example.com');
    }
  });

  /*
   * The lock is checked in the route, not inherited from the page. If the key is
   * pulled from the environment, a cookie that used to work stops working — the
   * export must not become the way in.
   */
  it('refuses a previously valid cookie once the key is removed', async () => {
    jar.value = cookieFrom(await signIn(GOOD_KEY));
    expect((await EXPORT()).status).toBe(200);
    delete process.env.SIGIL_ADMIN_KEY;
    expect((await EXPORT()).status).toBe(404);
  });
});
