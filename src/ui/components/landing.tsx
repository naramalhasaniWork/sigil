import type { JSX, CSSProperties } from 'react';
import { SigilMark } from './engine-mark';
import { AUTHOR_NAME, AUTHOR_URL } from '@/ui/public-mode';

/**
 * The public landing page.
 *
 * Held to the instrument's own rules — flat fills, 3px rules, sharp corners, no
 * gradients and no soft shadows — because the page is the first thing a person
 * sees and it should not promise a different product than the one behind the
 * button.
 *
 * Server-rendered: it is text and links, and shipping a React runtime to render
 * that would slow down the one page whose whole job is to get out of the way.
 */

export const ENGINES: readonly { name: string; colour: string; what: string }[] = [
  { name: 'ANALOG', colour: '#FF6B6B', what: 'Classic subtractive voice with a four-pole ladder filter that self-oscillates. Basses, leads, pads.' },
  { name: 'FM', colour: '#4ECDC4', what: 'Frequency modulation across multiple operator algorithms. Bells, electric pianos, metallic percussion.' },
  { name: 'PHYSICAL', colour: '#FFD93D', what: 'Modelled resonators driven by struck and bowed excitation. Wood, metal, glass and skin.' },
  { name: 'GRANULAR', colour: '#8B5CF6', what: 'Audio divided into grains and rebuilt as clouds, drones and evolving texture.' },
  { name: 'WAVETABLE', colour: '#FF9F45', what: 'Scanning across banks of waveforms for timbres that move as they sound.' },
  { name: 'SAMPLER', colour: '#7BC96F', what: 'Your own recordings, mapped and played back with the full filter and envelope chain.' },
];

const IDEAS: readonly { title: string; body: string }[] = [
  {
    title: 'Learn as you build',
    body: 'Every parameter carries a plain description of what it does and when to reach for '
      + 'it. Deep synthesis stays legible whether you have been doing this for a month or a '
      + 'decade.',
  },
  {
    title: 'Find sounds by ear',
    body: 'Hunt generates variations on the patch you are holding, auditions them, and breeds '
      + 'together the ones you keep. A way of arriving somewhere you would not have designed '
      + 'on purpose.',
  },
  {
    title: 'Built for hardware',
    body: 'Bounce any sound to a WAV in a single tap, rendered at the sample rate the '
      + 'Teenage Engineering KO II expects, so it loads onto the device ready to play.',
  },
  {
    title: 'Plays anywhere',
    body: 'The full instrument runs in the browser on a laptop, a tablet or a phone, with '
      + 'MIDI controller support and gesture control through the camera.',
  },
];

const CARD: CSSProperties = {
  borderColor: 'var(--ink)',
  background: 'var(--panel)',
};

function Rule(): JSX.Element {
  return <div className="border-t-[3px]" style={{ borderColor: 'var(--muted)' }} />;
}

