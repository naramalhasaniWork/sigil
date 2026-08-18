'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { SCALES, diatonicChord, noteName, scaleNotes, type ScaleName } from '@/dsp/chords';

export interface PadGridProps {
  rows: number;
  cols: number;
  root: number;
  scale: ScaleName;
  mode: 'notes' | 'chords';
  colour: string;
  onNoteOn: (midi: number, velocity: number) => void;
  onNoteOff: (midi: number) => void;
  heldPads: ReadonlySet<number>;
}

interface Pad {
  index: number;
  notes: readonly number[];
  label: string;
  aria: string;
  isRoot: boolean;
}

/** Keyboard presses borrow pointer ids no real pointer can have. */
const KEY_POINTER_BASE = -1000;

/** Roots the scale picker spells flat; their pads should read Bbm7, not A#m7. */
const FLAT_ROOTS: ReadonlySet<number> = new Set([1, 3, 6, 8, 10]);
const FLAT_NAMES: Readonly<Record<string, string>> = {
  'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb',
};

function respell(label: string, flat: boolean): string {
  if (!flat) return label;
  const flatName = FLAT_NAMES[label.slice(0, 2)];
  return flatName === undefined ? label : flatName + label.slice(2);
}

/**
 * Row voicings. Octave-stacking (voiceChord's spread) is too coarse here: at
 * four rows it throws the top voice three octaves up and the chord goes thin.
 * Inversions move one note at a time, so every row stays inside about an
 * octave and a half and all sixteen pads sound like the same instrument.
 */
function voiceForRow(notes: readonly number[], row: number, rowCount: number): number[] {
  const out = [...notes];
  if (row <= 0 || out.length === 0) return out;
  if (row < out.length) {
    // Nth inversion: lift the lowest `row` notes an octave.
    for (let i = 0; i < row; i++) {
      const low = out.shift();
      if (low === undefined) break;
      out.push(low + 12);
    }
    return out;
  }
  // Past the available inversions, open the chord: keep the bass, lift the rest.
  const [bass, ...rest] = out;
  if (bass === undefined) return out;
  const extra = row - out.length + 1;
  return [bass, ...rest.map((n) => n + 12 * Math.min(extra, 1))];
}

/**
 * Which scale degrees get columns. The first four are the four chords most
 * popular music is actually built from — I, IV, V, vi in major; i, iv, v, VI in
 * minor — so the grid is useful before you understand it. Remaining degrees
 * fill in only on wider grids.
 */
function degreeColumns(cols: number, degrees: number): number[] {
  const out: number[] = [];
  for (const d of [0, 3, 4, 5, 1, 2, 6]) {
    if (out.length >= cols) break;
    if (d < degrees) out.push(d);
  }
  for (let d = 0; out.length < cols; d++) out.push(d % Math.max(1, degrees));
  return out;
}

function buildPads(
  rows: number,
  cols: number,
  root: number,
  scale: ScaleName,
  mode: 'notes' | 'chords',
): Pad[] {
  const rowCount = Math.max(0, Math.floor(rows));
  const colCount = Math.max(0, Math.floor(cols));
  const count = rowCount * colCount;
  const degrees = SCALES[scale].length;
  const flat = FLAT_ROOTS.has(((root % 12) + 12) % 12);

  if (mode === 'notes') {
    return scaleNotes(root, scale, count).map((midi, index) => {
      const label = respell(noteName(midi), flat);
      return {
        index,
        notes: [midi],
        label,
        aria: `Pad ${index + 1}, note ${label}`,
        isRoot: index % degrees === 0,
      };
    });
  }

  /*
   * Chords used to climb one scale degree per pad, so a 4x4 grid spanned over
   * two octaves and the top row was thin, stacked chords nobody would play.
   * Instead: columns are scale degrees, rows are voicing width. Every pad
   * sounds in the same register, and moving down a column opens the same chord
   * up rather than transposing it into the ceiling.
   */
  const cols_ = degreeColumns(colCount, degrees);
  const pads: Pad[] = [];
  for (let row = 0; row < rowCount; row++) {
    for (let col = 0; col < colCount; col++) {
      const degree = cols_[col] ?? 0;
      const chord = diatonicChord(root, scale, degree);
      const notes = voiceForRow(chord.notes, row, rowCount);
      const base = respell(chord.label, flat);
      // Slash notation when the bass is no longer the root — Cm/Eb, not "Cm
      // that mysteriously sounds different".
      const bass = notes[0];
      const rootPitch = chord.notes[0];
      const label = bass !== undefined && rootPitch !== undefined && bass % 12 !== rootPitch % 12
        ? `${base}/${respell(noteName(bass).replace(/-?\d+$/, ''), flat)}`
        : base;
      const index = row * colCount + col;
      pads.push({
        index,
        notes,
        label,
        aria: `Pad ${index + 1}, chord ${label}, voicing ${row + 1} of ${rowCount}`,
        isRoot: degree === 0,
      });
    }
  }
  return pads;
}

function velocityOf(pressure: number): number {
  return pressure > 0 ? pressure : 1;
}

/**
 * The thumb surface. Every pointer is tracked back to the pad it landed on, so
 * four fingers make a four-note chord and a finger dragged sideways glissandos
 * instead of smearing one stuck note across the grid.
 */
