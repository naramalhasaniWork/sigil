'use client';

import type { JSX } from 'react';
import { noteName, scaleNotes, type ScaleName } from '@/dsp/chords';

export interface NotePickerProps {
  /** "Scratch · Drop" — the cell the note lands in. */
  label: string;
  root: number;
  scale: ScaleName;
  octave: number;
  onOctave: (next: number) => void;
  /** Places the note and closes. One tap, one note, done. */
  onPick: (midi: number) => void;
  onClose: () => void;
  colour: string;
}

/** One octave of the current scale, plus the octave above's root to close it. */
const DEGREES = 8;

/**
 * Pick a note. That is the entire component.
 *
 * It exists because "put one note in one cell" was the thing people could not
 * do. The path is now: tap the cell's +, tap a note. Two actions, no modal, no
 * options, and nothing about clips or patterns — those are our data model, not
 * anyone's mental model. Picking closes the picker, because a picker that stays
 * open is a mode, and a mode is the thing that makes this feel complicated.
 *
 * The notes offered are the notes of the scale you already chose downstairs, so
 * every one of them is a note that belongs.
 */
export function NotePicker({
  label, root, scale, octave, onOctave, onPick, onClose, colour,
}: NotePickerProps): JSX.Element {
  const base = 12 * octave + root;
  const notes = scaleNotes(base, scale, DEGREES);

  return (
    <div
      role="group"
      aria-label={`Choose a note for ${label}`}
      className="flex items-center gap-1.5 px-2 py-1.5 border-b-[3px] overflow-x-auto"
      style={{ borderColor: 'var(--ink)', background: 'var(--panel)' }}
    >
      <span
        className="shrink-0 text-[10px] font-bold uppercase tracking-[0.12em]"
        style={{ color: 'var(--ink)' }}
      >
        {label} ←
      </span>

      {notes.map((midi, i) => (
        <button
          key={`${midi}-${i}`}
          type="button"
          aria-label={`Put ${noteName(midi)} in ${label}`}
          onClick={(): void => onPick(midi)}
          className="shrink-0 border-[3px] px-2 text-[11px] font-bold uppercase tracking-[0.08em] tabular-nums"
          style={{
            minWidth: '48px',
            height: '44px',
            borderColor: 'var(--ink)',
            background: i === 0 ? colour : 'transparent',
            color: i === 0 ? 'var(--bg)' : 'var(--ink)',
            touchAction: 'manipulation',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {noteName(midi)}
        </button>
      ))}

      <span className="flex-1" />

      <button
        type="button"
        aria-label="Lower octave"
        onClick={(): void => onOctave(Math.max(0, octave - 1))}
        className="shrink-0 border-[3px] text-[13px] font-bold"
        style={{ width: '44px', height: '44px', borderColor: 'var(--ink)', color: 'var(--ink)' }}
      >
        −8
      </button>
      <button
        type="button"
        aria-label="Higher octave"
        onClick={(): void => onOctave(Math.min(8, octave + 1))}
        className="shrink-0 border-[3px] text-[13px] font-bold"
        style={{ width: '44px', height: '44px', borderColor: 'var(--ink)', color: 'var(--ink)' }}
      >
        +8
      </button>
      <button
        type="button"
        aria-label="Close the note picker"
        onClick={onClose}
        className="shrink-0 border-[3px] text-[13px] font-bold"
        style={{ width: '44px', height: '44px', borderColor: 'var(--ink)', color: 'var(--ink)' }}
      >
        ×
      </button>
    </div>
  );
}