export function Landing({ buyUrl }: { buyUrl: string }): JSX.Element {
  return (
    <main className="min-h-screen px-5 py-10 sm:py-16">
      <div className="mx-auto w-full max-w-[760px] flex flex-col gap-12">

        {/* ---- hero ---- */}
        <header className="flex flex-col gap-6">
          <div className="flex items-center gap-4">
            <div
              className="flex items-center justify-center shrink-0 border-[3px]"
              style={{ width: 76, height: 76, ...CARD, boxShadow: '6px 6px 0 0 var(--ink)' }}
            >
              <SigilMark size={38} animate />
            </div>
            <div className="flex flex-col">
              <h1
                className="font-bold uppercase leading-none"
                style={{ fontSize: 52, letterSpacing: '0.06em', color: 'var(--ink)' }}
              >
                SIGIL
              </h1>
              <p className="label mt-2" style={{ color: 'var(--ink)', opacity: 0.8 }}>
                A sound design instrument
              </p>
            </div>
          </div>

          <p
            className="leading-relaxed"
            style={{ fontSize: 19, color: 'var(--ink)', maxWidth: '52ch' }}
          >
            Six synthesis engines in one instrument. Design a sound in the browser,
            then take it into your DAW.
          </p>

          <a
            href="/"
            className="hard border-[3px] flex items-center justify-center text-[13px] font-bold uppercase tracking-[0.2em]"
            style={{
              height: 60, borderColor: 'var(--ink)',
              background: 'var(--analog)', color: 'var(--bg)',
            }}
          >
            Play it now — free
          </a>
        </header>

        <Rule />

        {/* ---- the engines ---- */}
        <section className="flex flex-col gap-4">
          <h2 className="label" style={{ color: 'var(--ink)' }}>Six engines</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {ENGINES.map((e) => (
              <div key={e.name} className="border-[3px] p-4 flex flex-col gap-2.5" style={CARD}>
                <span
                  className="self-start border-[3px] px-2 py-1 text-[9px] font-bold uppercase"
                  style={{
                    borderColor: 'var(--ink)', background: e.colour,
                    color: 'var(--bg)', letterSpacing: '0.14em',
                  }}
                >
                  {e.name}
                </span>
                <p className="text-[13px] leading-relaxed" style={{ color: 'var(--ink)' }}>
                  {e.what}
                </p>
              </div>
            ))}
          </div>
        </section>

        <Rule />

        {/* ---- why ---- */}
        <section className="flex flex-col gap-5">
          {IDEAS.map((i) => (
            <div key={i.title} className="flex flex-col gap-1.5">
              <h3
                className="font-bold uppercase"
                style={{ fontSize: 14, letterSpacing: '0.1em', color: 'var(--ink)' }}
              >
                {i.title}
              </h3>
              <p
                className="text-[14px] leading-relaxed"
                style={{ color: 'var(--ink)', maxWidth: '60ch' }}
              >
                {i.body}
              </p>
            </div>
          ))}
        </section>

        <Rule />

        {/* ---- the plugin ---- */}
        <section
          className="border-[3px] p-6 flex flex-col gap-4"
          style={{ ...CARD, boxShadow: '8px 8px 0 0 var(--ink)' }}
        >
          <h2 className="label" style={{ color: 'var(--physical)' }}>In your DAW</h2>
          <p
            className="leading-relaxed"
            style={{ fontSize: 16, color: 'var(--ink)', maxWidth: '54ch' }}
          >
            All six engines as a VST3 plugin. Every parameter is automatable from the
            timeline, patches are saved with the project, and the instrument renders
            into your mix alongside everything else.
          </p>
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--ink)', opacity: 0.85 }}>
            Sounds designed in the browser open in the plugin unchanged.
          </p>

          {buyUrl === '' ? (
            <div
              className="border-[3px] flex items-center justify-center text-[11px] font-bold uppercase tracking-[0.18em]"
              style={{ height: 56, borderColor: 'var(--muted)', color: 'var(--ink)', opacity: 0.6 }}
            >
              Coming soon
            </div>
          ) : (
            <a
              href={buyUrl}
              className="hard border-[3px] flex items-center justify-center text-[12px] font-bold uppercase tracking-[0.18em]"
              style={{
                height: 56, borderColor: 'var(--ink)',
                background: 'var(--physical)', color: 'var(--bg)',
              }}
            >
              Get the plugin
            </a>
          )}

          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--ink)', opacity: 0.7 }}>
            macOS, VST3, Apple Silicon. Windows and Audio Units are on the way.
          </p>
        </section>

        <Rule />

        <footer className="flex items-center justify-between gap-4 flex-wrap">
          <a
            href={AUTHOR_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="label flex items-center"
            style={{ minHeight: 44, color: 'var(--ink)' }}
          >
            by {AUTHOR_NAME}
          </a>
          <a
            href="/"
            className="label flex items-center"
            style={{ minHeight: 44, color: 'var(--ink)', opacity: 0.7 }}
          >
            Open the instrument →
          </a>
        </footer>
      </div>
    </main>
  );
}
