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

function buildPads(
  rows: number,
  cols: number,
  root: number,
  scale: ScaleName,
  mode: 'notes' | 'chords',
): Pad[] {
  const count = Math.max(0, Math.floor(rows) * Math.floor(cols));
  const degrees = SCALES[scale].length;
  if (mode === 'notes') {
    return scaleNotes(root, scale, count).map((midi, index) => ({
      index,
      notes: [midi],
      label: noteName(midi),
      aria: `Pad ${index + 1}, note ${noteName(midi)}`,
      isRoot: index % degrees === 0,
    }));
  }
  const pads: Pad[] = [];
  for (let index = 0; index < count; index++) {
    const chord = diatonicChord(root, scale, index);
    pads.push({
      index,
      notes: chord.notes,
      label: chord.label,
      aria: `Pad ${index + 1}, chord ${chord.label}`,
      isRoot: index % degrees === 0,
    });
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
              textTransform: 'uppercase',
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
