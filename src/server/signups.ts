/**
 * Email signups: the shape, the validation, and the in-memory store.
 *
 * Modelled on `ArrangementStore` in src/mcp/tools.ts — an async interface with a
 * memory implementation for local dev and tests, and a Postgres implementation
 * (src/server/signups-postgres.ts) chosen at the seam in src/server/signup-store.ts.
 * `pnpm dev` and the test suite need no database, exactly as MCP needs none.
 *
 * These are real people's addresses. Two rules hold for every line that touches
 * them:
 *
 *  1. AN ADDRESS NEVER REACHES A LOG OR AN ERROR MESSAGE. Not on a failed
 *     insert, not on a validation failure, not in a thrown message. Errors say
 *     what went wrong, never who it happened to.
 *  2. EXISTENCE IS NOT OBSERVABLE from outside. `add` returns the same shape
 *     whether the row was created or already there, so the endpoint above it
 *     cannot be turned into "is this person on the list?".
 */

/**
 * What someone is asking for.
 *
 * Ordered by strength of interest, and that order is load-bearing — see
 * `strongerIntent`. Anyone who wants the plugin also wants to hear about it;
 * the reverse is not true.
 */
export type SignupIntent = 'updates' | 'plugin';

export const SIGNUP_INTENTS: readonly SignupIntent[] = ['updates', 'plugin'];

export function isSignupIntent(value: unknown): value is SignupIntent {
  return value === 'updates' || value === 'plugin';
}

export interface SignupRecord {
  readonly id: string;
  /** Already normalised — lowercase, trimmed. The store never holds a raw address. */
  readonly email: string;
  readonly intent: SignupIntent;
  /** Free text, e.g. `landing`. Where the hand went up, so a later form is distinguishable. */
  readonly source: string | null;
  /** ISO 8601. First time they signed up, never bumped by a repeat submit. */
  readonly createdAt: string;
  /** ISO 8601. Bumped when a repeat submit upgrades the intent. */
  readonly updatedAt: string;
}

export type SignupCounts = Readonly<Record<SignupIntent, number>>;

export interface SignupStore {
  /**
   * Records a signup, or folds it into the existing row for that address.
   *
   * Idempotent by design: a double submit is one row, and the caller cannot tell
   * which happened. See `strongerIntent` for what a second, different intent does.
   */
  add(input: SignupInput): Promise<void>;
  /** Newest first. */
  list(): Promise<readonly SignupRecord[]>;
  countByIntent(): Promise<SignupCounts>;
}

export interface SignupInput {
  /** Must already be normalised — pass the value out of `normaliseEmail`. */
  readonly email: string;
  readonly intent: SignupIntent;
  readonly source?: string | null;
}

/**
 * DEDUPE AND UPGRADE.
 *
 * One row per address, keyed on the normalised form, and a repeat submit with a
 * different intent takes the stronger of the two: `updates` becomes `plugin`,
 * and `plugin` is never walked back to `updates`.
 *
 * Why upgrade rather than reject, and why never downgrade:
 *
 *  - The two intents are not alternatives, they are nested. Someone who wants
 *    the plugin wants the release note that announces it. Storing the strongest
 *    interest loses nothing and keeps the useful signal — the plugin list is
 *    the one worth acting on.
 *  - Rejecting a second submit would mean the person who first asked for
 *    updates, then found the plugin button, is silently not on the plugin list.
 *    That is the exact signal the owner asked to collect.
 *  - A downgrade would let a later, weaker click erase that signal. Interest is
 *    monotonic here; the row only ever moves up.
 *  - Two rows per address would mean mailing someone twice and de-duplicating
 *    by hand in the mail tool later.
 *
 * `createdAt` stays at the first signup — that is when they raised their hand —
 * and `updatedAt` records the upgrade.
 */
export function strongerIntent(a: SignupIntent, b: SignupIntent): SignupIntent {
  return a === 'plugin' || b === 'plugin' ? 'plugin' : 'updates';
}

