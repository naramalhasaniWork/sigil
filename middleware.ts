import { NextResponse, type NextRequest } from 'next/server';

/**
 * Passcode gate. Deliberately simple: one shared passcode from the
 * SIGIL_PASSCODE environment variable, a SHA-256 of it in an HttpOnly cookie.
 * This keeps the instrument private until real accounts land — it is a door,
 * not a vault. When SIGIL_PASSCODE is unset (local dev), the gate stays open.
 */

const OPEN_PATHS = ['/gate', '/api/gate', '/api/health'];

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
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
