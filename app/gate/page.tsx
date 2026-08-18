'use client';

import { useState, type JSX } from 'react';
import { SigilMark } from '@/ui/components/engine-mark';

/**
 * The landing page, which is also the door.
 *
 * A friend opening a shared link lands here, and the previous version told them
 * nothing but "Enter the passcode" — which reads like a locked door with no sign
 * on it. It is the same one field, with enough around it to explain what they
 * are being let into.
 *
 * Deliberately not a separate marketing route. An extra click between the link
 * and the instrument buys nothing, and two pages would be two places for the
 * description to drift.
 */

/** The engine rail, flattened. Real identity colours, same order as the app. */
const ENGINES: readonly (readonly [string, string])[] = [
  ['ANALOG', '#FF6B6B'],
  ['FM', '#4ECDC4'],
  ['PHYSICAL', '#FFD93D'],
  ['GRANULAR', '#8B5CF6'],
  ['WAVETABLE', '#FF9F45'],
  ['SAMPLER', '#7BC96F'],
];

export default function GatePage(): JSX.Element {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!passcode || busy) return;
    setBusy(true);
    setError(false);
    try {
      const res = await fetch('/api/gate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode }),
      });
      if (res.ok) {
        window.location.href = '/';
        return;
      }
    } catch {
      // Offline or the server is down. Same recovery: tell them, let them retry.
    }
    setError(true);
    setBusy(false);
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-5">
      <div className="w-full max-w-[560px] flex flex-col gap-6">

        <div className="flex items-center gap-4">
          <div
            className="flex items-center justify-center shrink-0 border-[3px]"
            style={{
              width: 68, height: 68,
              background: 'var(--panel)',
              borderColor: 'var(--ink)',
              boxShadow: '5px 5px 0 0 var(--ink)',
            }}
          >
            <SigilMark size={34} animate />
          </div>
          <div className="flex flex-col">
            <h1
              className="font-bold uppercase leading-none"
              style={{ fontSize: 42, letterSpacing: '0.06em', color: 'var(--ink)' }}
            >
              SIGIL
            </h1>
            <p className="label mt-1.5" style={{ color: 'var(--ink)', opacity: 0.8 }}>
              A sound design instrument
            </p>
          </div>
        </div>

        <p className="text-[15px] leading-relaxed" style={{ color: 'var(--ink)' }}>
          Six synthesis engines in a browser.
        </p>

        {/* Hard blocks. Shows what is inside before asking for anything. */}
        <div className="flex flex-wrap gap-1.5">
          {ENGINES.map(([name, colour]) => (
            <div
              key={name}
              className="border-[3px] px-2.5 py-1.5 text-[9px] font-bold uppercase"
              style={{
                borderColor: 'var(--ink)',
                background: colour,
                color: 'var(--bg)',
                letterSpacing: '0.14em',
              }}
            >
              {name}
            </div>
          ))}
        </div>

        <div
          className="border-[3px] p-5 flex flex-col gap-3"
          style={{
            borderColor: 'var(--ink)',
            background: 'var(--panel)',
            boxShadow: '8px 8px 0 0 var(--ink)',
          }}
        >
          <label
            htmlFor="passcode"
            className="label"
            style={{ color: 'var(--ink)' }}
          >
            Passcode
          </label>

          <input
            id="passcode"
            type="password"
            autoFocus
            autoComplete="current-password"
            className="w-full border-[3px] bg-transparent px-3 text-center font-bold tracking-[0.3em]"
            // 48px: comfortably past the 44px touch minimum, which is the whole
            // reason this is not a compact field.
            style={{
              height: 48,
              borderColor: error ? 'var(--analog)' : 'var(--ink)',
              color: 'var(--ink)',
            }}
            value={passcode}
            onChange={(e): void => { setPasscode(e.target.value); setError(false); }}
            onKeyDown={(e): void => { if (e.key === 'Enter') void submit(); }}
          />

          {/*
            aria-live rather than role="alert" on a conditional node: the region
            is always present, so a screen reader announces the change instead of
            racing an element that appears at the same moment.
          */}
          <div aria-live="polite" className="min-h-[16px]">
            {error && (
              <p className="label" style={{ color: 'var(--analog)' }}>
                Not it. Try again.
              </p>
            )}
          </div>

          <button
            type="button"
            disabled={busy || passcode === ''}
            className="hard border-[3px] w-full text-[11px] font-bold uppercase tracking-[0.2em] disabled:opacity-40"
            style={{
              height: 48,
              borderColor: 'var(--ink)',
              background: 'var(--analog)',
              color: 'var(--bg)',
            }}
            onClick={(): void => { void submit(); }}
          >
            {busy ? 'Checking…' : 'Enter'}
          </button>
        </div>

        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--ink)', opacity: 0.6 }}>
          No passcode? Ask whoever sent you the link. Nothing here is public.
        </p>
      </div>
    </main>
  );
}
