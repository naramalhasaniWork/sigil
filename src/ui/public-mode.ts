/**
 * Whether this deployment is the public one.
 *
 * SIGIL runs in two shapes from one codebase. PRIVATE is the owner's instance:
 * passcode gate, arrangement, everything. PUBLIC is the version anyone can
 * open — no sign-in, no accounts, no server-side storage, and no arranger.
 *
 * The distinction is deliberately a single environment variable rather than a
 * build target or a fork. A fork would drift, and within a week the public
 * version would be quietly behind on every fix.
 *
 * `NEXT_PUBLIC_` so the browser can read it too: the proxy needs it to decide
 * whether to gate, and the interface needs it to decide what to show. One
 * variable, one answer, both sides.
 */
export const IS_PUBLIC = process.env.NEXT_PUBLIC_SIGIL_PUBLIC === '1';

/** Where the byline points. */
export const AUTHOR_NAME = 'naram';
export const AUTHOR_URL = 'https://naram.co';

/**
 * What the public build does NOT include, and why each one is out.
 *
 * Stated here rather than scattered through the components so there is one
 * place to read when deciding whether something new belongs in public.
 *
 * - The ARRANGER. It is the least finished surface, it is the one the owner
 *   himself found confusing, and a stranger's first thirty seconds should not
 *   be spent on it.
 * - SERVER STORAGE of any kind. The public build keeps its session in the
 *   browser and nowhere else, which means no accounts to run, no data to lose
 *   and nothing to be responsible for.
 *
 * Everything else is the whole instrument: six engines, every preset, the
 * effects and character chains, Hunt, sample loading, bounce and record.
 * Deliberately not a demo — a crippled version teaches people the wrong thing
 * about what it is.
 */
export const PUBLIC_EXCLUDES = ['arranger', 'server-storage'] as const;
