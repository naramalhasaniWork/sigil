'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  PPQ, addNote, barBeatOfTick, beatsInWindow, clearPattern, createPattern, msPerTick,
  patternTicks, quantiseTick, removePass, scheduleWindow, type Pattern, type SeqNote,
} from '@/dsp/sequencer';

/** How often the scheduler wakes, and how far ahead each wake commits. */
const WAKE_MS = 25;
const LOOKAHEAD_MS = 100;
const MIN_BPM = 20;
const MAX_BPM = 300;
const MAX_BARS = 16;
const CLICK_MS = 20;
const CLICK_DOWN = 96;
const CLICK_BEAT = 91;

export interface SequencerOptions {
  onNoteOn: (midi: number, velocity: number) => void;
  onNoteOff: (midi: number) => void;
  /** Injected so the transport can be driven by a fake clock. */
  getCurrentTimeMs: () => number;
}

export interface Sequencer {
  pattern: Pattern;
  bpm: number; setBpm: (v: number) => void;
  isPlaying: boolean; isRecording: boolean;
  currentTick: number; currentBar: number; currentBeat: number;
  play: () => void; stop: () => void; toggleRecord: () => void;
  /** Records only — your live path already sounded the note you just played. */
  noteDown: (midi: number, velocity: number) => void;
  noteUp: (midi: number) => void;
  undoPass: () => void; clear: () => void;
  setLengthBars: (n: number) => void;
  setQuantise: (division: number, strength: number) => void;
  quantiseDivision: number; quantiseStrength: number;
  metronome: boolean; setMetronome: (v: boolean) => void;
}

interface OpenNote { midi: number; velocity: number; startTick: number; pass: number }

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** State the scheduler must read synchronously, mirrored into a ref. */
function useMirror<T>(initial: T): [T, RefObject<T>, (v: T) => void] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((v: T): void => { ref.current = v; setValue(v); }, []);
  return [value, ref, set];
}

/**
 * The looper. Position is derived from wall-clock arithmetic every time it is
 * asked for, never by incrementing a counter per tick — counters accumulate
 * error and the loop audibly wanders.
 *
 * Scheduling is lookahead: every WAKE_MS we resolve everything falling in the
 * next LOOKAHEAD_MS and commit it. The engine host's noteOn takes no "at time
 * t" argument (it posts straight to the worklet), so committing means arming a
 * timer for an absolute instant computed from the clock. That is not the same
 * as chaining setTimeout per note: each timer is anchored independently to an
 * exact time, so error never accumulates from one note to the next.
 */
