import type { JSX } from 'react';

interface MarkProps {
  engineId: string;
  colour: string;
  size?: number;
}

/**
 * Engine marks are signal behaviour drawn as a glyph — not decoration, and
 * deliberately not the circle/square/triangle Bauhaus cliche. Each mark shows
 * what its engine actually does to a signal, so the rail teaches you something.
 */
export function EngineMark({ engineId, colour, size = 22 }: MarkProps): JSX.Element {
  const stroke = { stroke: colour, strokeWidth: 2.6, fill: 'none', strokeLinecap: 'square' as const };

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {engineId === 'analog' && (
        // sawtooth: the ramp and its hard reset
        <path d="M2 18 L9 6 L9 18 L16 6 L16 18 L22 9" {...stroke} />
      )}
      {engineId === 'fm' && (
        // two waves beating against each other — modulator over carrier
        <>
          <path d="M2 12 Q5 4 8 12 T14 12 T20 12" {...stroke} />
          <path d="M2 12 Q3.5 16 5 12 T8 12 T11 12 T14 12 T17 12 T20 12" {...stroke} strokeWidth={1.6} opacity={0.7} />
        </>
      )}
      {engineId === 'physical' && (
        // a strike, then resonance dying away
        <>
          <path d="M3 3 L3 21" {...stroke} />
          <path d="M8 6 L8 18 M13 8.5 L13 15.5 M17.5 10.5 L17.5 13.5 M21 11.5 L21 12.5" {...stroke} />
        </>
      )}
      {engineId === 'wavetable' && (
        // two table layers, simple over complex, with the scan position marked
        <>
          <path d="M2 7 Q6.5 2.5 11 7 T20 7" {...stroke} />
          <path d="M2 17.5 L4.5 14 L7 21 L9.5 14 L12 21 L14.5 14 L17 21 L20 17.5" {...stroke} strokeWidth={2.2} />
          <rect x="13.5" y="4" width="4" height="4" fill={colour} />
        </>
      )}
      {engineId === 'sampler' && (
        // a clip held between trim brackets
        <>
          <path d="M5 3.5 L2.5 3.5 L2.5 20.5 L5 20.5" {...stroke} strokeWidth={2.2} />
          <path d="M19 3.5 L21.5 3.5 L21.5 20.5 L19 20.5" {...stroke} strokeWidth={2.2} />
          <path d="M7.5 15 L7.5 9 M11 18.5 L11 5.5 M14.5 16.5 L14.5 7.5 M17.5 13.5 L17.5 10.5" {...stroke} strokeWidth={2.2} />
        </>
      )}
      {engineId === 'drum' && (
        // impulses of falling weight on a floor: kick, tom, snare, hat
        <>
          <path d="M2 20.5 L22 20.5" {...stroke} strokeWidth={2.2} />
          <path d="M5 20.5 L5 5 M9.5 20.5 L9.5 12 M14 20.5 L14 8 M18.5 20.5 L18.5 15" {...stroke} strokeWidth={2.6} />
        </>
      )}
      {engineId === 'granular' && (
        // a cloud of grains, scattered in time and pitch
        <>
          <path d="M2 14 L4 14 M6 8 L8 8 M9 17 L11 17 M12 6 L14 6 M15 12 L17 12 M18 9 L20 9 M20.5 16 L22.5 16" {...stroke} />
          <path d="M5 11 L6.5 11 M10 10 L11.5 10 M16 16 L17.5 16" {...stroke} strokeWidth={1.6} opacity={0.6} />
        </>
      )}
    </svg>
  );
}

/**
 * The SIGIL seal. A sigil is a constructed mark, so this is built rather than
 * drawn: one vertical stem, three tines of falling length reading as a decaying
 * spectrum, and a diagonal that cuts the whole form so it never resolves into a
 * letter. Asymmetric on purpose — symmetry would make it a logo, not a mark.
 */
export function SigilMark({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <g stroke="var(--ink)" strokeWidth="2.6" strokeLinecap="square" fill="none">
        <path d="M4 2 L4 22" />
        <path d="M4 5.5 L20 5.5" />
        <path d="M4 12 L14.5 12" />
        <path d="M4 18.5 L9.5 18.5" />
      </g>
      <path d="M17 2.5 L10 21.5" stroke="var(--analog)" strokeWidth="2.6" strokeLinecap="square" fill="none" />
    </svg>
  );
}

/** Wordmark lockup: the seal plus the name, tracked tight so it reads as one object. */
export function SigilWordmark({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <span className="flex items-center gap-2.5">
      <SigilMark size={size} />
      <span
        className="font-bold uppercase"
        style={{ fontSize: size * 0.82, letterSpacing: '-0.03em', lineHeight: 1 }}
      >
        SIGIL
      </span>
    </span>
  );
}
