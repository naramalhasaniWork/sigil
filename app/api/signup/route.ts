import {
  isSignupIntent,
  normaliseEmail,
  normaliseSource,
  type SignupIntent,
} from '@/server/signups';
import { getSignupStore } from '@/server/signup-store';
import { clientKey, createRateLimiter } from '@/server/rate-limit';

/**
 * `POST /api/signup` — the only public write in the app.
 *
 * Four rules, all of them about the fact that the payload is somebody's email
 * address:
 *
 *  1. THE RESPONSE IS THE SAME whether the address was new or already on the
 *     list. Otherwise this endpoint is an oracle: submit an address, read the
 *     status, learn whether that person signed up. `{ ok: true }` either way.
 *  2. NOTHING IS LOGGED. Not the address, not the body, not the driver's error —
 *     a `pg` failure message can carry the row that caused it. The one log line
 *     here names the operation and nothing else.
 *  3. RATE LIMITED per IP. A public unauthenticated write on a page about to be
 *     posted to Reddit gets found by a bot within a day.
 *  4. BODY IS CAPPED before it is parsed, so a large POST is refused rather than
 *     buffered into JSON.parse.
 */
export const dynamic = 'force-dynamic';

/**
 * Six in ten minutes per IP. Room for a person to sign up for updates, change
 * their mind and ask for the plugin, mistype once and retry — and no room for a
 * script. Deliberately not tight enough to punish a shared office NAT.
 */
const limiter = createRateLimiter({ limit: 6, windowMs: 10 * 60 * 1000 });

/** Generous for `{email, intent, source}`; small enough to be free to reject. */
const MAX_BODY_BYTES = 2048;

interface Parsed {
  readonly email: string;
  readonly intent: SignupIntent;
  readonly source: string | null;
}

type ParseResult =
  | { readonly ok: true; readonly value: Parsed }
  | { readonly ok: false; readonly error: string };

function parseBody(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Enter an email address.' };
  }
  const body = raw as Record<string, unknown>;

  const email = normaliseEmail(body['email']);
  if (!email.ok) return { ok: false, error: email.reason };

  /*
   * Intent is required and closed. Defaulting an unrecognised value to `updates`
   * would quietly file a plugin request as a newsletter signup — the exact
   * distinction the whole feature exists to keep.
   */
  const intent = body['intent'];
  if (!isSignupIntent(intent)) {
    return { ok: false, error: 'Choose what you would like to hear about.' };
  }

  return {
    ok: true,
    value: { email: email.email, intent, source: normaliseSource(body['source']) },
  };
}

export async function POST(req: Request): Promise<Response> {
  const decision = limiter.check(clientKey(req.headers));
  if (!decision.allowed) {
    return Response.json(
      { ok: false, error: 'Too many attempts. Try again in a few minutes.' },
      { status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds) } },
    );
  }

  let text: string;
  try {
    text = await req.text();
  } catch {
    return Response.json({ ok: false, error: 'Could not read that.' }, { status: 400 });
  }
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: 'That is too much data.' }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return Response.json({ ok: false, error: 'Could not read that.' }, { status: 400 });
  }

  const parsed = parseBody(payload);
  if (!parsed.ok) {
    return Response.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  try {
    const store = await getSignupStore();
    await store.add(parsed.value);
  } catch {
    /*
     * The caught error is dropped on the floor on purpose. It is the only place
     * an address could reach a log, and "storage failed" is the whole of what an
     * operator can act on anyway — the rest is in the database's own logs.
     */
    console.error('[signup] store write failed');
    return Response.json(
      { ok: false, error: 'Could not save that just now. Try again shortly.' },
      { status: 503 },
    );
  }

  // Identical for a new row and for one that already existed. See rule 1.
  return Response.json({ ok: true });
}
