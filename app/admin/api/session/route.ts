import {
  adminClearCookie,
  adminKeyStatus,
  adminSessionCookie,
  verifyAdminKey,
} from '@/server/admin-auth';
import { clientKey, createRateLimiter } from '@/server/rate-limit';

/**
 * The admin session. POST signs in with SIGIL_ADMIN_KEY, DELETE signs out.
 *
 * Under /admin rather than /api so that the whole admin surface — page, session,
 * export — is one path prefix. Anything reasoning about admin access, including
 * the proxy's OPEN_PATHS, then has one string to reason about instead of two.
 *
 * FAILS CLOSED. No key configured means 503 and no cookie, ever. The key itself
 * is never echoed, and the response says nothing about how close an attempt was.
 */
export const dynamic = 'force-dynamic';

/**
 * Five attempts per fifteen minutes per IP. The key is a shared secret typed by
 * one person; this exists so that finding /admin does not hand someone an
 * unlimited guessing budget.
 */
const limiter = createRateLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });

const MAX_BODY_BYTES = 1024;

export async function POST(req: Request): Promise<Response> {
  if (adminKeyStatus() !== 'ok') {
    return Response.json(
      {
        ok: false,
        error: adminKeyStatus() === 'unset'
          ? 'Admin is not configured on this deployment.'
          : 'The configured admin key is too short to be used.',
      },
      { status: 503 },
    );
  }

  const decision = limiter.check(clientKey(req.headers));
  if (!decision.allowed) {
    return Response.json(
      { ok: false, error: 'Too many attempts. Wait a few minutes.' },
      { status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds) } },
    );
  }

  let text: string;
  try {
    text = await req.text();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  if (text.length > MAX_BODY_BYTES) return Response.json({ ok: false }, { status: 413 });

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  const key = typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)['key']
    : undefined;

  if (!(await verifyAdminKey(key))) {
    return Response.json({ ok: false, error: 'Not it.' }, { status: 401 });
  }

  const cookie = await adminSessionCookie();
  if (cookie === null) return Response.json({ ok: false }, { status: 503 });

  const res = Response.json({ ok: true });
  res.headers.set('Set-Cookie', cookie);
  return res;
}

export function DELETE(): Response {
  const res = Response.json({ ok: true });
  res.headers.set('Set-Cookie', adminClearCookie());
  return res;
}
