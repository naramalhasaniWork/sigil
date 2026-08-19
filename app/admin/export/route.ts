import { cookies } from 'next/headers';
import { ADMIN_COOKIE, isAuthorisedAdmin } from '@/server/admin-auth';
import { getSignupStore } from '@/server/signup-store';
import { csvFilename, signupsToCsv } from '@/server/csv';

/**
 * `GET /admin/export` — the signup list as a CSV download.
 *
 * Same lock as the page, checked here rather than inherited: a route handler that
 * trusted the page to have authenticated would be a file of email addresses
 * behind a URL somebody could just type.
 *
 * Unauthorised gets 404, not 403. There is nothing to gain from confirming to an
 * unauthenticated caller that an export endpoint exists, and 404 is what a URL
 * they should not know about ought to look like.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const jar = await cookies();
  if (!(await isAuthorisedAdmin(jar.get(ADMIN_COOKIE)?.value))) {
    return new Response('Not found', { status: 404 });
  }

  let csv: string;
  try {
    const store = await getSignupStore();
    csv = signupsToCsv(await store.list());
  } catch {
    // No detail: a driver error can carry the row that caused it.
    return new Response('Export failed.', { status: 503 });
  }

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename()}"`,
      // A file of real addresses must not sit in a proxy or browser cache.
      'Cache-Control': 'no-store, private',
    },
  });
}
