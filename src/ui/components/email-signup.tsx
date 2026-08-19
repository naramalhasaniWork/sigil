'use client';

import { useId, useState, type JSX } from 'react';
import type { SignupIntent } from '@/server/signups';

/**
 * The email capture form. Self-contained: drop it anywhere, pass the intent.
 *
 * ONE COMPONENT, TWO INTENTS. `intent="updates"` collects people who want to hear
 * when something ships; `intent="plugin"` collects people who want the plugin
 * build. Two copies of this file that differed by one string would drift, and the
 * difference between the two lists is the whole point of the feature.
 *
 * Four real states — idle, submitting, done, error — and `done` is a sentence,
 * not an "OK". Someone has just handed over their address; the least they are
 * owed is being told what will actually happen with it.
 *
 * Design language held: 3px borders, sharp corners, flat fills, no gradient, no
 * blur, no soft shadow. The offset block shadow is the app's own `.hard` — a hard
 * flat rectangle, not a glow. Everything meant to be read is --ink; --muted fails
 * AA on --panel and is used here for hairlines only.
 */

export interface EmailSignupProps {
  /** Which list this form feeds. Chooses the default copy as well as the record. */
  readonly intent: SignupIntent;
  /**
   * Free text recorded with the row, e.g. `landing` or `footer`. Lets the owner
   * tell a landing-page signup from one somewhere else later.
   */
  readonly source?: string;
  /** Overrides the default heading. */
  readonly heading?: string;
  /** Overrides the default line under the heading. */
  readonly blurb?: string;
  /** Overrides the default button label. */
  readonly cta?: string;
  /** Fill colour for the submit button. Defaults per intent. */
  readonly accent?: string;
  className?: string;
}

const COPY = {
  updates: {
    heading: 'Get the updates',
    blurb: 'New engines, new presets, and when the plugin lands. Nothing else.',
    cta: 'Keep me posted',
    done: 'You’re on the list. You’ll hear from us when there’s something worth hearing about — no drip campaign, no third parties.',
    accent: 'var(--fm)',
  },
  plugin: {
    heading: 'Want the plugin?',
    blurb: 'A VST3 build for your DAW. Tell us and you’ll be first in line.',
    cta: 'I want the plugin',
    done: 'Noted — you’re down for the plugin. We’ll email you when there’s a build to try, and that’s the only reason we’ll email you.',
    accent: 'var(--physical)',
  },
} as const satisfies Record<SignupIntent, {
  heading: string; blurb: string; cta: string; done: string; accent: string;
}>;

const BORDER = '3px solid var(--ink)';

type State = 'idle' | 'submitting' | 'done' | 'error';

export function EmailSignup({
  intent, source, heading, blurb, cta, accent, className,
}: EmailSignupProps): JSX.Element {
  const copy = COPY[intent];
  const fieldId = useId();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (state === 'submitting' || email.trim() === '') return;
    setState('submitting');
    setError(null);
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, intent, ...(source === undefined ? {} : { source }) }),
      });
      if (res.ok) {
        /*
         * The server answers identically for a new address and one already on the
         * list, so there is nothing to branch on here — and the copy must not
         * imply otherwise. "You're on the list" is true in both cases.
         */
        setState('done');
        setEmail('');
        return;
      }
      const body: unknown = await res.json().catch(() => null);
      const message = typeof body === 'object' && body !== null && 'error' in body
        ? String((body as Record<string, unknown>)['error'])
        : 'That didn’t go through. Try again.';
      setError(message);
      setState('error');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setState('error');
    }
  };

  if (state === 'done') {
    return (
      <div
        className={className}
        style={{ border: BORDER, background: 'var(--panel)', boxShadow: '6px 6px 0 0 var(--ink)' }}
      >
        {/* role="status" so the change is announced without stealing focus. */}
        <div role="status" className="flex flex-col gap-2 p-5">
          <p
            className="font-bold uppercase leading-none"
            style={{ fontSize: 15, letterSpacing: '0.08em', color: 'var(--ink)' }}
          >
            {intent === 'plugin' ? 'You’re in line' : 'You’re on the list'}
          </p>
          <p className="text-[14px] leading-relaxed" style={{ color: 'var(--ink)' }}>
            {copy.done}
          </p>
          {/* Not a dead end: a second person on a shared laptop, or a mistyped
              address, both need the form back. */}
          <button
            type="button"
            className="self-start text-[10px] font-bold uppercase tracking-[0.18em] underline"
            style={{ minHeight: 44, color: 'var(--ink)' }}
            onClick={(): void => { setState('idle'); }}
          >
            Add another address
          </button>
        </div>
      </div>
    );
  }

  const busy = state === 'submitting';

  return (
    <div
      className={className}
      style={{ border: BORDER, background: 'var(--panel)', boxShadow: '6px 6px 0 0 var(--ink)' }}
    >
      <div className="flex flex-col gap-3 p-5">
        <div className="flex flex-col gap-1.5">
          <h2
            className="font-bold uppercase leading-none"
            style={{ fontSize: 15, letterSpacing: '0.08em', color: 'var(--ink)' }}
          >
            {heading ?? copy.heading}
          </h2>
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--ink)' }}>
            {blurb ?? copy.blurb}
          </p>
        </div>

        <label htmlFor={fieldId} className="label" style={{ color: 'var(--ink)' }}>
          Email
        </label>

        {/* Stacks on a phone, sits on one line once there is room. Both keep the
            48px control height, comfortably past the 44px touch minimum. */}
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id={fieldId}
            type="email"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            placeholder="you@example.com"
            aria-invalid={state === 'error'}
            aria-describedby={`${fieldId}-status`}
            disabled={busy}
            className="w-full bg-transparent px-3 text-[15px] disabled:opacity-60"
            style={{
              height: 48,
              border: `3px solid ${state === 'error' ? 'var(--analog)' : 'var(--ink)'}`,
              color: 'var(--ink)',
              borderRadius: 0,
            }}
            value={email}
            onChange={(e): void => {
              setEmail(e.target.value);
              if (state === 'error') { setState('idle'); setError(null); }
            }}
            onKeyDown={(e): void => { if (e.key === 'Enter') void submit(); }}
          />

          <button
            type="button"
            disabled={busy || email.trim() === ''}
            className="hard shrink-0 px-5 text-[11px] font-bold uppercase tracking-[0.18em] disabled:opacity-40"
            style={{
              height: 48,
              border: BORDER,
              background: accent ?? copy.accent,
              color: 'var(--bg)',
              borderRadius: 0,
            }}
            onClick={(): void => { void submit(); }}
          >
            {busy ? 'Sending…' : (cta ?? copy.cta)}
          </button>
        </div>

        {/*
          Always in the tree, so a screen reader announces a change instead of
          racing an element that appears at the same instant. Holds the error and
          the reassurance in turn, so the block never changes height.
        */}
        <div id={`${fieldId}-status`} aria-live="polite" className="min-h-[18px]">
          {error !== null ? (
            <p className="text-[12px] font-bold" style={{ color: 'var(--analog)' }}>
              {error}
            </p>
          ) : (
            <p className="text-[12px]" style={{ color: 'var(--ink)', opacity: 0.8 }}>
              One address, kept private. Unsubscribe any time.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
