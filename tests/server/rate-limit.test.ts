import { describe, it, expect } from 'vitest';
import { clientKey, createRateLimiter } from '@/server/rate-limit';

/*
 * The clock is injected, so the window is proved rather than waited out. A test
 * that slept for a real ten minutes would simply be deleted by the next person.
 */
describe('rate limiter', () => {
  it('allows up to the limit and refuses the next one', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000 });
    expect(limiter.check('ip', 0).allowed).toBe(true);
    expect(limiter.check('ip', 1).allowed).toBe(true);
    const last = limiter.check('ip', 2);
    expect(last.allowed).toBe(true);
    expect(last.remaining).toBe(0);
    expect(limiter.check('ip', 3).allowed).toBe(false);
  });

  it('counts each key separately', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('a', 0).allowed).toBe(false);
    // One noisy IP must not lock out everyone else.
    expect(limiter.check('b', 0).allowed).toBe(true);
  });

  it('lets the budget slide back as the window passes', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect(limiter.check('ip', 0).allowed).toBe(true);
    expect(limiter.check('ip', 500).allowed).toBe(true);
    expect(limiter.check('ip', 900).allowed).toBe(false);
    // The first hit has aged out; one slot is free again, the second is not.
    expect(limiter.check('ip', 1001).allowed).toBe(true);
    expect(limiter.check('ip', 1002).allowed).toBe(false);
    expect(limiter.check('ip', 1501).allowed).toBe(true);
  });

  it('reports whole seconds until a slot frees up', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 10_000 });
    limiter.check('ip', 0);
    const denied = limiter.check('ip', 1000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(9);
    // Never zero: a Retry-After of 0 invites an immediate retry that also fails.
    expect(limiter.check('ip', 9999).retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('forgets a key on request', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
    limiter.check('ip', 0);
    expect(limiter.check('ip', 0).allowed).toBe(false);
    limiter.forget('ip');
    expect(limiter.check('ip', 0).allowed).toBe(true);
  });

  /*
   * The bound is the whole reason this is safe to keep in memory: a spray of
   * forged X-Forwarded-For values must not grow the map until the process dies.
   */
  it('stays bounded under a spray of unique keys', () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 50 });
    for (let i = 0; i < 5000; i++) limiter.check(`ip-${i}`, i);
    expect(limiter.size()).toBeLessThanOrEqual(50);
  });

  it('sweeps keys whose window has expired', () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000, maxKeys: 10 });
    for (let i = 0; i < 10; i++) limiter.check(`ip-${i}`, 0);
    expect(limiter.size()).toBe(10);
    // Every existing bucket is stale by now, so the newcomer costs nothing.
    limiter.check('fresh', 5000);
    expect(limiter.size()).toBeLessThanOrEqual(10);
    expect(limiter.check('fresh', 5000).allowed).toBe(true);
  });
});

describe('client key', () => {
  it('takes the leftmost forwarded address', () => {
    expect(clientKey(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' })))
      .toBe('203.0.113.9');
  });

  it('falls back to x-real-ip, then to a single shared bucket', () => {
    expect(clientKey(new Headers({ 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
    // Strictest outcome rather than the most permissive: unknown callers share.
    expect(clientKey(new Headers())).toBe('unknown');
    expect(clientKey(new Headers({ 'x-forwarded-for': '   ' }))).toBe('unknown');
  });

  it('clamps a long header so the map key cannot be padded', () => {
    const key = clientKey(new Headers({ 'x-forwarded-for': 'a'.repeat(500) }));
    expect(key.length).toBe(64);
  });
});
