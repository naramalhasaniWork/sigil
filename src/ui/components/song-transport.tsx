'use client';

import type { JSX } from 'react';

export interface SongTransportProps {
  isPlaying: boolean;
  onPlay: () => void;
  onStop: () => void;
  /** 1-indexed inside the section, matching barBeatOfTick. */
  position: { bar: number; beat: number } | null;
  /** The section under the playhead, or the selected one when stopped. */
  sectionName: string | null;
  bpm: number;
  onBpm: (v: number) => void;
  loopOn: boolean;
  onToggleLoop: () => void;
  colour: string;
}

function Key({
  label, glyph, onPress, on = false, colour, wide = false,
}: {
  label: string; glyph: string; onPress: () => void;
  on?: boolean; colour: string; wide?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      onClick={onPress}
      className="shrink-0 border-[3px] px-2 text-[10px] font-bold uppercase tracking-[0.12em] leading-none"
      style={{
        minWidth: wide ? '58px' : '44px',
        height: '44px',
        borderColor: 'var(--ink)',
        background: on ? colour : 'transparent',
        color: on ? 'var(--bg)' : 'var(--ink)',
        touchAction: 'manipulation',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {glyph}
    </button>
  );
}

/**
 * Song play / stop / position / tempo.
 *
 * NAME COLLISION, ON PURPOSE, SO NOBODY MERGES THEM: `transport.tsx` is power,
 * record and bounce, and it stays in the AppHeader untouched. This one drives
 * the arrangement and lives at the head of the song pane.
 *
 * Everything readable here is --ink. The position readout in particular is the
 * one number people stare at while they play, and --muted fails AA on panel.
 */
export function SongTransport({
  isPlaying, onPlay, onStop, position, sectionName, bpm, onBpm, loopOn, onToggleLoop, colour,
}: SongTransportProps): JSX.Element {
  return (
    <div
      className="flex items-center gap-1.5 flex-wrap px-2 py-1 border-b-[3px]"
      style={{ borderColor: 'var(--ink)', background: 'var(--panel)', minHeight: '44px' }}
    >
      <Key
        label={isPlaying ? 'Stop the song' : 'Play the song'}
        glyph={isPlaying ? '■ stop' : '▶ play'}
        wide
        on={isPlaying}
        colour={colour}
        onPress={isPlaying ? onStop : onPlay}
      />
      <Key
        label={loopOn ? 'Stop looping this section' : 'Loop the section under the playhead'}
        glyph="loop"
        wide
        on={loopOn}
        colour={colour}
        onPress={onToggleLoop}
      />

      <span
        className="px-2 text-[11px] font-bold uppercase tracking-[0.08em] tabular-nums"
        style={{ color: 'var(--ink)' }}
      >
        {sectionName ?? '—'}
        {position === null ? '' : ` ${position.bar}.${position.beat}`}
      </span>

      <span className="flex-1" />

      <Key label="Slower" glyph="−" colour={colour} onPress={(): void => onBpm(bpm - 1)} />
      <span
        className="px-1.5 text-[11px] font-bold tabular-nums uppercase tracking-[0.08em]"
        style={{ color: 'var(--ink)' }}
      >
        {Math.round(bpm)} bpm
      </span>
      <Key label="Faster" glyph="+" colour={colour} onPress={(): void => onBpm(bpm + 1)} />
    </div>
  );
}
