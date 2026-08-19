'use client';

import { useState, type JSX } from 'react';

/**
 * The two interactive pieces of /admin: the key form and the sign-out button.
 *
 * Kept in one client file because they are the same concern — the admin session —
 * and the page around them stays a server component that never ships the signup
 * rows to a bundle.
 *
 * The form's copy deliberately mirrors app/gate/page.tsx: a locked door with a
 * sign on it reads better than a bare field. It says nothing about who the key
 * belongs to, and the error says nothing about how close an attempt was.
 */

const BORDER = '3px solid var(--ink)';

export function AdminSignIn(): JSX.Element {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (key === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/admin/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (res.ok) {
        // Reload rather than route: the page is a server component and the rows
        // have to be fetched with the new cookie attached.
        window.location.reload();
        return;
      }
      const body: unknown = await res.json().catch(() => null);
      const message = typeof body === 'object' && body !== null && 'error' in body
        ? String((body as Record<string, unknown>)['error'])
        : 'Not it.';
      setError(message);
    } catch {
      setError('Could not reach the server.');
    }
    setBusy(false);
  };

  return (
    <div
      className="flex flex-col gap-3 p-5"
      style={{ border: BORDER, background: 'var(--panel)', boxShadow: '8px 8px 0 0 var(--ink)' }}
    >
      <label htmlFor="admin-key" className="label" style={{ color: 'var(--ink)' }}>
        Admin key
      </label>

      <input
        id="admin-key"
        type="password"
        autoFocus
        autoComplete="off"
        className="w-full bg-transparent px-3 font-bold tracking-[0.2em]"
        style={{ height: 48, border: BORDER, color: 'var(--ink)', borderRadius: 0 }}
        value={key}
        onChange={(e): void => { setKey(e.target.value); setError(null); }}
        onKeyDown={(e): void => { if (e.key === 'Enter') void submit(); }}
      />

      {/* Always present, so a screen reader announces the change rather than
          racing an element that appears at the same moment. */}
      <div aria-live="polite" className="min-h-[16px]">
        {error !== null && (
          <p className="label" style={{ color: 'var(--analog)' }}>{error}</p>
        )}
      </div>

      <button
        type="button"
        disabled={busy || key === ''}
        className="hard w-full text-[11px] font-bold uppercase tracking-[0.2em] disabled:opacity-40"
        style={{
          height: 48, border: BORDER, background: 'var(--analog)',
          color: 'var(--bg)', borderRadius: 0,
        }}
        onClick={(): void => { void submit(); }}
      >
        {busy ? 'Checking…' : 'Unlock'}
      </button>
    </div>
  );
}

export function SignOutButton(): JSX.Element {
  const [busy, setBusy] = useState(false);

  const signOut = async (): Promise<void> => {
    setBusy(true);
    try {
      await fetch('/admin/api/session', { method: 'DELETE' });
    } catch {
      // Either way the page reloads and the server decides what it sees.
    }
    window.location.reload();
  };

  return (
    <button
      type="button"
      disabled={busy}
      className="hard px-4 text-[10px] font-bold uppercase tracking-[0.18em]"
      style={{
        height: 44, border: BORDER, background: 'var(--panel)',
        color: 'var(--ink)', borderRadius: 0,
      }}
      onClick={(): void => { void signOut(); }}
    >
      {busy ? 'Locking…' : 'Lock'}
    </button>
  );
}