export function PadGrid({
  rows, cols, root, scale, mode, colour, onNoteOn, onNoteOff, heldPads,
}: PadGridProps): JSX.Element {
  const pads = useMemo(() => buildPads(rows, cols, root, scale, mode), [rows, cols, root, scale, mode]);

  /** pointerId -> the pad it is holding, and exactly which notes it started. */
  const holds = useRef(new Map<number, { pad: number; notes: readonly number[] }>());
  /** midi -> how many pointers are holding it, so a shared note is not cut early. */
  const noteRefs = useRef(new Map<number, number>());
  const [pressed, setPressed] = useState<ReadonlySet<number>>(() => new Set<number>());

  const startNotes = useCallback((notes: readonly number[], velocity: number): void => {
    for (const midi of notes) {
      const count = noteRefs.current.get(midi) ?? 0;
      noteRefs.current.set(midi, count + 1);
      if (count === 0) onNoteOn(midi, velocity);
    }
  }, [onNoteOn]);

  const stopNotes = useCallback((notes: readonly number[]): void => {
    for (const midi of notes) {
      const count = noteRefs.current.get(midi) ?? 0;
      if (count > 1) {
        noteRefs.current.set(midi, count - 1);
      } else {
        noteRefs.current.delete(midi);
        onNoteOff(midi);
      }
    }
  }, [onNoteOff]);

  const release = useCallback((pointerId: number): void => {
    const hold = holds.current.get(pointerId);
    if (hold === undefined) return;
    holds.current.delete(pointerId);
    stopNotes(hold.notes);
    setPressed((prev) => {
      for (const other of holds.current.values()) if (other.pad === hold.pad) return prev;
      const next = new Set(prev);
      next.delete(hold.pad);
      return next;
    });
  }, [stopNotes]);

  const press = useCallback((pad: Pad, pointerId: number, velocity: number): void => {
    holds.current.set(pointerId, { pad: pad.index, notes: pad.notes });
    startNotes(pad.notes, velocity);
    setPressed((prev) => {
      if (prev.has(pad.index)) return prev;
      const next = new Set(prev);
      next.add(pad.index);
      return next;
    });
  }, [startNotes]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLButtonElement>, pad: Pad): void => {
    // Stops scroll, pinch-zoom, text selection and the iOS long-press callout.
    e.preventDefault();
    // Touch pointers get implicit capture; without releasing it, pointerenter
    // never fires on the neighbouring pads and sliding is dead.
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    release(e.pointerId);
    press(pad, e.pointerId, velocityOf(e.pressure));
  }, [press, release]);

  const onPointerEnter = useCallback((e: ReactPointerEvent<HTMLButtonElement>, pad: Pad): void => {
    const hold = holds.current.get(e.pointerId);
    if (hold === undefined || hold.pad === pad.index) return;
    release(e.pointerId);
    press(pad, e.pointerId, velocityOf(e.pressure));
  }, [press, release]);

  const onPointerEnd = useCallback((e: ReactPointerEvent<HTMLButtonElement>): void => {
    release(e.pointerId);
  }, [release]);

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLButtonElement>, pad: Pad): void => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (e.repeat) return;
    press(pad, KEY_POINTER_BASE - pad.index, 1);
  }, [press]);

  const onKeyUp = useCallback((e: ReactKeyboardEvent<HTMLButtonElement>, pad: Pad): void => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    release(KEY_POINTER_BASE - pad.index);
  }, [release]);

  // A finger that lifts outside the grid — or off the screen edge — still has
  // to end its note, so the last word on release belongs to the window.
  useEffect(() => {
    const end = (e: PointerEvent): void => { release(e.pointerId); };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [release]);

  const stopRef = useRef(stopNotes);
  useEffect(() => { stopRef.current = stopNotes; }, [stopNotes]);
  useEffect(() => () => {
    const pending = [...holds.current.values()];
    holds.current.clear();
    for (const hold of pending) stopRef.current(hold.notes);
  }, []);

  return (
    <div
      role="group"
      aria-label={mode === 'chords' ? 'Chord pads' : 'Note pads'}
      className="grid w-full"
      style={{
        gridTemplateColumns: `repeat(${Math.max(1, Math.floor(cols))}, minmax(0, 1fr))`,
        gap: '3px',
        padding: '3px',
        background: 'var(--ink)',
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
      }}
      onContextMenu={(e): void => { e.preventDefault(); }}
    >
      {pads.map((pad) => {
        const down = pressed.has(pad.index) || heldPads.has(pad.index);
        return (
          <button
            key={pad.index}
            type="button"
            aria-label={pad.aria}
            aria-pressed={down}
            className="relative flex items-center justify-center"
            style={{
              minHeight: '64px',
              border: 0,
              borderRadius: 0,
              background: down ? colour : 'var(--panel)',
              color: down ? 'var(--bg)' : 'var(--ink)',
              fontWeight: 700,
              fontSize: mode === 'chords' ? '15px' : '13px',
              letterSpacing: '0.14em',
              touchAction: 'none',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              WebkitTouchCallout: 'none',
              WebkitTapHighlightColor: 'transparent',
            }}
            onPointerDown={(e): void => { onPointerDown(e, pad); }}
            onPointerEnter={(e): void => { onPointerEnter(e, pad); }}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onKeyDown={(e): void => { onKeyDown(e, pad); }}
            onKeyUp={(e): void => { onKeyUp(e, pad); }}
          >
            {pad.isRoot ? (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: '6px',
                  left: '6px',
                  width: '9px',
                  height: '9px',
                  background: down ? 'var(--bg)' : 'var(--ink)',
                }}
              />
            ) : null}
            {pad.label}
          </button>
        );
      })}
    </div>
  );
}
