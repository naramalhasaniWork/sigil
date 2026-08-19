import type { JSX, CSSProperties } from 'react';
import { SigilMark } from './engine-mark';
import { AudioDemo, EngineGrid } from './landing-engines';
import { Shot, SwapShot } from './landing-shots';
import { AUTHOR_NAME, AUTHOR_URL } from '@/ui/public-mode';

/**
 * The public landing page.
 *
 * It leads with evidence rather than argument: a screenshot of the running
 * instrument, then something to listen to, then the button. The earlier version
 * of this page was four paragraphs of prose about a synthesiser nobody could see
 * or hear, which is exactly backwards for the product it is selling.
 *
 * Held to the instrument's own rules — flat fills, 3px rules, sharp corners, no
 * gradients and no soft shadows — because the page is the first thing a person
 * sees and it should not promise a different product than the one behind the
 * button. `--muted` fails AA on `--panel`, so anything meant to be read is
 * `--ink`; --muted is left for hairlines.
 *
 * Server-rendered: images, audio elements and links. Shipping a React runtime to
 * render that would slow down the one page whose whole job is to get out of the
 * way.
 */

const CARD: CSSProperties = { borderColor: 'var(--ink)', background: 'var(--panel)' };

/** The plugin price. docs/business/selling-sigil.md, and it is stated, not hidden. */
const PRICE = '$49';

/** Short enough to read in one pass. Anything longer belongs in the screenshots. */
const FACTS: readonly string[] = [
  'Every parameter carries a plain description of what it does.',
  'Bounce any sound to a WAV, or record a take as you play it.',
  'Runs in the browser on a laptop, tablet or phone. MIDI controllers work.',
];

function Rule(): JSX.Element {
  return <div className="border-t-[3px]" style={{ borderColor: 'var(--muted)' }} />;
}

