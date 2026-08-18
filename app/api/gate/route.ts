const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: Request): Promise<Response> {
  const passcode = process.env.SIGIL_PASSCODE;
  if (!passcode) return Response.json({ ok: true, open: true });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  const attempt =
    typeof body === 'object' && body !== null && 'passcode' in body
      ? String((body as Record<string, unknown>)['passcode'])
      : '';

  const [attemptHash, realHash] = await Promise.all([sha256Hex(attempt), sha256Hex(passcode)]);
  if (!constantTimeEqual(attemptHash, realHash)) {
    return Response.json({ ok: false }, { status: 401 });
  }

  const res = Response.json({ ok: true });
  res.headers.set(
    'Set-Cookie',
    `sigil-key=${realHash}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`,
  );
  return res;
}
