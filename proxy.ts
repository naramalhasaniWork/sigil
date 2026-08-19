import { NextResponse, type NextRequest } from 'next/server';

/**
 * Passcode gate, on the Next 16 `proxy` convention — `middleware.ts` is
 * deprecated and warned on every build. Same behaviour, new file and export
 * name; `config.matcher` is unchanged.
 *
 * Deliberately simple: one shared passcode from the
 * SIGIL_PASSCODE environment variable, a SHA-256 of it in an HttpOnly cookie.
 * This keeps the instrument private until real accounts land — it is a door,
 * not a vault. When SIGIL_PASSCODE is unset (local dev), the gate stays open.
 */

/*
 * `/api/mcp` is open to the PROXY, not to the world: it authenticates itself
 * with a per-person bearer token in src/mcp/auth.ts, and fails closed in
 * production when none are configured. It has to be listed here because an MCP
 * client is not a browser — it cannot follow a redirect to a login form, so the
 * cookie gate would answer every tool call with a 307 to /gate.
 */
const OPEN_PATHS = [
  '/gate', '/api/gate', '/api/health', '/api/mcp',
  // The landing page is the public face and holds nothing private. Gating it
  // would mean the one page meant to be shared and indexed was the one page
  // nobody could read.
  '/start',
  /*
   * The signup endpoint, for the same reason as /start and no other: the form
   * lives on the open page, so gating its POST would mean the shareable page had
   * a button that answered 307 to /gate. It authenticates nobody by design — it
   * is a public write — and is protected by a per-IP rate limit and by accepting
   * nothing but an address and an intent.
   */
  '/api/signup',
  /*
   * `/admin` is deliberately NOT here.
   *
   * It has its own lock (src/server/admin-auth.ts, SIGIL_ADMIN_KEY) which fails
   * closed, so it does not need the gate — but it does not need to bypass it
   * either. In private mode the gate in front of it is a free second lock and the
   * only person who wants /admin already knows the passcode. In public mode this
   * function returns early anyway, so listing it would change nothing there and
   * would only weaken the private case.
   */
];

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  /*
   * The public deployment has no door at all. It stores nothing server-side and
   * has nothing to protect — a passcode there would only be a barrier between
   * someone and the instrument, which is the opposite of the point.
   *
   * Checked before the passcode so that setting both is unambiguous: public
   * wins, and there is no state where the public build quietly asks for a
   * password nobody was given.
   */
  if (process.env.NEXT_PUBLIC_SIGIL_PUBLIC === '1') return NextResponse.next();

  const passcode = process.env.SIGIL_PASSCODE;
  if (!passcode) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (OPEN_PATHS.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const cookie = req.cookies.get('sigil-key')?.value;
  if (cookie && cookie === (await sha256Hex(passcode))) return NextResponse.next();

  const gate = req.nextUrl.clone();
  gate.pathname = '/gate';
  gate.search = '';
  return NextResponse.redirect(gate);
}

export const config = {
  // Everything except Next's own static assets. The worklet and API stay
  // gated: they are fetched same-origin after login, so the cookie rides along.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
