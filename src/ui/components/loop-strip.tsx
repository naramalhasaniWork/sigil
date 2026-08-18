'use client';

import type { JSX } from 'react';
import { PPQ } from '@/dsp/sequencer';
import type { Sequencer } from '@/ui/use-sequencer';

export interface LoopStripProps {
  /** The EXISTING Sequencer handle, passed straight through — no adapter. */
  seq: Sequencer;
  /** "Bass · drop" — the cell this loop will be written into. */
  targetLabel: string;
  colour: string;
}

/** Off, then the two divisions anyone actually loops to. */
const QUANTISE: readonly { label: string; division: number; strength: number }[] = [
  { label: 'off', division: PPQ / 4, strength: 0 },
  { label: '1/8', division: PPQ / 2, strength: 1 },
  { label: '1/16', division: PPQ / 4, strength: 1 },
];

function Key({
  label, glyph, onPress, on = false, danger = false, colour, wide = false,
}: {
  label: string; glyph: string; onPress: () => void;
  on?: boolean; danger?: boolean; colour: string; wide?: boolean;
}): JSX.Element {
  const fill = danger ? '#FF3B30' : colour;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      onClick={onPress}
      className="shrink-0 border-[3px] text-[10px] font-bold uppercase tracking-[0.12em] leading-none px-2"
      style={{
        minWidth: wide ? '58px' : '44px',
        height: '44px',
        borderColor: 'var(--ink)',
        background: on ? fill : 'transparent',
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
 * The loop pedal, and it lives in the footer rather than in the timeline on
 * purpose. You cannot arrange clips you never captured, and capturing one is a
 * PLAYING gesture — your eyes are on the keyboard, not on the grid. So the
 * controls sit attached to the play surface, one row above the keys.
 *
 * The whole feature is the first button:
 *
 *   Hit REC. Play. You now have a clip in the song.
 *
 * It records into whatever cell the playhead is over on the selected track,
 * creating the cell if it is empty. `targetLabel` says which cell that is, in
 * --ink, because it is the one piece of text here that has to be read.
 */
export function LoopStrip({ seq, targetLabel, colour }: LoopStripProps): JSX.Element {
  const q = QUANTISE.findIndex(
    (x) => x.division === seq.quantiseDivision && x.strength === seq.quantiseStrength,
  );
  const quant = QUANTISE[q < 0 ? 0 : q] ?? QUANTISE[0];

  /*
   * Four states, spelled out. "Is it armed, is it rolling, is it writing?" was
   * unanswerable from a button that only changed colour, and a looper you
   * cannot read the state of is a looper you do not trust.
   */
  const state = seq.isRecording ? 'rec' : seq.isPlaying ? 'play' : 'stop';
  const stateColour = state === 'rec' ? '#FF3B30' : state === 'play' ? colour : 'var(--ink)';
  const bars = Math.max(1, seq.pattern.lengthBars);
  const through = seq.isPlaying
    ? ((seq.currentBar - 1) + (seq.currentBeat - 1) / Math.max(1, seq.pattern.beatsPerBar)) / bars
    : 0;

  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1.5 border-b-[3px] overflow-x-auto"
      style={{ borderColor: 'var(--ink)', background: 'var(--panel)' }}
    >
      <span
        className="shrink-0 flex items-center justify-center border-[3px] text-[10px] font-bold uppercase tracking-[0.14em] tabular-nums"
        style={{
          minWidth: '74px',
          height: '44px',
          borderColor: 'var(--ink)',
          background: state === 'stop' ? 'transparent' : stateColour,
          color: state === 'stop' ? 'var(--ink)' : 'var(--bg)',
        }}
      >
        {state === 'stop' ? 'loop' : `${state} ${seq.currentBar}.${seq.currentBeat}`}
      </span>

      <Key
        label={seq.isRecording ? 'Stop recording the loop' : 'Record into the song'}
        glyph="● rec"
        wide
        on={seq.isRecording}
        danger
        colour={colour}
        onPress={seq.toggleRecord}
      />
      <Key
        label={seq.isPlaying ? 'Stop the loop' : 'Play the loop'}
        glyph={seq.isPlaying ? '■' : '▶'}
        on={seq.isPlaying}
        colour={colour}
        onPress={seq.isPlaying ? seq.stop : seq.play}
      />

      {/* Where you are inside the loop, as a bar rather than a number: at a
          glance, from across the room, while your hands are on the keys. */}
      <span
        aria-hidden="true"
        className="shrink-0 relative border-[3px]"
        style={{ width: '64px', height: '44px', borderColor: 'var(--ink)' }}
      >
        <span
          className="absolute inset-y-0 left-0"
          style={{
            width: `${Math.round(Math.min(1, Math.max(0, through)) * 100)}%`,
            background: stateColour,
            opacity: state === 'stop' ? 0.25 : 1,
          }}
        />
      </span>

      <span className="shrink-0 flex items-center">
        <Key
          label="Shorter loop"
          glyph="−"
          colour={colour}
          onPress={(): void => seq.setLengthBars(seq.pattern.lengthBars - 1)}
        />
        <span
          className="px-2 text-[11px] font-bold tabular-nums uppercase tracking-[0.08em]"
          style={{ color: 'var(--ink)' }}
        >
          {seq.pattern.lengthBars} bar{seq.pattern.lengthBars === 1 ? '' : 's'}
        </span>
        <Key
          label="Longer loop"
          glyph="+"
          colour={colour}
          onPress={(): void => seq.setLengthBars(seq.pattern.lengthBars + 1)}
        />
      </span>

      <span className="hidden sm:inline-flex">
        <Key
          label={`Quantise ${quant?.label ?? 'off'} — tap to change`}
          glyph={`q ${quant?.label ?? 'off'}`}
          wide
          on={(quant?.strength ?? 0) > 0}
          colour={colour}
          onPress={(): void => {
            const next = QUANTISE[((q < 0 ? 0 : q) + 1) % QUANTISE.length] ?? QUANTISE[0];
            if (next) seq.setQuantise(next.division, next.strength);
          }}
        />
      </span>

      <Key label="Undo the last pass" glyph="undo" wide colour={colour} onPress={seq.undoPass} />
      <Key label="Clear the loop" glyph="clr" colour={colour} onPress={seq.clear} />

      <span className="flex-1" />

      <span
        className="shrink-0 text-[10px] font-bold uppercase tracking-[0.12em] tabular-nums"
        style={{ color: 'var(--ink)' }}
      >
        {targetLabel}
      </span>
    </div>
  );
}
