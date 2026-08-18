'use client';

import type { JSX } from 'react';

export interface CellStripProps {
  /** "Scratch · Drop" — which cell everything here acts on. */
  label: string;
  /** There is a clip in the cell, so MOVE, CLEAR and transpose mean something. */
  hasClip: boolean;
  /** A clip is armed and waiting for a destination tap. */
  moveArmed: boolean;
  onAddNote: () => void;
  onMove: () => void;
  onClear: () => void;
  onTranspose: (semitones: number) => void;
  colour: string;
}

function Key({
  label, glyph, onPress, on = false, disabled = false, colour, wide = false,
}: {
  label: string; glyph: string; onPress: () => void;
  on?: boolean; disabled?: boolean; colour: string; wide?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={onPress}
      className="shrink-0 border-[3px] px-2 text-[10px] font-bold uppercase tracking-[0.12em] leading-none"
      style={{
        minWidth: wide ? '66px' : '44px',
        height: '44px',
        borderColor: 'var(--ink)',
        background: on ? colour : 'transparent',
        color: on ? 'var(--bg)' : 'var(--ink)',
        opacity: disabled ? 0.35 : 1,
        touchAction: 'manipulation',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {glyph}
    </button>
  );
}

/**
 * What you can do to the cell you have selected — in the footer, where your
 * thumb already is, rather than in a popover pinned to a 76px cell you would be
 * covering with that same thumb.
 *
 * MOVE is the reason this exists. Dragging a clip between small cells on a
 * touchscreen is the single worst interaction in every mobile DAW, so the
 * gesture here is select, tap MOVE, tap the destination. Two taps, works every
 * time, works one-handed — and while it is armed every legal landing spot in
 * the grid lights up, so you are never guessing where a drop will go.
 */
export function CellStrip({
  label, hasClip, moveArmed, onAddNote, onMove, onClear, onTranspose, colour,
}: CellStripProps): JSX.Element {
  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1.5 border-b-[3px] overflow-x-auto"
      style={{ borderColor: 'var(--ink)', background: 'var(--bg)' }}
    >
      <span
        className="shrink-0 text-[10px] font-bold uppercase tracking-[0.12em]"
        style={{ color: 'var(--ink)' }}
      >
        {moveArmed ? 'tap a cell to move it there' : label}
      </span>

      <span className="flex-1" />

      <Key
        label="Choose a note to put in this cell"
        glyph="+ note"
        wide
        colour={colour}
        onPress={onAddNote}
      />
      <Key
        label={moveArmed ? 'Cancel the move' : 'Move this clip to another cell'}
        glyph={moveArmed ? 'cancel' : 'move'}
        wide
        on={moveArmed}
        disabled={!hasClip && !moveArmed}
        colour="var(--physical)"
        onPress={onMove}
      />
      <Key
        label="Transpose this clip down an octave"
        glyph="−12"
        disabled={!hasClip}
        colour={colour}
        onPress={(): void => onTranspose(-12)}
      />
      <Key
        label="Transpose this clip up an octave"
        glyph="+12"
        disabled={!hasClip}
        colour={colour}
        onPress={(): void => onTranspose(12)}
      />
      <Key
        label="Empty this cell"
        glyph="clear"
        wide
        disabled={!hasClip}
        colour="#FF3B30"
        onPress={onClear}
      />
    </div>
  );
}