/* --------------------------------------------------------- validation */

/**
 * The longest address the standards allow. A cap matters more than the pattern:
 * it is what stops a megabyte of text being handed to the database.
 */
export const MAX_EMAIL_LENGTH = 254;
/** `a@b.c` is the shortest thing that can plausibly be an address. */
const MIN_EMAIL_LENGTH = 5;
/** Free-text `source` is ours, not the visitor's, but it arrives over HTTP. */
export const MAX_SOURCE_LENGTH = 64;

export type EmailCheck =
  | { readonly ok: true; readonly email: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Trims, lowercases, and checks the structure.
 *
 * Deliberately not a heroic regex. No pattern decides whether an address is
 * real — delivery does — and every attempt at one has a famous list of valid
 * addresses it rejects. This checks the few things that are certainly wrong: no
 * `@`, more than one `@`, nothing either side of it, a domain with no dot,
 * whitespace or control characters anywhere, and the length cap.
 *
 * `reason` is UI copy. It describes the address's shape and never quotes it.
 */
export function normaliseEmail(raw: unknown): EmailCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'Enter an email address.' };

  const email = raw.trim().toLowerCase();
  if (email === '') return { ok: false, reason: 'Enter an email address.' };
  if (email.length > MAX_EMAIL_LENGTH) return { ok: false, reason: 'That address is too long.' };
  if (email.length < MIN_EMAIL_LENGTH) return { ok: false, reason: "That doesn't look like an email address." };

  // Control characters and whitespace — including a header-injection newline.
  if (/[\s\u0000-\u001F\u007F]/.test(email)) {
    return { ok: false, reason: "That doesn't look like an email address." };
  }

  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) {
    return { ok: false, reason: "That doesn't look like an email address." };
  }

  const domain = email.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    return { ok: false, reason: "That doesn't look like an email address." };
  }

  return { ok: true, email };
}

/** Clamps the optional free-text source. Unusable input becomes null, not an error. */
export function normaliseSource(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const source = raw.trim().slice(0, MAX_SOURCE_LENGTH);
  return source === '' || /[\u0000-\u001F\u007F]/.test(source) ? null : source;
}

/* ------------------------------------------------------- memory store */

/**
 * Process-local store. Used by `pnpm dev` and by every test, and the reason
 * neither needs a database. Rows do not survive a restart, which is correct for
 * dev and is why DATABASE_URL exists in production.
 */
export function createMemorySignupStore(
  seed: readonly SignupRecord[] = [],
): SignupStore {
  const rows = new Map<string, SignupRecord>();
  for (const row of seed) rows.set(row.email, row);

  return {
    async add(input) {
      const now = new Date().toISOString();
      const existing = rows.get(input.email);
      if (existing === undefined) {
        rows.set(input.email, {
          // Opaque and app-generated, so the memory and Postgres stores agree on
          // the type and nothing has to marshal a sequence value.
          id: crypto.randomUUID(),
          email: input.email,
          intent: input.intent,
          source: input.source ?? null,
          createdAt: now,
          updatedAt: now,
        });
        return;
      }
      const intent = strongerIntent(existing.intent, input.intent);
      rows.set(input.email, {
        ...existing,
        intent,
        // Only moves when something actually changed, so the column means
        // "when the intent was upgraded" rather than "last seen".
        updatedAt: intent === existing.intent ? existing.updatedAt : now,
      });
    },

    async list() {
      return [...rows.values()].sort((a, b) => (
        // Second key so a same-millisecond pair has a stable order; two rows
        // inserted in one tick otherwise shuffle between calls.
        b.createdAt === a.createdAt
          ? a.email.localeCompare(b.email)
          : (b.createdAt < a.createdAt ? -1 : 1)
      ));
    },

    async countByIntent() {
      const counts: Record<SignupIntent, number> = { updates: 0, plugin: 0 };
      for (const row of rows.values()) counts[row.intent] += 1;
      return counts;
    },
  };
}