export function Landing({ buyUrl }: { buyUrl: string }): JSX.Element {
  return (
    <main className="min-h-screen px-5 py-10 sm:py-14">
      {/*
        The browser's own audio transport is the right control — accessible,
        familiar, and impossible to get wrong on a phone — but it ships with
        rounded corners, and this page has none anywhere else. Squaring the
        enclosure is the whole of the intervention; the icons keep their default
        colours, so contrast is untouched.
      */}
      <style>{
        'audio{border-radius:0}'
        + 'audio::-webkit-media-controls-enclosure{border-radius:0}'
        + 'audio::-webkit-media-controls-panel{border-radius:0}'
      }</style>
      <div className="mx-auto w-full max-w-[880px] flex flex-col gap-10">

        {/* ---- who this is ---- */}
        <header className="flex items-center gap-4">
          <div
            className="flex items-center justify-center shrink-0 border-[3px]"
            style={{ width: 68, height: 68, ...CARD, boxShadow: '6px 6px 0 0 var(--ink)' }}
          >
            <SigilMark size={34} animate />
          </div>
          <div className="flex flex-col">
            <h1
              className="font-bold uppercase leading-none"
              style={{ fontSize: 44, letterSpacing: '0.06em', color: 'var(--ink)' }}
            >
              SIGIL
            </h1>
            <p className="mt-2 leading-snug" style={{ fontSize: 17, color: 'var(--ink)' }}>
              Six synthesis engines, in a browser tab.
            </p>
          </div>
        </header>

        {/* ---- the product, on sight ---- */}
        <SwapShot
          wide={{ src: '/shots/sigil-sculpt.png', width: 2240, height: 1800 }}
          narrow={{ src: '/shots/sigil-phone.png', width: 780, height: 1688 }}
          alt={
            'SIGIL running its FM engine: a live oscilloscope and frequency spectrum above '
            + 'the macro controls, the preset list and a playable keyboard.'
          }
          caption="Mid-note, on the FM engine. Nothing installed, nothing signed up for."
        />

        <a
          href="/"
          className="hard border-[3px] flex items-center justify-center text-[13px] font-bold uppercase tracking-[0.2em]"
          style={{
            minHeight: 60, borderColor: 'var(--ink)',
            background: 'var(--analog)', color: 'var(--bg)',
          }}
        >
          Play it now — free
        </a>

        {/* ---- and on hearing ---- */}
        <section className="border-[3px] p-4 flex flex-col gap-3" style={CARD}>
          <h2 className="label" style={{ color: 'var(--ink)' }}>
            Hear it first — FM, Hour Bell
          </h2>
          <AudioDemo src="/audio/sigil-fm-bell.mp3" label="SIGIL demo — FM engine, Hour Bell" />
          <p className="text-[13px] leading-snug" style={{ color: 'var(--ink)' }}>
            Rendered straight out of the instrument. Every clip on this page is, and every
            one is a preset you can open and take apart.
          </p>
        </section>

        <Rule />

        {/* ---- the engines, each with its own evidence ---- */}
        <section className="flex flex-col gap-4">
          <h2 className="label" style={{ color: 'var(--ink)' }}>Six engines, six demos</h2>
          <EngineGrid />
        </section>

        <Rule />

        {/* ---- what the rest of it looks like ---- */}
        <section className="grid gap-4 sm:grid-cols-[1.35fr_1fr] items-start">
          <SwapShot
            wide={{ src: '/shots/sigil-fx.png', width: 2240, height: 1800 }}
            narrow={{ src: '/shots/sigil-phone-fx.png', width: 780, height: 1688 }}
            alt={
              'The effects tab: a chain of drive, crush, chorus, delay, reverb and output, '
              + 'with a second column of character effects.'
            }
            caption="Effects and character, on every engine."
          />
          {/*
            Desktop only: on a phone this same capture is already the hero above,
            so showing it twice would be the one image a visitor has seen most.
          */}
          <Shot
            className="hidden sm:flex"
            capture={{ src: '/shots/sigil-phone.png', width: 780, height: 1688 }}
            alt={
              'SIGIL on a phone-width screen: the scope and spectrum above a grid of chord '
              + 'pads in F harmonic minor.'
            }
            caption="The whole instrument on a phone."
          />
        </section>

        <ul className="flex flex-col gap-2 list-none p-0 m-0">
          {FACTS.map((fact) => (
            <li
              key={fact}
              className="text-[14px] leading-snug"
              style={{ color: 'var(--ink)' }}
            >
              {fact}
            </li>
          ))}
        </ul>

        <Rule />

        {/* ---- the paid thing ---- */}
        <section
          className="border-[3px] p-6 flex flex-col gap-4"
          style={{ ...CARD, boxShadow: '8px 8px 0 0 var(--ink)' }}
        >
          <h2 className="label" style={{ color: 'var(--physical)' }}>In your DAW</h2>
          <p className="leading-snug" style={{ fontSize: 16, color: 'var(--ink)', maxWidth: '54ch' }}>
            The same six engines as a VST3 plugin: automatable from the timeline, saved with
            the project, rendered with the mix. Sounds designed in the browser open in the
            plugin unchanged.
          </p>

          <div className="flex items-baseline gap-3 flex-wrap">
            <span
              className="font-bold leading-none"
              style={{ fontSize: 40, color: 'var(--ink)' }}
            >
              {PRICE}
            </span>
            <span className="label" style={{ color: 'var(--ink)' }}>
              one time · lifetime updates
            </span>
          </div>

          {buyUrl === '' ? (
            <div
              className="border-[3px] flex items-center justify-center text-center px-4 text-[11px] font-bold uppercase tracking-[0.18em]"
              style={{ minHeight: 56, borderColor: 'var(--muted)', color: 'var(--ink)' }}
            >
              Not on sale yet — {PRICE} when it is
            </div>
          ) : (
            <a
              href={buyUrl}
              className="hard border-[3px] flex items-center justify-center text-[12px] font-bold uppercase tracking-[0.18em]"
              style={{
                minHeight: 56, borderColor: 'var(--ink)',
                background: 'var(--physical)', color: 'var(--bg)',
              }}
            >
              Buy the plugin — {PRICE}
            </a>
          )}

          <p className="text-[12px] leading-snug" style={{ color: 'var(--ink)' }}>
            macOS, VST3, Apple Silicon. Windows and Audio Units are on the way. The browser
            version stays free and complete either way.
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
            style={{ minHeight: 44, color: 'var(--ink)' }}
          >
            Open the instrument →
          </a>
        </footer>
      </div>
    </main>
  );
}
