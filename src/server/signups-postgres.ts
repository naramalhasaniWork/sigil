/**
 * The Postgres `SignupStore`. Chosen over the memory store whenever
 * DATABASE_URL is set — see src/server/signup-store.ts for that seam.
 *
 * ONE TABLE, CREATED ON FIRST USE. A migration framework for a single table
 * would be more moving parts than the thing it manages, but the schema step
 * still has to be safe to run on every cold start of every instance: every
 * statement is `IF NOT EXISTS`, it runs inside one transaction, and the promise
 * is memoised so concurrent first requests wait on one attempt rather than
 * racing each other.
 *
 * NO ADDRESS IS EVER LOGGED. Failures are re-thrown as a bare sentence with no
 * parameter values, because a driver error can otherwise carry the row that
 * caused it — and that row is somebody's email address.
 */
import { Pool } from 'pg';
import {
  isSignupIntent,
  type SignupCounts,
  type SignupIntent,
  type SignupRecord,
  type SignupStore,
} from './signups';

export const SIGNUPS_TABLE = 'sigil_signups';

/*
 * `email` is stored already normalised — lowercased and trimmed by
 * normaliseEmail before it ever gets here — so a plain UNIQUE constraint on the
 * column IS uniqueness on the normalised address. A functional index on
 * lower(email) would be the alternative, but then two layers would each believe
 * they owned normalisation and only one of them would be right.
 *
 * `intent` is TEXT with a CHECK rather than a Postgres ENUM: adding a third
 * intent to an enum needs ALTER TYPE, and this way the set of valid values is
 * stated once here and once in the TypeScript union, both readable.
 */
const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${SIGNUPS_TABLE} (
     id         TEXT        PRIMARY KEY,
     email      TEXT        NOT NULL UNIQUE,
     intent     TEXT        NOT NULL CHECK (intent IN ('updates', 'plugin')),
     source     TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // The admin view is "newest first", and that is the only read path there is.
  `CREATE INDEX IF NOT EXISTS ${SIGNUPS_TABLE}_created_at_idx
     ON ${SIGNUPS_TABLE} (created_at DESC)`,
];

/*
 * The dedupe/upgrade rule from src/server/signups.ts, in SQL. The CASE is the
 * `strongerIntent` function: a repeat submit can raise `updates` to `plugin` and
 * can never lower `plugin` back down.
 *
 * `updated_at` only moves when the intent actually changed, so the column keeps
 * meaning "when this was upgraded" rather than degrading into "last touched".
 * `created_at` is never written on conflict — it is when they first raised their
 * hand.
 */
const UPSERT = `
  INSERT INTO ${SIGNUPS_TABLE} (id, email, intent, source)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (email) DO UPDATE SET
    intent = CASE
      WHEN ${SIGNUPS_TABLE}.intent = 'plugin' OR EXCLUDED.intent = 'plugin' THEN 'plugin'
      ELSE 'updates'
    END,
    updated_at = CASE
      WHEN ${SIGNUPS_TABLE}.intent = EXCLUDED.intent THEN ${SIGNUPS_TABLE}.updated_at
      ELSE now()
    END`;

const SELECT_ALL = `
  SELECT id, email, intent, source, created_at, updated_at
  FROM ${SIGNUPS_TABLE}
  ORDER BY created_at DESC, email ASC`;

const COUNTS = `SELECT intent, count(*)::int AS n FROM ${SIGNUPS_TABLE} GROUP BY intent`;

/** Anything the driver hands back, reduced to a sentence that carries no data. */
function opaque(operation: string): Error {
  return new Error(`Signup store failed during ${operation}.`);
}

interface Row {
  id: string;
  email: string;
  intent: string;
  source: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toRecord(row: Row): SignupRecord {
  return {
    id: row.id,
    email: row.email,
    // A row that predates a CHECK change, or is otherwise unrecognised, reads as
    // the weaker intent rather than crashing the admin view.
    intent: isSignupIntent(row.intent) ? row.intent : 'updates',
    source: row.source,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface PostgresSignupStoreOptions {
  readonly connectionString: string;
}

export function createPostgresSignupStore(
  options: PostgresSignupStoreOptions,
): SignupStore & { readonly close: () => Promise<void> } {
  /*
   * TLS IS THE CONNECTION STRING'S DECISION, not ours.
   *
   * The tempting line here is `ssl: { rejectUnauthorized: false }`, because
   * Railway's Postgres presents a certificate that does not chain to a public
   * root. It is also how you silently accept any certificate on any host —
   * including the public proxy hostname, over the internet, carrying every email
   * address in the table. Hard-coding it would make the safe case impossible to
   * reach.
   *
   * `pg` reads `sslmode` out of the URL itself, so the deployment states what it
   * wants: nothing for the internal `*.railway.internal` hop (a private network,
   * no TLS), `?sslmode=no-verify` if the internal cert has to be accepted
   * unverified, `?sslmode=require` or `verify-full` for anything crossing the
   * public internet.
   */
  const pool = new Pool({
    connectionString: options.connectionString,
    // Small: this is one table serving a landing page and one admin view. A big
    // pool per instance would just be idle connections a shared database counts.
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  /*
   * Memoised, not run at module load: an import must not open a socket, or every
   * build and every test that touches this file would need a database.
   */
  let ready: Promise<void> | null = null;

  async function ensureSchema(): Promise<void> {
    ready ??= (async (): Promise<void> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const statement of SCHEMA) await client.query(statement);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        // Cleared so a transient failure can be retried by the next request
        // instead of poisoning the process until it restarts.
        ready = null;
        throw err;
      } finally {
        client.release();
      }
    })();
    return ready;
  }

  return {
    async add(input) {
      try {
        await ensureSchema();
        await pool.query(UPSERT, [
          crypto.randomUUID(), input.email, input.intent, input.source ?? null,
        ]);
      } catch {
        throw opaque('add');
      }
    },

    async list() {
      try {
        await ensureSchema();
        const result = await pool.query<Row>(SELECT_ALL);
        return result.rows.map(toRecord);
      } catch {
        throw opaque('list');
      }
    },

    async countByIntent() {
      try {
        await ensureSchema();
        const result = await pool.query<{ intent: string; n: number }>(COUNTS);
        const counts: Record<SignupIntent, number> = { updates: 0, plugin: 0 };
        for (const row of result.rows) {
          if (isSignupIntent(row.intent)) counts[row.intent] = Number(row.n);
        }
        return counts as SignupCounts;
      } catch {
        throw opaque('countByIntent');
      }
    },

    close() {
      return pool.end();
    },
  };
}
