import { handlePayload, parseError, MCP_PROTOCOL_VERSION, TOOLS } from '@/mcp/server';
import { createMemoryStore, type ArrangementStore } from '@/mcp/tools';
import { authenticate, parseTokenList } from '@/mcp/auth';

/**
 * The MCP endpoint. Deliberately thin: authenticate, parse a body, hand it to
 * the pure server, serialise what comes back. All the behaviour — and all the
 * tests — live in src/mcp/.
 *
 * STORAGE IS IN-MEMORY AND PROCESS-LOCAL. Songs composed here survive until the
 * server restarts and are not shared between instances. `ArrangementStore` in
 * src/mcp/tools.ts is the seam the database drops into; nothing in the tool
 * layer changes when it does, because scoping already happens out here.
 *
 * AUTH IS PER PERSON, by bearer token — see src/mcp/auth.ts for why the browser
 * passcode gate cannot serve an MCP client. Each token maps to a userId, and
 * each userId gets its own store, so handing a friend a token does not hand
 * them the owner's songs.
 */
export const dynamic = 'force-dynamic';

/** One store per person. Replaced wholesale by a scoped DB store later. */
const stores = new Map<string, ArrangementStore>();

function storeFor(userId: string): ArrangementStore {
  let store = stores.get(userId);
  if (store === undefined) {
    store = createMemoryStore();
    stores.set(userId, store);
  }
  return store;
}

/*
 * Read at module load, not per request: rotating a token should be a deploy,
 * and re-parsing on every call would be work done once per tool invocation for
 * no benefit.
 */
const TOKENS = parseTokenList(process.env.SIGIL_MCP_TOKENS);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export async function POST(req: Request): Promise<Response> {
  const auth = authenticate(req.headers, TOKENS, IS_PRODUCTION);
  if (!auth.ok) {
    return Response.json(
      { error: auth.message },
      {
        status: auth.status,
        // Tells a well-behaved client how to authenticate rather than leaving
        // it to guess at the header name.
        headers: auth.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="sigil"' } : {},
      },
    );
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json(parseError(), { status: 400 });
  }
  const result = await handlePayload(storeFor(auth.identity.userId), payload);
  if (result === null) return new Response(null, { status: 202 });
  return Response.json(result);
}

/**
 * No SSE stream to open, but a GET is a useful "is this thing on".
 *
 * Unauthenticated on purpose, and it says nothing a caller could not learn by
 * reading the source: the protocol version and the tool names. It deliberately
 * does NOT confirm whether a presented token is valid.
 */
export function GET(): Response {
  return Response.json({
    service: 'sigil-mcp',
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: 'http-post',
    authentication: TOKENS.size > 0 || IS_PRODUCTION ? 'bearer' : 'none (development)',
    tools: TOOLS.map((t) => t.name),
  });
}
