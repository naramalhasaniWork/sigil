import type { JSX, CSSProperties } from 'react';
import type { Metadata } from 'next';
import { SigilMark } from '@/ui/components/engine-mark';
import { AUTHOR_NAME, AUTHOR_URL } from '@/ui/public-mode';

/**
 * The front door for the public build.
 *
 * The instrument itself lives at `/` and loads straight into a playable state,
 * which is the right behaviour for someone returning. This page is for someone
 * arriving: what the thing is, one button into it, and one button to buy the
 * plugin version.
 *
 * A server component on purpose — it is text and two links, and shipping the
 * React runtime to render that would be silly on a page whose whole job is to
 * be fast enough that nobody bounces before the instrument loads.
 */

export const metadata: Metadata = {
  title: 'SIGIL — a sound design instrument',
  description:
    'Six synthesis engines in a browser. Free to use, nothing to install. '
    + 'Also available as a VST3 plugin for your DAW.',
};

/**
 * Where the plugin is sold. Unset until there is somewhere real to send people,
 * and the button says so rather than pointing at a 404 — a dead buy button
 * costs more trust than an honest "not yet".
 */
const BUY_URL = process.env.NEXT_PUBLIC_SIGIL_BUY_URL ?? '';

const ENGINES: readonly (readonly [string, string])[] = [
  ['ANALOG', '#FF6B6B'],
  ['FM', '#4ECDC4'],
  ['PHYSICAL', '#FFD93D'],
  ['GRANULAR', '#8B5CF6'],
  ['WAVETABLE', '#FF9F45'],
  ['SAMPLER', '#7BC96F'],
];

const CARD: CSSProperties = {
  borderColor: 'var(--ink)',
  background: 'var(--panel)',
  boxShadow: '8px 8px 0 0 var(--ink)',
};

export default function StartPage(): JSX.Element {
  return (
    <main className="min-h-screen flex items-center justify-center p-5">
      <div className="w-full max-w-[620px] flex flex-col gap-7">

        <div className="flex items-center gap-4">
          <div
            className="flex items-center justify-center shrink-0 border-[3px]"
            style={{ width: 68, height: 68, ...CARD, boxShadow: '5px 5px 0 0 var(--ink)' }}
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
          Six synthesis engines in a browser. Nothing to install, no account, and
          nothing stored anywhere but your own machine.
        </p>

        <div className="flex flex-wrap gap-1.5">
          {ENGINES.map(([name, colour]) => (
            <div
              key={name}
              className="border-[3px] px-2.5 py-1.5 text-[9px] font-bold uppercase"
              style={{
                borderColor: 'var(--ink)', background: colour,
                color: 'var(--bg)', letterSpacing: '0.14em',
              }}
            >
              {name}
            </div>
          ))}
        </div>

        {/* The free thing first, and visually loudest. Someone who plays it is
            the only person who will ever consider buying the plugin. */}
        <a
          href="/"
          className="hard border-[3px] flex items-center justify-center text-[12px] font-bold uppercase tracking-[0.2em]"
          style={{
            height: 56, borderColor: 'var(--ink)',
            background: 'var(--analog)', color: 'var(--bg)',
          }}
        >
          Play it in your browser
        </a>

        <div className="border-[3px] p-5 flex flex-col gap-3" style={CARD}>
          <span className="label" style={{ color: 'var(--ink)' }}>
            In your DAW
          </span>
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--ink)' }}>
            The same six engines as a VST3 plugin — the audio verified identical to
            what you just played, sample for sample. Automate every parameter from
            your timeline and record it like any other instrument.
          </p>

          {BUY_URL === '' ? (
            <div
              className="border-[3px] flex items-center justify-center text-[11px] font-bold uppercase tracking-[0.18em]"
              style={{ height: 52, borderColor: 'var(--muted)', color: 'var(--ink)', opacity: 0.6 }}
            >
              Coming soon
            </div>
          ) : (
            <a
              href={BUY_URL}
              className="hard border-[3px] flex items-center justify-center text-[11px] font-bold uppercase tracking-[0.18em]"
              style={{
                height: 52, borderColor: 'var(--ink)',
                background: 'var(--physical)', color: 'var(--bg)',
              }}
            >
              Get the plugin
            </a>
          )}

          <p className="text-[11px] leading-snug" style={{ color: 'var(--ink)', opacity: 0.7 }}>
            macOS, VST3. Apple Silicon.
          </p>
        </div>

        <a
          href={AUTHOR_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="label flex items-center"
          style={{ minHeight: 44, color: 'var(--ink)', opacity: 0.65 }}
        >
          by {AUTHOR_NAME}
        </a>
      </div>
    </main>
  );
}
