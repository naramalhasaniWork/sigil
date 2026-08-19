import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST } from '../../app/api/signup/route';
import { getSignupStore, resetSignupStoreCache } from '@/server/signup-store';

/**
 * `POST /api/signup`, end to end against the memory store.
 *
 * DATABASE_URL is unset here, exactly as it is in `pnpm dev`, so the whole suite
 * runs with no database — the reason the store is an injectable interface.
 */

const originalUrl = process.env.DATABASE_URL;

beforeEach(() => {
  delete process.env.DATABASE_URL;
  resetSignupStoreCache();
});
afterEach(() => {
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
  resetSignupStoreCache();
});

/*
 * The route's rate limiter is module state shared by every test in this file, so
 * each test gets its own IP. Sharing one would make the tests order-dependent —
 * and would be testing the limiter, which has its own suite.
 */
let ipCounter = 0;
function post(body: unknown, ip = `198.51.100.${++ipCounter}`): Promise<Response> {
  return POST(new Request('http://localhost/api/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

describe('signup endpoint', () => {
  it('accepts an address and an intent', async () => {
    const res = await post({ email: 'Someone@Example.com ', intent: 'plugin', source: 'landing' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const rows = await (await getSignupStore()).list();
    expect(rows).toHaveLength(1);
    // Normalised on the way in, so the store never holds two spellings of one person.
    expect(rows[0]).toMatchObject({
      email: 'someone@example.com', intent: 'plugin', source: 'landing',
    });
  });

  /*
   * THE ORACLE TEST. A different status, body or timing for an address already on
   * the list would turn this endpoint into "is this person a SIGIL user?" for
   * anyone with a list of addresses to try.
   */
  it('answers identically for a new address and one already there', async () => {
    const first = await post({ email: 'dup@example.com', intent: 'updates' });
    const second = await post({ email: 'dup@example.com', intent: 'updates' });
    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual(await first.json());
    expect((await (await getSignupStore()).list())).toHaveLength(1);
  });

  it('upgrades an existing updates signup to plugin', async () => {
    await post({ email: 'both@example.com', intent: 'updates' });
    await post({ email: 'both@example.com', intent: 'plugin' });
    const store = await getSignupStore();
    expect(await store.list()).toHaveLength(1);
    expect(await store.countByIntent()).toEqual({ updates: 0, plugin: 1 });
  });

  it('rejects a malformed address without saving anything', async () => {
    const res = await post({ email: 'not-an-address', intent: 'updates' });
    expect(res.status).toBe(400);
    expect(await (await getSignupStore()).list()).toHaveLength(0);
  });

  it('rejects a missing or unknown intent rather than guessing', async () => {
    expect((await post({ email: 'a@example.com' })).status).toBe(400);
    expect((await post({ email: 'a@example.com', intent: 'newsletter' })).status).toBe(400);
    expect((await post({ email: 'a@example.com', intent: 'UPDATES' })).status).toBe(400);
    expect(await (await getSignupStore()).list()).toHaveLength(0);
  });

  it('rejects a body that is not an object, or not JSON', async () => {
    expect((await post('not json at all')).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect((await post(['a@example.com'])).status).toBe(400);
  });

  it('refuses an oversized body before parsing it', async () => {
    const res = await post(`{"email":"${'a'.repeat(5000)}@example.com","intent":"updates"}`);
    expect(res.status).toBe(413);
  });

  it('never repeats the address in an error message', async () => {
    const res = await post({ email: 'victim@example.com nope', intent: 'updates' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain('victim');
  });

  it('rate limits a single IP and says when to come back', async () => {
    const ip = '203.0.113.42';
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      statuses.push((await post({ email: `rl${i}@example.com`, intent: 'updates' }, ip)).status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(6);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);

    const blocked = await post({ email: 'blocked@example.com', intent: 'updates' }, ip);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    // Nothing was written for the refused attempts.
    expect(await (await getSignupStore()).list()).toHaveLength(6);
  });

  it('does not lock out a different IP', async () => {
    const ip = '203.0.113.99';
    for (let i = 0; i < 7; i++) {
      await post({ email: `other${i}@example.com`, intent: 'updates' }, ip);
    }
    const fresh = await post({ email: 'fresh@example.com', intent: 'updates' }, '203.0.113.100');
    expect(fresh.status).toBe(200);
  });
});
