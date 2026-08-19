import type { JSX, ReactNode } from 'react';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { ADMIN_COOKIE, adminKeyStatus, isAuthorisedAdmin } from '@/server/admin-auth';
import { getSignupStore, isPersistentStore } from '@/server/signup-store';
import type { SignupCounts, SignupRecord } from '@/server/signups';
import { AdminSignIn, SignOutButton } from './session-controls';
import { SignupList } from './signup-list';

/**
 * /admin — who signed up, and what for.
 *
 * A SERVER COMPONENT, and that is a privacy decision as much as an architectural
 * one: the rows are read from the store and rendered to HTML here. Nothing
 * fetches them over an API a browser could be pointed at, and no serialised list
 * of addresses rides along in the page's props.
 *
 * THE LOCK IS ITS OWN (src/server/admin-auth.ts). It does not use the passcode
 * gate, because NEXT_PUBLIC_SIGIL_PUBLIC=1 removes the gate entirely and this
 * page must not open when it does. With no SIGIL_ADMIN_KEY set it refuses — no
 * form, no rows, no "dev mode is open" shortcut.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Admin',
  // The root layout already sets this; stated again here because it is the one
  // page where an indexed URL would be a genuine leak, and a later decision to
  // index the public site must not silently take this with it.
  robots: { index: false, follow: false },
};

const BORDER = '3px solid var(--ink)';

function Shell({ subtitle, action, children }: {
  subtitle: string;
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <main className="min-h-screen p-5 sm:p-8">
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-6">
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <h1
              className="font-bold uppercase leading-none"
              style={{ fontSize: 30, letterSpacing: '0.06em', color: 'var(--ink)' }}
            >
              Signups
            </h1>
            <p className="label" style={{ color: 'var(--ink)' }}>{subtitle}</p>
          </div>
          {action}
        </header>
        {children}
      </div>
    </main>
  );
}

/** Says what is wrong and how to fix it. Never a form that cannot succeed. */
function Unconfigured({ tooShort }: { tooShort: boolean }): JSX.Element {
  return (
    <Shell subtitle="Locked">
      <div
        className="flex flex-col gap-3 p-5"
        style={{ border: BORDER, background: 'var(--panel)' }}
      >
        <p className="text-[15px] leading-relaxed" style={{ color: 'var(--ink)' }}>
          {tooShort
            ? 'SIGIL_ADMIN_KEY is set but too short to be a lock, so this page stays shut. Give it at least 16 characters and redeploy.'
            : 'SIGIL_ADMIN_KEY is not set on this deployment, so this page stays shut. Set it and redeploy.'}
        </p>
        <p className="text-[13px] leading-relaxed" style={{ color: 'var(--ink)', opacity: 0.75 }}>
          It refuses rather than opening on purpose: this page lists real people’s
          email addresses, and an unset variable must never be the thing that
          publishes them.
        </p>
      </div>
    </Shell>
  );
}

export default async function AdminPage(): Promise<JSX.Element> {
  const status = adminKeyStatus();
  if (status !== 'ok') return <Unconfigured tooShort={status === 'too-short'} />;

  const jar = await cookies();
  if (!(await isAuthorisedAdmin(jar.get(ADMIN_COOKIE)?.value))) {
    return (
      <Shell subtitle="Locked">
        <AdminSignIn />
      </Shell>
    );
  }

  let rows: readonly SignupRecord[] = [];
  let counts: SignupCounts = { updates: 0, plugin: 0 };
  let failed = false;
  try {
    const store = await getSignupStore();
    [rows, counts] = await Promise.all([store.list(), store.countByIntent()]);
  } catch {
    // Nothing logged and nothing shown: the only detail available here is a
    // driver message, and that can carry the row that caused it.
    failed = true;
  }

  return (
    <Shell
      subtitle={isPersistentStore() ? 'Newest first' : 'Newest first · in-memory (no database)'}
      action={
        <div className="flex items-center gap-2">
          {/*
            A plain link, not a fetch: the browser handles the download, and the
            cookie rides along because it is scoped to /admin.
          */}
          <a
            href="/admin/export"
            className="hard flex items-center px-4 text-[10px] font-bold uppercase tracking-[0.18em]"
            style={{
              height: 44, border: BORDER, background: 'var(--physical)',
              color: 'var(--bg)', borderRadius: 0,
            }}
          >
            CSV
          </a>
          <SignOutButton />
        </div>
      }
    >
      {failed ? (
        <p
          className="px-4 py-6 text-[15px]"
          style={{ border: BORDER, background: 'var(--panel)', color: 'var(--ink)' }}
        >
          Could not read the signup store just now. Reload in a moment.
        </p>
      ) : (
        <SignupList rows={rows} counts={counts} />
      )}
    </Shell>
  );
}
