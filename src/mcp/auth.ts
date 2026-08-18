/**
 * Per-user authentication for the MCP endpoint.
 *
 * The passcode gate in proxy.ts is a browser mechanism: it redirects to a login
 * page and hands back a cookie. An MCP client is not a browser — Claude Desktop
 * cannot fill in a form — so the gate would answer every tool call with a 307 to
 * /gate. MCP therefore authenticates itself, with a bearer token, and is listed
 * in the proxy's OPEN_PATHS *only* because of this module.
 *
 * Tokens are per person, configured as
 *
 *     SIGIL_MCP_TOKENS="naram=tok_a1b2c3...,jonas=tok_d4e5f6..."
 *
 * The name on the left is the storage owner: two people with two tokens get two
 * private sets of arrangements from one deployment. Revoking someone is deleting
 * their entry. When the database lands, this becomes a table lookup and nothing
 * above it changes.
 */

export interface McpIdentity {
  /** Storage owner. Scopes every arrangement this caller can see or write. */
  readonly userId: string;
}

export type AuthOutcome =
  | { readonly ok: true; readonly identity: McpIdentity }
  | { readonly ok: false; readonly status: 401 | 503; readonly message: string };

/** Rejects tokens too short to be worth guessing against. */
const MIN_TOKEN_LENGTH = 24;

/**
 * Parses the env var into token → userId.
 *
 * Malformed entries are dropped rather than throwing: a typo in one friend's
 * entry must not take the endpoint down for everyone else. A dropped entry
 * simply fails to authenticate, which is visible the first time it is used.
 */
export function parseTokenList(raw: string | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (raw === undefined || raw.trim() === '') return out;

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;                       // no name, or empty name
    const userId = trimmed.slice(0, eq).trim();
    const token = trimmed.slice(eq + 1).trim();
    if (userId === '' || token.length < MIN_TOKEN_LENGTH) continue;
    // First entry wins, so a duplicated token cannot be hijacked by a later one.
    if (!out.has(token)) out.set(token, userId);
  }
  return out;
}

/** `Authorization: Bearer <token>`, case-insensitively. Also accepts X-Sigil-Token. */
export function bearerFrom(headers: Headers): string | null {
  const auth = headers.get('authorization');
  if (auth !== null) {
    const m = /^bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1] !== undefined) return m[1].trim();
  }
  // Some MCP clients cannot set Authorization on a custom transport.
  const alt = headers.get('x-sigil-token');
  return alt === null || alt.trim() === '' ? null : alt.trim();
}

/**
 * Compares two strings in time independent of how many leading characters
 * match. A plain `===` returns early on the first differing byte, which leaks
 * the token a character at a time to anyone who can measure the response.
 *
 * Length is allowed to leak — it is not secret, and padding to hide it would
 * mean allocating per comparison.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Resolves a request to a person.
 *
 * Fails closed. With no tokens configured, a production deployment refuses MCP
 * entirely rather than serving an unauthenticated write endpoint — the failure
 * mode of the opposite default is a public URL that lets anyone overwrite the
 * owner's songs, and it would be found by a crawler, not by a person.
 */
export function authenticate(
  headers: Headers,
  tokens: ReadonlyMap<string, string>,
  isProduction: boolean,
): AuthOutcome {
  if (tokens.size === 0) {
    if (isProduction) {
      return {
        ok: false,
        status: 503,
        message: 'MCP is not configured. Set SIGIL_MCP_TOKENS to enable it.',
      };
    }
    // Local development: one implicit person, so `npm run dev` needs no setup.
    return { ok: true, identity: { userId: 'local' } };
  }

  const presented = bearerFrom(headers);
  if (presented === null) {
    return { ok: false, status: 401, message: 'Missing bearer token.' };
  }

  // Every candidate is checked even after a match, so the time taken does not
  // reveal which position in the list matched.
  let matched: string | null = null;
  for (const [token, userId] of tokens) {
    if (constantTimeEqual(presented, token)) matched ??= userId;
  }
  if (matched === null) {
    return { ok: false, status: 401, message: 'Unrecognised token.' };
  }
  return { ok: true, identity: { userId: matched } };
}
