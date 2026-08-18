'use client';

import { useCallback, useState, type JSX } from 'react';

interface KeysProps {
  octave: number;
  onNoteOn: (midi: number) => void;
  onNoteOff: (midi: number) => void;
}

const SEMITONES = 24;
const BLACK = new Set([1, 3, 6, 8, 10]);

export function Keys({ octave, onNoteOn, onNoteOff }: KeysProps): JSX.Element {
  const [held, setHeld] = useState<ReadonlySet<number>>(new Set());
  const base = 12 * octave;

  const press = useCallback((midi: number): void => {
    setHeld((prev) => new Set(prev).add(midi));
    onNoteOn(midi);
  }, [onNoteOn]);

  const release = useCallback((midi: number): void => {
    setHeld((prev) => {
      const next = new Set(prev);
      next.delete(midi);
      return next;
    });
    onNoteOff(midi);
  }, [onNoteOff]);

  return (
    <div
      className="grid border-t-4"
      style={{ gridTemplateColumns: `repeat(${SEMITONES}, 1fr)`, borderColor: 'var(--ink)' }}
    >
      {Array.from({ length: SEMITONES }, (_, i) => base + i).map((midi) => {
        const isBlack = BLACK.has(midi % 12);
        const isHeld = held.has(midi);
        return (
          <button
            key={midi}
            type="button"
            aria-label={`Note ${midi}`}
            aria-pressed={isHeld}
            className="h-24 border-r-[3px] touch-none"
            style={{
              borderColor: 'var(--ink)',
              background: isHeld ? 'var(--analog)' : isBlack ? '#050505' : '#2A2A28',
            }}
            onPointerDown={(): void => press(midi)}
            onPointerUp={(): void => release(midi)}
            onPointerLeave={(): void => { if (isHeld) release(midi); }}
          />
        );
      })}
    </div>
  );
}
