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
 * The SIGIL wordmark: a stem crossed by tines of falling length — a constructed
 * rune that doubles as a decaying spectrum.
 */
export function SigilMark({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 2 L4 22 M4 6 L20 6 M4 12 L15 12 M4 17 L10 17"
        stroke="var(--ink)"
        strokeWidth="2.6"
        strokeLinecap="square"
        fill="none"
      />
    </svg>
  );
}
