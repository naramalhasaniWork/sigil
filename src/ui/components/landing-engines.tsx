import type { JSX, CSSProperties } from 'react';

/**
 * The six engines, each with one line and — where one was rendered — a demo you
 * can play without leaving the page.
 *
 * Every clip is a real offline render of that engine through the same DSP the
 * instrument runs, playing the named preset in F harmonic minor. Nothing here
 * was recorded from another synth, sweetened, or mixed; the only post-processing
 * is a loudness match so the six sit at the same level.
 *
 * `preload="none"` on purpose: six clips is half a megabyte, and a landing page
 * that spends it before anyone presses play is a slower page for no gain.
 */

export interface Engine {
  readonly name: string;
  readonly colour: string;
  readonly what: string;
  /** The rendered demo, or null where there is honestly nothing to play. */
  readonly demo: { readonly src: string; readonly preset: string } | null;
}

export const ENGINES: readonly Engine[] = [
  {
    name: 'ANALOG', colour: '#FF6B6B',
    what: 'Subtractive, with a four-pole ladder filter that self-oscillates.',
    demo: { src: '/audio/sigil-analog-bass.mp3', preset: 'Bedrock' },
  },
  {
    name: 'FM', colour: '#4ECDC4',
    what: 'Four operators across the classic algorithms. Bells, electric pianos, metal.',
    demo: { src: '/audio/sigil-fm-piano.mp3', preset: 'Tine Letter' },
  },
  {
    name: 'PHYSICAL', colour: '#FFD93D',
    what: 'Modelled resonators, struck or bowed. Wood, metal, glass and skin.',
    demo: { src: '/audio/sigil-physical.mp3', preset: 'Gamelan Court' },
  },
  {
    name: 'GRANULAR', colour: '#8B5CF6',
    what: 'Audio cut into grains and rebuilt as clouds and drones.',
    demo: { src: '/audio/sigil-granular.mp3', preset: 'Vapor Column' },
  },
  {
    name: 'WAVETABLE', colour: '#FF9F45',
    what: 'Scanning banks of waveforms, so the timbre moves as it sounds.',
    demo: { src: '/audio/sigil-wavetable.mp3', preset: 'Glass Organ' },
  },
  {
    name: 'SAMPLER', colour: '#7BC96F',
    what: 'Your own recordings, through the same filters and envelopes.',
    demo: null,
  },
];

const CARD: CSSProperties = { borderColor: 'var(--ink)', background: 'var(--panel)' };

/**
 * A native `<audio controls>` and nothing else. A hand-built transport would be
 * one more thing to get wrong on a phone, and the browser's own is already
 * keyboard-reachable, screen-reader-labelled and big enough to hit.
 */
export function AudioDemo({ src, label }: { src: string; label: string }): JSX.Element {
  return (
    <div className="border-[3px]" style={{ borderColor: 'var(--ink)' }}>
      <audio
        controls
        preload="none"
        src={src}
        aria-label={label}
        className="block w-full"
        style={{ minHeight: 44 }}
      />
    </div>
  );
}

function EngineCard({ engine }: { engine: Engine }): JSX.Element {
  return (
    <li className="border-[3px] p-4 flex flex-col gap-3" style={CARD}>
      <div className="flex items-baseline gap-3 flex-wrap">
        <span
          className="border-[3px] px-2 py-1 text-[9px] font-bold uppercase"
          style={{
            borderColor: 'var(--ink)', background: engine.colour,
            color: 'var(--bg)', letterSpacing: '0.14em',
          }}
        >
          {engine.name}
        </span>
        {engine.demo !== null && (
          <span className="label" style={{ color: 'var(--ink)' }}>
            {engine.demo.preset}
          </span>
        )}
      </div>

      <p className="text-[14px] leading-snug" style={{ color: 'var(--ink)' }}>
        {engine.what}
      </p>

      {engine.demo === null ? (
        <p className="text-[12px] leading-snug" style={{ color: 'var(--ink)' }}>
          No demo — it plays whatever you load into it.
        </p>
      ) : (
        <AudioDemo
          src={engine.demo.src}
          label={`${engine.name} demo — ${engine.demo.preset}`}
        />
      )}
    </li>
  );
}

export function EngineGrid(): JSX.Element {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 list-none p-0 m-0">
      {ENGINES.map((engine) => <EngineCard key={engine.name} engine={engine} />)}
    </ul>
  );
}