export function useSequencer(opts: SequencerOptions): Sequencer {
  const optsRef = useRef(opts);
  useEffect(() => { optsRef.current = opts; });

  const [pattern, patternRef, setPatternValue] = useMirror<Pattern>(createPattern(2));
  const [bpm, bpmRef, setBpmValue] = useMirror(96);
  const [isPlaying, playingRef, setPlaying] = useMirror(false);
  const [isRecording, recordingRef, setRecordingValue] = useMirror(false);
  const [metronome, metronomeRef, setMetronome] = useMirror(false);
  const [quant, quantRef, setQuantValue] = useMirror({ division: PPQ / 4, strength: 0 });
  const [currentTick, setCurrentTick] = useState(0);

  /** Wall-clock time at which absolute tick 0 happened. */
  const originRef = useRef(0);
  /** Absolute tick committed through, exclusive. */
  const cursorRef = useRef(0);
  const lapRef = useRef(0);
  const timersRef = useRef<Set<number>>(new Set());
  /** midi -> how many scheduled notes are currently holding it down. */
  const soundingRef = useRef<Map<number, number>>(new Map());
  const openRef = useRef<Map<number, OpenNote>>(new Map());
  const passRef = useRef(0);
  const passSeqRef = useRef(0);
  const idRef = useRef(0);

  const commitPattern = useCallback((fn: (p: Pattern) => Pattern): void => {
    const next = fn(patternRef.current);
    if (next !== patternRef.current) setPatternValue(next);
  }, [patternRef, setPatternValue]);

  // Refcounted per pitch: a note retriggered before its own release must not be
  // cut short by the release belonging to the earlier one.
  const emitOn = useCallback((midi: number, velocity: number): void => {
    soundingRef.current.set(midi, (soundingRef.current.get(midi) ?? 0) + 1);
    optsRef.current.onNoteOn(midi, velocity);
  }, []);

  const emitOff = useCallback((midi: number): void => {
    const left = (soundingRef.current.get(midi) ?? 1) - 1;
    if (left > 0) { soundingRef.current.set(midi, left); return; }
    soundingRef.current.delete(midi);
    optsRef.current.onNoteOff(midi);
  }, []);

  const cancelTimers = useCallback((): void => {
    for (const id of timersRef.current) window.clearTimeout(id);
    timersRef.current.clear();
  }, []);

  const releaseAll = useCallback((): void => {
    for (const midi of soundingRef.current.keys()) optsRef.current.onNoteOff(midi);
    soundingRef.current.clear();
  }, []);

  const armAt = useCallback((timeMs: number, fire: () => void): void => {
    const id = window.setTimeout(() => {
      timersRef.current.delete(id);
      fire();
    }, Math.max(0, timeMs - optsRef.current.getCurrentTimeMs()));
    timersRef.current.add(id);
  }, []);

  const absoluteTick = useCallback((): number => {
    const perTick = msPerTick(bpmRef.current, patternRef.current.ppq);
    if (perTick <= 0) return 0;
    return (optsRef.current.getCurrentTimeMs() - originRef.current) / perTick;
  }, [bpmRef, patternRef]);

  const positionTick = useCallback((): number => {
    const total = patternTicks(patternRef.current);
    return total <= 0 ? 0 : Math.round(absoluteTick()) % total;
  }, [absoluteTick, patternRef]);

  const commitOpen = useCallback((open: OpenNote, endTick: number): void => {
    const total = patternTicks(patternRef.current);
    const dur = endTick - open.startTick;
    const q = quantRef.current;
    commitPattern((p) => addNote(p, {
      id: `n${idRef.current++}`,
      midi: open.midi,
      velocity: open.velocity,
      startTick: quantiseTick(open.startTick, q.division, q.strength, total),
      durationTicks: clamp(Math.round(dur <= 0 ? dur + total : dur), 1, total),
      pass: open.pass,
    } satisfies SeqNote));
  }, [commitPattern, patternRef, quantRef]);

  /** Anything still held gets written down at `endTick` rather than lost. */
  const flushOpen = useCallback((endTick: number): void => {
    if (openRef.current.size === 0) return;
    const held = [...openRef.current.values()];
    openRef.current.clear();
    for (const open of held) commitOpen(open, endTick);
  }, [commitOpen]);

  // ---- the scheduler -----------------------------------------------------
  const wake = useCallback((): void => {
    const p = patternRef.current;
    const total = patternTicks(p);
    const perTick = msPerTick(bpmRef.current, p.ppq);
    if (total <= 0 || perTick <= 0) return;

    const nowTick = absoluteTick();
    const lap = Math.floor(nowTick / total);
    if (lap > lapRef.current) {
      // A note held across the loop point ends *at* the loop point. It is never
      // left hanging, and never re-opened — holding a key must not smear a
      // fresh copy of the same note across every pass.
      flushOpen(total);
      if (recordingRef.current) passRef.current = ++passSeqRef.current;
    }
    lapRef.current = lap;

    // Background tabs throttle timers hard. On resume, jump the cursor to now
    // rather than machine-gunning everything we slept through.
    if (cursorRef.current < nowTick) cursorRef.current = nowTick;
    const from = cursorRef.current;
    const to = nowTick + LOOKAHEAD_MS / perTick;

    if (to > from) {
      for (const { note, absTick } of scheduleWindow(p, from, to)) {
        const onAt = originRef.current + absTick * perTick;
        armAt(onAt, () => emitOn(note.midi, note.velocity));
        armAt(onAt + Math.max(1, note.durationTicks) * perTick, () => emitOff(note.midi));
      }
      if (metronomeRef.current) {
        for (const { absTick, downbeat } of beatsInWindow(p, from, to)) {
          const midi = downbeat ? CLICK_DOWN : CLICK_BEAT;
          const onAt = originRef.current + absTick * perTick;
          armAt(onAt, () => emitOn(midi, downbeat ? 0.5 : 0.28));
          armAt(onAt + CLICK_MS, () => emitOff(midi));
        }
      }
      cursorRef.current = to;
    }

    const tick = Math.floor(((nowTick % total) + total) % total);
    setCurrentTick((prev) => (prev === tick ? prev : tick));
  }, [absoluteTick, armAt, bpmRef, emitOff, emitOn, flushOpen, metronomeRef,
    patternRef, recordingRef]);

  useEffect(() => {
    if (!isPlaying) return;
    wake();
    const id = window.setInterval(wake, WAKE_MS);
    return (): void => window.clearInterval(id);
  }, [isPlaying, wake]);

  // Never leave the synth holding notes after this component goes away.
  useEffect(() => (): void => {
    for (const id of timersRef.current) window.clearTimeout(id);
    timersRef.current.clear();
    for (const midi of soundingRef.current.keys()) optsRef.current.onNoteOff(midi);
    soundingRef.current.clear();
  }, []);

  // ---- transport ---------------------------------------------------------
  const play = useCallback((): void => {
    if (playingRef.current) return;
    originRef.current = optsRef.current.getCurrentTimeMs();
    cursorRef.current = 0;
    lapRef.current = 0;
    setCurrentTick(0);
    setPlaying(true);
  }, [playingRef, setPlaying]);

  const stop = useCallback((): void => {
    if (playingRef.current) flushOpen(positionTick());
    openRef.current.clear();
    cancelTimers();
    releaseAll();
    setRecordingValue(false);
    setPlaying(false);
    setCurrentTick(0);
  }, [cancelTimers, flushOpen, playingRef, positionTick, releaseAll, setPlaying,
    setRecordingValue]);

  const toggleRecord = useCallback((): void => {
    if (recordingRef.current) {
      setRecordingValue(false);
      flushOpen(positionTick());
      return;
    }
    if (!playingRef.current) play();
    passRef.current = ++passSeqRef.current;
    setRecordingValue(true);
  }, [flushOpen, play, playingRef, positionTick, recordingRef, setRecordingValue]);

  const setBpm = useCallback((v: number): void => {
    const next = clamp(v, MIN_BPM, MAX_BPM);
    // Hold the playhead where it is and change the rate underneath it.
    if (playingRef.current) {
      const at = absoluteTick();
      originRef.current =
        optsRef.current.getCurrentTimeMs() - at * msPerTick(next, patternRef.current.ppq);
    }
    setBpmValue(next);
  }, [absoluteTick, patternRef, playingRef, setBpmValue]);

  // ---- recording and editing ---------------------------------------------
  const noteDown = useCallback((midi: number, velocity: number): void => {
    if (!playingRef.current || !recordingRef.current) return;
    openRef.current.set(midi, {
      midi, velocity, startTick: positionTick(), pass: passRef.current,
    });
  }, [playingRef, positionTick, recordingRef]);

  const noteUp = useCallback((midi: number): void => {
    const open = openRef.current.get(midi);
    if (!open) return;
    openRef.current.delete(midi);
    commitOpen(open, positionTick());
  }, [commitOpen, positionTick]);

  const undoPass = useCallback((): void => {
    commitPattern((p) => {
      let last = -1;
      for (const n of p.notes) if (n.pass > last) last = n.pass;
      return last < 0 ? p : removePass(p, last);
    });
  }, [commitPattern]);

  const clear = useCallback((): void => {
    openRef.current.clear();
    cancelTimers();
    releaseAll();
    commitPattern(clearPattern);
  }, [cancelTimers, commitPattern, releaseAll]);

  const setLengthBars = useCallback((n: number): void => {
    commitPattern((p) => {
      const lengthBars = clamp(Math.floor(n), 1, MAX_BARS);
      if (lengthBars === p.lengthBars) return p;
      const total = patternTicks({ ...p, lengthBars });
      // Notes past the new loop end are dropped, not folded back in: silently
      // re-homing them somewhere else in the bar would be worse than losing them.
      return { ...p, lengthBars, notes: p.notes.filter((x) => x.startTick < total) };
    });
    lapRef.current = Math.floor(absoluteTick() / patternTicks(patternRef.current));
  }, [absoluteTick, commitPattern, patternRef]);

  const setQuantise = useCallback((division: number, strength: number): void => {
    setQuantValue({
      division: Math.max(1, Math.round(division)),
      strength: clamp(strength, 0, 1),
    });
  }, [setQuantValue]);

  const { bar, beat } = barBeatOfTick(pattern, currentTick);

  return {
    pattern, bpm, setBpm,
    isPlaying, isRecording, currentTick, currentBar: bar, currentBeat: beat,
    play, stop, toggleRecord, noteDown, noteUp, undoPass, clear,
    setLengthBars, setQuantise,
    quantiseDivision: quant.division, quantiseStrength: quant.strength,
    metronome, setMetronome,
  };
}
