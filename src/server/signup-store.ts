/**
 * The seam: which `SignupStore` this process is using.
 *
 * Postgres when DATABASE_URL is set (Railway), memory otherwise (`pnpm dev`,
 * tests). Nothing above this file knows which one it got — the API route and the
 * admin view both take the interface.
 *
 * The instance is created once per process and cached. The Postgres store owns a
 * connection pool; building one per request would open a socket per signup.
 *
 * WHY DYNAMIC IMPORT. `pg` is a Node-only package. Importing it eagerly from a
 * module that a route also reaches would drag it into every bundle that touches
 * signups, and the memory path — dev and the whole test suite — would pay for a
 * driver it never calls. The import only happens when DATABASE_URL exists.
 */
import { createMemorySignupStore, type SignupStore } from './signups';

/*
 * ON globalThis, not a plain module-level `let`.
 *
 * Next builds the route handlers and the server components as separate bundles,
 * and a module-scoped singleton is therefore singular PER BUNDLE: `POST
 * /api/signup` would write to one memory store while /admin read from another,
 * and the dev experience would be a form that "works" and a list that stays
 * empty. Hot reload has the same effect on its own. A global symbol is one
 * instance per process, which is what "in-memory store" is supposed to mean.
 *
 * It matters for the memory path only — with DATABASE_URL set, both bundles
 * would talk to the same database either way — but the memory path is the one
 * `pnpm dev` uses, so it is the one someone will be confused by.
 */
const CACHE = Symbol.for('sigil.signup-store');

interface Cache { store: SignupStore | null; key: string | null }

const globals = globalThis as unknown as Record<symbol, Cache | undefined>;

function cache(): Cache {
  globals[CACHE] ??= { store: null, key: null };
  // Non-null: assigned on the line above.
  return globals[CACHE] as Cache;
}

/**
 * Resolves the store for this process.
 *
 * Async because the Postgres driver is imported on demand. Callers await it once
 * per request, which after the first is a resolved promise on a cached object.
 */
export async function getSignupStore(): Promise<SignupStore> {
  const url = process.env.DATABASE_URL?.trim();
  const key = url === undefined || url === '' ? 'memory' : url;
  const held = cache();

  // Re-resolved if the connection string changes under us, which in practice
  // only happens in a test that sets and clears the variable.
  if (held.store !== null && held.key === key) return held.store;

  if (key === 'memory') {
    held.store = createMemorySignupStore();
  } else {
    const { createPostgresSignupStore } = await import('./signups-postgres');
    held.store = createPostgresSignupStore({ connectionString: key });
  }
  held.key = key;
  return held.store;
}

/** Test-only: drops the cached instance so the next call re-resolves. */
export function resetSignupStoreCache(): void {
  const held = cache();
  held.store = null;
  held.key = null;
}

/** True when signups are landing in Postgres rather than in this process's memory. */
export function isPersistentStore(): boolean {
  const url = process.env.DATABASE_URL?.trim();
  return url !== undefined && url !== '';
}
