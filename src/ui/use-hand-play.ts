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
  /** Octave offset the hand's horizontal position has selected. */
  register: number;
}

/** Pinch thresholds. The gap is hysteresis — one threshold chatters on noise. */
const GATE_ON = 0.62;
const GATE_OFF = 0.42;

/**
 * How far past the midpoint the hand must travel before the note changes. At 0
 * the note flips the instant you cross a boundary, so a hand resting near one
 * machine-guns between two pitches. 0.18 means you must cover ~68% of the way
 * to the neighbour, which is what makes a held note feel held.
 */
const PITCH_DEADBAND = 0.18;

/** Minimum time on a note. Stops a fast sweep firing a note per frame. */
const MIN_DWELL_MS = 90;

/**
 * Usable vertical band. Mapping the full frame height meant the lowest and
 * highest notes sat at the very edges of the camera's view, which is an
 * uncomfortable stretch — the range you can actually hold your hand in is the
 * middle. Everything outside simply clamps.
 */
const Y_LOW = 0.16;
const Y_HIGH = 0.86;

/**
 * Horizontal zones selecting register. Y picks the note, X picks which octave
 * it lands in, so a wide range is reachable without reaching. Hysteresis at the
 * zone edges stops a drifting hand jumping octaves mid-phrase.
 */
const REGISTERS = [-1, 0, 1] as const;
const REGISTER_HYSTERESIS = 0.06;

/** Which register zone the hand has committed to. */
export function registerZone(x: number, held: number | null): number {
  const width = 1 / REGISTERS.length;
  const raw = Math.min(REGISTERS.length - 1, Math.max(0, Math.floor(x / width)));
  if (held === null || raw === held) return raw;
  // Require clearing the boundary by the hysteresis margin before switching.
  const boundary = (raw > held ? raw : held) * width;
  return Math.abs(x - boundary) > REGISTER_HYSTERESIS ? raw : held;
}

/**
 * Which note the hand has committed to, given where it is and what is already
 * sounding. Pure so the behaviour that decides whether playing feels smooth or
 * chattery is actually testable.
 *
 * - Nothing sounding: take the nearest note.
 * - Inside the deadband: keep the current note, however much the hand wobbles.
 * - Past it: move ONE step toward the hand, so a fast sweep glides through the
 *   scale rather than leaping and skipping notes.
 */
export function nextPitchIndex(
  position: number,
  held: number | null,
  span: number,
  deadband: number = PITCH_DEADBAND,
): number {
  const clamp = (v: number): number => Math.min(span - 1, Math.max(0, v));
  if (held === null) return clamp(Math.round(position));
  if (Math.abs(position - held) > 0.5 + deadband) {
    return clamp(held + Math.sign(position - held));
  }
  return clamp(held);
}

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
  /** Continuous index of the sounding note, for deadband comparisons. */
  const indexRef = useRef<number | null>(null);
  const changedAt = useRef(0);
  const zoneRef = useRef<number | null>(null);
  const [register, setRegister] = useState(0);
  const [current, setCurrent] = useState<number | null>(null);
  const [gated, setGated] = useState(false);

  const cfg = useRef({ enabled, root, scale, octaves, baseOctave, onNoteOn, onNoteOff });
  cfg.current = { enabled, root, scale, octaves, baseOctave, onNoteOn, onNoteOff };

  const release = useCallback((): void => {
    const sounding = soundingRef.current;
    if (sounding !== null) {
      cfg.current.onNoteOff(sounding);
      soundingRef.current = null;
      indexRef.current = null;
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

    /*
     * Height picks a scale degree, but the note only changes once the hand has
     * clearly committed. Rounding the raw position meant a hand hovering on a
     * boundary retriggered constantly — the "cutting off" you hear.
     */
    // X chooses the register, so range does not depend on vertical reach.
    const zone = registerZone(reading.x, zoneRef.current);
    if (zone !== zoneRef.current) {
      zoneRef.current = zone;
      setRegister(REGISTERS[zone] ?? 0);
    }
    const octaveShift = REGISTERS[zone] ?? 0;

    const steps = scaleNotes(12 * (c.baseOctave + octaveShift) + c.root, c.scale, 64);
    const span = Math.max(1, Math.round(c.octaves * 7));

    // Compress the usable band so the top and bottom notes are reachable.
    const norm = Math.min(1, Math.max(0, (reading.y - Y_LOW) / (Y_HIGH - Y_LOW)));
    const position = norm * (span - 1);

    const idx = nextPitchIndex(position, indexRef.current, span);
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

    if (soundingRef.current !== target) {
      const now = Date.now();
      if (soundingRef.current !== null && now - changedAt.current < MIN_DWELL_MS) return;
      changedAt.current = now;

      /*
       * Overlap, not gap: the new note starts BEFORE the old one is released,
       * so the outgoing release tail covers the transition and the line never
       * falls silent. In Chords mode the input layer reference-counts pitches,
       * so tones shared between two chords are never interrupted at all —
       * exactly the pad-like movement this is after.
       */
      const previous = soundingRef.current;
      soundingRef.current = target;
      indexRef.current = idx;
      setCurrent(target);
      c.onNoteOn(target, Math.min(1, Math.max(0.25, reading.pinch)));
      if (previous !== null) c.onNoteOff(previous);
    }
  }, [release]);

  return { update, current, gated, register };
}
