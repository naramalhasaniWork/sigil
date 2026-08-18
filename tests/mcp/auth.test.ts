import { describe, it, expect } from 'vitest';
import {
  parseTokenList, bearerFrom, constantTimeEqual, authenticate,
} from '@/mcp/auth';

const TOK_A = 'tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOK_B = 'tok_bbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function headers(init: Record<string, string> = {}): Headers {
  return new Headers(init);
}

describe('token list', () => {
  it('maps each token to its person', () => {
    const t = parseTokenList(`naram=${TOK_A},jonas=${TOK_B}`);
    expect(t.get(TOK_A)).toBe('naram');
    expect(t.get(TOK_B)).toBe('jonas');
    expect(t.size).toBe(2);
  });

  it('tolerates whitespace and trailing commas', () => {
    const t = parseTokenList(` naram = ${TOK_A} , jonas=${TOK_B}, `);
    expect(t.get(TOK_A)).toBe('naram');
    expect(t.get(TOK_B)).toBe('jonas');
  });

  it('treats unset or empty as no tokens', () => {
    expect(parseTokenList(undefined).size).toBe(0);
    expect(parseTokenList('').size).toBe(0);
    expect(parseTokenList('   ').size).toBe(0);
  });

  /*
   * One friend's typo must not take the endpoint down for everyone. A dropped
   * entry simply fails to authenticate, which shows up the first time it is
   * used rather than as a crash on boot.
   */
  it('drops malformed entries without losing the good ones', () => {
    const t = parseTokenList(`broken,=${TOK_A},naram=${TOK_B},noequals`);
    expect(t.get(TOK_B)).toBe('naram');
    expect(t.size).toBe(1);
  });

  it('refuses tokens short enough to be guessed', () => {
    expect(parseTokenList('naram=short').size).toBe(0);
  });

  it('lets the first entry win so a duplicate token cannot be hijacked', () => {
    const t = parseTokenList(`naram=${TOK_A},attacker=${TOK_A}`);
    expect(t.get(TOK_A)).toBe('naram');
  });
});

describe('bearer extraction', () => {
  it('reads Authorization: Bearer, whatever the case', () => {
    expect(bearerFrom(headers({ authorization: `Bearer ${TOK_A}` }))).toBe(TOK_A);
    expect(bearerFrom(headers({ authorization: `bearer ${TOK_A}` }))).toBe(TOK_A);
    expect(bearerFrom(headers({ authorization: `BEARER  ${TOK_A}` }))).toBe(TOK_A);
  });

  it('falls back to X-Sigil-Token for clients that cannot set Authorization', () => {
    expect(bearerFrom(headers({ 'x-sigil-token': TOK_A }))).toBe(TOK_A);
  });

  it('returns null when there is nothing to read', () => {
    expect(bearerFrom(headers())).toBeNull();
    expect(bearerFrom(headers({ authorization: 'Basic abc' }))).toBeNull();
    expect(bearerFrom(headers({ authorization: 'Bearer' }))).toBeNull();
  });
});

describe('constant-time compare', () => {
  it('agrees with === on the answer', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  /*
   * The property that matters: a token differing in the FIRST character must
   * not be distinguishable from one differing in the LAST. A `===` returns
   * early and leaks the secret a character at a time to anyone timing it. This
   * cannot assert on wall-clock without being flaky, so it asserts the
   * structural precondition — every character is examined.
   */
  it('examines the whole string rather than stopping at the first difference', () => {
    const probe = { length: TOK_A.length, seen: 0 } as { length: number; seen: number };
    const counting = {
      length: TOK_A.length,
      charCodeAt(i: number): number { probe.seen = Math.max(probe.seen, i + 1); return 0; },
    } as unknown as string;
    constantTimeEqual(counting, 'x'.repeat(TOK_A.length));
    expect(probe.seen).toBe(TOK_A.length);
  });
});

describe('authenticate', () => {
  const tokens = parseTokenList(`naram=${TOK_A},jonas=${TOK_B}`);

  it('resolves a valid token to its person', () => {
    const r = authenticate(headers({ authorization: `Bearer ${TOK_A}` }), tokens, true);
    expect(r).toEqual({ ok: true, identity: { userId: 'naram' } });
  });

  it('gives two people two identities from one deployment', () => {
    const a = authenticate(headers({ authorization: `Bearer ${TOK_A}` }), tokens, true);
    const b = authenticate(headers({ authorization: `Bearer ${TOK_B}` }), tokens, true);
    expect(a.ok && a.identity.userId).toBe('naram');
    expect(b.ok && b.identity.userId).toBe('jonas');
  });

  it('rejects an unknown token', () => {
    const r = authenticate(headers({ authorization: 'Bearer tok_nope_nope_nope_nope_nope' }), tokens, true);
    expect(r).toEqual({ ok: false, status: 401, message: 'Unrecognised token.' });
  });

  it('rejects a missing token', () => {
    const r = authenticate(headers(), tokens, true);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(401);
  });

  /*
   * The failure mode this prevents: deploying without SIGIL_MCP_TOKENS and
   * publishing an unauthenticated write endpoint that anyone can find. It would
   * be found by a crawler, not by a person.
   */
  it('refuses entirely in production when no tokens are configured', () => {
    const r = authenticate(headers({ authorization: `Bearer ${TOK_A}` }), new Map(), true);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(503);
    expect(r.ok === false && r.message).toMatch(/SIGIL_MCP_TOKENS/);
  });

  it('stays open in development so npm run dev needs no setup', () => {
    const r = authenticate(headers(), new Map(), false);
    expect(r).toEqual({ ok: true, identity: { userId: 'local' } });
  });

  /* Configured tokens are enforced in development too — otherwise testing the
   * real auth path locally would be impossible. */
  it('enforces configured tokens even in development', () => {
    const r = authenticate(headers(), tokens, false);
    expect(r.ok).toBe(false);
  });
});
