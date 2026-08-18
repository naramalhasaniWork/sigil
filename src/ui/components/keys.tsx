'use client';

import { useCallback, useMemo, type JSX } from 'react';
import { SCALES, noteName, type ScaleName } from '@/dsp/chords';

interface KeysProps {
  octave: number;
  /** Driven by the instrument, so computer-keyboard and MIDI notes light up too. */
  held: ReadonlySet<number>;
  /** Pitch class 0–11 of the chosen root. With `scale`, marks in-scale keys. */
  scaleRoot?: number;
  /** The active scale. Omit both scale props and the keys render as before. */
  scale?: ScaleName;
  onNoteOn: (midi: number) => void;
  onNoteOff: (midi: number) => void;
}

const SEMITONES = 24;
const BLACK = new Set([1, 3, 6, 8, 10]);

export function Keys({
  octave, held, scaleRoot, scale, onNoteOn, onNoteOff,
}: KeysProps): JSX.Element {
  const base = 12 * octave;

  const press = useCallback((midi: number): void => { onNoteOn(midi); }, [onNoteOn]);
  const release = useCallback((midi: number): void => { onNoteOff(midi); }, [onNoteOff]);

  // Pitch classes that belong to the active scale, or null when none is set.
  const inScale = useMemo(() => {
    if (scale === undefined || scaleRoot === undefined) return null;
    const set = new Set<number>();
    for (const step of SCALES[scale]) set.add((((scaleRoot + step) % 12) + 12) % 12);
    return set;
  }, [scale, scaleRoot]);

  return (
    <div
      className="grid border-t-4"
      style={{ gridTemplateColumns: `repeat(${SEMITONES}, 1fr)`, borderColor: 'var(--ink)' }}
    >
      {Array.from({ length: SEMITONES }, (_, i) => base + i).map((midi) => {
        const isBlack = BLACK.has(midi % 12);
        const isHeld = held.has(midi);
        const isC = midi % 12 === 0;
        const marked = inScale !== null && inScale.has(midi % 12);
        return (
          <button
            key={midi}
            type="button"
            aria-label={`Note ${noteName(midi)}`}
            aria-pressed={isHeld}
            className="relative h-24 border-r-[3px] touch-none"
            style={{
              borderColor: 'var(--ink)',
              background: isHeld ? 'var(--analog)' : isBlack ? '#050505' : '#2A2A28',
            }}
            onPointerDown={(): void => press(midi)}
            onPointerUp={(): void => release(midi)}
            onPointerLeave={(): void => { if (isHeld) release(midi); }}
          >
            {marked ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-1.5 left-1/2 -translate-x-1/2 w-[5px] h-[5px]"
                style={{ background: isHeld ? 'var(--bg)' : 'var(--muted)' }}
              />
            ) : null}
            {isC ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-1 inset-x-0 text-center text-[9px] font-bold tracking-[0.08em]"
                style={{ color: isHeld ? 'var(--bg)' : 'var(--ink)' }}
              >
                {`C${midi / 12 - 1}`}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
