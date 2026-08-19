/**
 * The lock on /admin. Deliberately its own lock.
 *
 * WHY NOT THE PASSCODE GATE. `NEXT_PUBLIC_SIGIL_PUBLIC=1` makes proxy.ts return
 * `next()` for every path — the public deployment has no door at all, by design.
 * Anything guarded only by the gate is therefore wide open the moment public mode
 * is switched on, and public mode is where the signup form is meant to live. A
 * page listing real people's email addresses cannot depend on a lock whose
 * documented job is to disappear.
 *
 * So: a separate secret, SIGIL_ADMIN_KEY, checked here.
 *
 * IT FAILS CLOSED. With no key set — or a key too short to be worth guessing —
 * /admin and everything under it refuse. Not "open for convenience in dev": the
 * dev default of an unguarded admin page is exactly the state that ships by
 * accident. The page says it is unconfigured rather than showing a form that
 * cannot work.
 *
 * Mechanism mirrors app/api/gate/route.ts — SHA-256, constant-time comparison,
 * an HttpOnly cookie — rather than inventing a second scheme to reason about.
 */

const encoder = new TextEncoder();

export const ADMIN_COOKIE = 'sigil-admin';

/**
 * Twelve hours. The gate's cookie lasts 90 days because it guards an instrument
 * someone plays daily; this one guards a list of other people's addresses, and a
 * borrowed laptop should not still be signed in next month.
 */
export const ADMIN_SESSION_SECONDS = 60 * 60 * 12;

/**
 * Below this, a key is treated as absent. A four-character admin key on a public
 * URL is not a lock, and the failure is silent — same reasoning as
 * MIN_TOKEN_LENGTH in src/mcp/auth.ts.
 */
export const MIN_ADMIN_KEY_LENGTH = 16;

export type AdminKeyStatus = 'ok' | 'unset' | 'too-short';

/*
 * Read per call, not memoised at module load. The gate can read at load because
 * it is one long-lived route; this module is exercised by tests that set and
 * clear the variable, and a cached value would make the fail-closed test pass or
 * fail depending on import order.
 */
function rawKey(): string {
  return process.env.SIGIL_ADMIN_KEY?.trim() ?? '';
}

export function adminKeyStatus(): AdminKeyStatus {
  const key = rawKey();
  if (key === '') return 'unset';
  if (key.length < MIN_ADMIN_KEY_LENGTH) return 'too-short';
  return 'ok';
}

export function isAdminConfigured(): boolean {
  return adminKeyStatus() === 'ok';
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compares in time independent of how many leading characters match, so the
 * cookie value cannot be recovered a byte at a time by measuring the response.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The cookie's expected value: a SHA-256 over the key, DOMAIN-SEPARATED.
 *
 * The prefix is the point. The gate stores a bare `sha256(SIGIL_PASSCODE)` in
 * `sigil-key`; if the owner ever set both secrets to the same string, a bare hash
 * here would mean the gate cookie a friend already holds is also a valid admin
 * cookie. With the prefix, the two hashes cannot coincide.
 */
async function expectedCookie(): Promise<string | null> {
  if (!isAdminConfigured()) return null;
  return sha256Hex(`${ADMIN_COOKIE}:${rawKey()}`);
}

/**
 * Checks a submitted key. False whenever admin is not configured — the
 * fail-closed path, and the reason an unset key cannot be matched by submitting
 * an empty string.
 */
export async function verifyAdminKey(attempt: unknown): Promise<boolean> {
  if (!isAdminConfigured()) return false;
  if (typeof attempt !== 'string' || attempt === '') return false;
  // Both sides hashed before comparison, so a length difference in the raw keys
  // is not what decides the comparison's duration.
  const [a, b] = await Promise.all([
    sha256Hex(`attempt:${attempt}`),
    sha256Hex(`attempt:${rawKey()}`),
  ]);
  return constantTimeEqual(a, b);
}

/** Checks a presented cookie value. False when unconfigured, absent or wrong. */
export async function isAuthorisedAdmin(cookieValue: string | null | undefined): Promise<boolean> {
  const expected = await expectedCookie();
  if (expected === null) return false;
  if (typeof cookieValue !== 'string' || cookieValue === '') return false;
  return constantTimeEqual(cookieValue, expected);
}

/** The `Set-Cookie` value that signs an admin in. Null when unconfigured. */
export async function adminSessionCookie(): Promise<string | null> {
  const expected = await expectedCookie();
  if (expected === null) return null;
  return [
    `${ADMIN_COOKIE}=${expected}`,
    // Scoped to /admin: the cookie is useless anywhere else, so it should not be
    // attached to every request for the instrument or a static asset.
    'Path=/admin',
    'HttpOnly',
    'Secure',
    // Strict, not Lax: nothing should ever navigate into the admin view from
    // another site carrying this cookie.
    'SameSite=Strict',
    `Max-Age=${ADMIN_SESSION_SECONDS}`,
  ].join('; ');
}

/** The `Set-Cookie` value that signs an admin out. */
export function adminClearCookie(): string {
  return `${ADMIN_COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
