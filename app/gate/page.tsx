'use client';

import { useState, type JSX } from 'react';
import { SigilMark } from '@/ui/components/engine-mark';

export default function GatePage(): JSX.Element {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!passcode || busy) return;
    setBusy(true);
    setError(false);
    const res = await fetch('/api/gate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode }),
    });
    if (res.ok) {
      window.location.href = '/';
      return;
    }
    setError(true);
    setBusy(false);
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div
        className="border-4 p-8 w-full max-w-sm flex flex-col items-center gap-5"
        style={{ borderColor: 'var(--ink)', background: 'var(--panel)', boxShadow: '8px 8px 0 0 var(--ink)' }}
      >
        <SigilMark size={40} />
        <div className="font-bold uppercase tracking-tight text-lg">SIGIL</div>
        <p className="label text-center" style={{ color: 'var(--ink)' }}>
          Enter the passcode
        </p>

        <input
          type="password"
          autoFocus
          aria-label="Passcode"
          className="w-full border-[3px] bg-transparent px-3 py-3 text-center font-bold tracking-[0.3em]"
          style={{ borderColor: error ? 'var(--analog)' : 'var(--ink)', color: 'var(--ink)' }}
          value={passcode}
          onChange={(e): void => setPasscode(e.target.value)}
          onKeyDown={(e): void => { if (e.key === 'Enter') void submit(); }}
        />

        {error && (
          <p className="label" role="alert" style={{ color: 'var(--analog)' }}>
            Not it. Try again.
          </p>
        )}

        <button
          type="button"
          disabled={busy}
          className="hard border-[3px] w-full py-3 text-[11px] font-bold uppercase tracking-[0.2em] disabled:opacity-40"
          style={{ borderColor: 'var(--ink)', background: 'var(--analog)', color: 'var(--bg)' }}
          onClick={(): void => { void submit(); }}
        >
          {busy ? 'Checking…' : 'Enter'}
        </button>
      </div>
    </main>
  );
}
