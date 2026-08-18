'use client';

import { useCallback, useRef, useState } from 'react';
import { scaleNotes, type ScaleName } from '@/dsp/chords';
import type { HandReading } from './use-hand-control';

interface HandPlayOptions {
  enabled: boolean;
  root: number;
  scale: ScaleName;
  /** How many octaves the full vertical travel covers. */
  octaves?: number;
  /** MIDI octave the lowest note sits in. */
  baseOctave?: number;
  onNoteOn: (midi: number, velocity?: number) => void;
  onNoteOff: (midi: number) => void;
}

export interface HandPlay {
  update: (reading: HandReading | null) => void;
  /** The note currently sounding, for display. */
  current: number | null;
  gated: boolean;
}

/** Pinch thresholds. The gap is hysteresis — one threshold chatters on noise. */
const GATE_ON = 0.62;
const GATE_OFF = 0.42;

/**
 * Playing notes with a hand, honestly.
 *
 * Hand tracking runs at 50-100ms latency, which is fatal for triggering: a pad
 * hit that sounds a tenth of a second late feels broken. So this never treats a
 * gesture as a trigger. Instead it is a theremin — pitch follows hand height
 * continuously and quantises to the scale so it is always in tune, while a
 * pinch opens and closes the gate. Latency then shows up as a soft attack,
 * which is musical, rather than as a late hit, which is not.
 *
 * Because it calls the same noteOn/noteOff the keyboard uses, Chords mode
 * applies automatically: pinch once and you get a whole diatonic chord, so
 * progressions are a matter of moving your hand and pinching.
 */
export function useHandPlay({
  enabled, root, scale, octaves = 2, baseOctave = 4,
  onNoteOn, onNoteOff,
}: HandPlayOptions): HandPlay {
  const soundingRef = useRef<number | null>(null);
  const gatedRef = useRef(false);
  const [current, setCurrent] = useState<number | null>(null);
  const [gated, setGated] = useState(false);

  const cfg = useRef({ enabled, root, scale, octaves, baseOctave, onNoteOn, onNoteOff });
  cfg.current = { enabled, root, scale, octaves, baseOctave, onNoteOn, onNoteOff };

  const release = useCallback((): void => {
    const sounding = soundingRef.current;
    if (sounding !== null) {
      cfg.current.onNoteOff(sounding);
      soundingRef.current = null;
      setCurrent(null);
    }
    if (gatedRef.current) {
      gatedRef.current = false;
      setGated(false);
    }
  }, []);

  const update = useCallback((reading: HandReading | null): void => {
    const c = cfg.current;
    if (!c.enabled || reading === null) {
      release();
      return;
    }

    // Height picks a scale degree. Quantising means a wavering hand still lands
    // on a real note instead of drifting between two.
    const steps = scaleNotes(12 * c.baseOctave + c.root, c.scale, 64);
    const span = Math.max(1, Math.round(c.octaves * 7));
    const idx = Math.min(span - 1, Math.max(0, Math.round(reading.y * (span - 1))));
    const target = steps[idx];
    if (target === undefined) return;

    const wantGate = gatedRef.current
      ? reading.pinch > GATE_OFF
      : reading.pinch > GATE_ON;

    if (!wantGate) {
      release();
      return;
    }

    if (!gatedRef.current) {
      gatedRef.current = true;
      setGated(true);
    }

    // Legato: moving to a new note releases the old one first, so the voice
    // count cannot creep upward while a pinch is held.
    if (soundingRef.current !== target) {
      const previous = soundingRef.current;
      if (previous !== null) c.onNoteOff(previous);
      soundingRef.current = target;
      setCurrent(target);
      c.onNoteOn(target, Math.min(1, Math.max(0.25, reading.pinch)));
    }
  }, [release]);

  return { update, current, gated };
}
