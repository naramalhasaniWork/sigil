'use client';
import type { ParamCurve } from '@/audio/types';

import { useCallback, useEffect, useRef, useState } from 'react';
import { collapseNoteOff, expandIncomingNote, type PadChordConfig } from '@/dsp/midi-chords';

/** One learned knob. `min`/`max` are the parameter's real range, not 0..1. */
export interface CcMapping {
  cc: number;
  /** Wire channel, 0-15. Displayed as 1-16. */
  channel: number;
  paramAddress: number;
  min: number;
  max: number;
  label: string;
  /**
   * The parameter's own curve. Without it a CC maps linearly while the on-screen
   * knob maps exponentially, so the same normalised position lands on wildly
   * different values — CC 64 on filter cutoff reads 9081Hz linear versus 616Hz
   * on the knob. Optional so older stored mappings still load.
   */
  curve?: ParamCurve;
  steps?: number;
}

/** Mirrors the knob's mapping in param-row.tsx so a CC and a drag agree. */
function ccToValue(t: number, m: CcMapping): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  if (m.curve === 'stepped' && m.steps && m.steps > 1) {
    const step = Math.round(clamped * (m.steps - 1));
    return m.min + (step / (m.steps - 1)) * (m.max - m.min);
  }
  if ((m.curve === 'exp' || m.curve === 'log') && m.min > 0 && m.max > m.min) {
    return m.min * Math.pow(m.max / m.min, clamped);
  }
  return m.min + (m.max - m.min) * clamped;
}

export interface MidiMapOptions {
  onParam: (address: number, value: number) => void;
  onNoteOn: (midi: number, velocity: number) => void;
  onNoteOff: (midi: number) => void;
  padChords: PadChordConfig;
  enabled: boolean;
}

export interface MidiMapState {
  mappings: CcMapping[];
  learning: number | null;
  /** `range` is optional only so a two-argument call still type-checks; without
   *  it the knob spans 0..1, which is wrong for a cutoff in Hz. */
  startLearn: (paramAddress: number, label: string, range?: { min: number; max: number }) => void;
  cancelLearn: () => void;
  clearMapping: (cc: number) => void;
  devices: string[];
  lastActivity: string | null;
}

/** Pitch bend is mapped through the same table as a knob, at this address. */
export const PITCH_BEND_CC = 128;

const STORAGE_KEY = 'sigil.midiMap.v1';
const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;
const CONTROL_CHANGE = 0xb0;
const PITCH_BEND = 0xe0;
const CLOCK = 0xf8;
const CLOCK_START = 0xfa;
const CLOCK_STOP = 0xfc;
const CLOCKS_PER_BEAT = 24;
const MAX_MIDI = 127;
/** Readout refresh. A knob sweep sends ~100 messages a second; re-rendering on
 *  every one of them would cost notes, and no eye reads that fast anyway. */
const ACTIVITY_MS = 120;

/**
 * Structural view of the Web MIDI API, declared locally so this compiles on lib
 * targets without Web MIDI types and so nothing here needs the API to exist —
 * Safari and iOS have none of it.
 */
interface MidiMessageLike { readonly data: Uint8Array | null }
interface MidiNavigatorLike {
  requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MidiAccessLike>;
}
interface MidiInputLike {
  readonly id: string;
  readonly name: string | null;
  readonly state: string;
  onmidimessage: ((event: MidiMessageLike) => void) | null;
}
interface MidiAccessLike {
  readonly inputs: ReadonlyMap<string, MidiInputLike>;
  onstatechange: ((event: unknown) => void) | null;
}

/** Storage is user-editable and survives version changes, so nothing is trusted. */
function loadMappings(): CcMapping[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const out: CcMapping[] = [];
    for (const entry of parsed as Partial<CcMapping>[]) {
      if (typeof entry?.cc !== 'number' || typeof entry.paramAddress !== 'number') continue;
      out.push({
        cc: entry.cc,
        channel: typeof entry.channel === 'number' ? entry.channel : 0,
        paramAddress: entry.paramAddress,
        min: typeof entry.min === 'number' ? entry.min : 0,
        max: typeof entry.max === 'number' ? entry.max : 1,
        label: typeof entry.label === 'string' ? entry.label : `Param ${entry.paramAddress}`,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function saveMappings(next: readonly CcMapping[]): void {
  // A full or blocked store must never take the controller down with it.
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

/**
 * Plays and maps an attached MIDI controller.
 *
 * Notes run through the pad-chord expander, and the notes each held key opened
 * are remembered, so changing the chord settings mid-hold still releases the
 * right voices instead of leaving them ringing. Knobs are learned rather than
 * assumed — press Learn, move the knob — and the pairing survives a reload.
 */
export function useMidiMap(opts: MidiMapOptions): MidiMapState {
  const [mappings, setMappings] = useState<CcMapping[]>([]);
  const [learning, setLearning] = useState<number | null>(null);
  const [devices, setDevices] = useState<string[]>([]);
  const [lastActivity, setLastActivity] = useState<string | null>(null);

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const mappingsRef = useRef<readonly CcMapping[]>(mappings);
  mappingsRef.current = mappings;

  type Pending = {
    address: number; label: string; min: number; max: number;
    curve?: ParamCurve; steps?: number;
  };
  const pendingLearn = useRef<Pending | null>(null);
  const activity = useRef<string | null>(null);
  /** Notes opened by each held key, so note-off releases exactly those. */
  const sounding = useRef(new Map<number, number[]>());
  /**
   * How many held keys are currently sounding each pitch. Adjacent diatonic
   * chords share two of three tones, so releasing one key must not silence a
   * pitch another key is still holding — VoiceManager.noteOff frees every slot
   * at that pitch, so the guard has to live here.
   */
  const noteRefs = useRef(new Map<number, number>());
  const clockCount = useRef(0);
  const clockAt = useRef(0);

  useEffect(() => { setMappings(loadMappings()); }, []);

  const commit = useCallback((next: CcMapping[]): void => {
    setMappings(next);
    mappingsRef.current = next;
    saveMappings(next);
  }, []);

  const startLearn = useCallback(
    (paramAddress: number, label: string, range?: { min: number; max: number }): void => {
      pendingLearn.current = {
        address: paramAddress, label, min: range?.min ?? 0, max: range?.max ?? 1,
      };
      setLearning(paramAddress);
    },
    [],
  );

  const cancelLearn = useCallback((): void => {
    pendingLearn.current = null;
    setLearning(null);
  }, []);

  const clearMapping = useCallback((cc: number): void => {
    commit(mappingsRef.current.filter((m) => m.cc !== cc));
  }, [commit]);

  // The readout is pushed into React on a timer rather than per message.
  useEffect(() => {
    if (!opts.enabled) return;
    const id = window.setInterval((): void => {
      setLastActivity((prev) => (prev === activity.current ? prev : activity.current));
    }, ACTIVITY_MS);
    return (): void => window.clearInterval(id);
  }, [opts.enabled]);

  useEffect(() => {
    if (!opts.enabled || typeof navigator === 'undefined') return;
    const nav = navigator as unknown as MidiNavigatorLike;
    const request = nav.requestMIDIAccess;
    if (typeof request !== 'function') return;

    let cancelled = false;
    let access: MidiAccessLike | null = null;
    const attached: MidiInputLike[] = [];

    const control = (channel: number, cc: number, value: number, tag: string): void => {
      activity.current = `CH${channel + 1} ${tag} ${value}`;
      const learn = pendingLearn.current;
      if (learn !== null) {
        pendingLearn.current = null;
        setLearning(null);
        const kept = mappingsRef.current.filter(
          (m) => m.cc !== cc && m.paramAddress !== learn.address,
        );
        commit([...kept, {
          cc, channel, paramAddress: learn.address,
          min: learn.min, max: learn.max, label: learn.label,
          curve: learn.curve, steps: learn.steps,
        }]);
        return;
      }
      // Same channel wins; a controller that was re-banked still finds its CC.
      const list = mappingsRef.current;
      const exact = list.find((m) => m.cc === cc && m.channel === channel);
      const found = exact ?? list.find((m) => m.cc === cc);
      if (found === undefined) return;
      optsRef.current.onParam(found.paramAddress, ccToValue(value / MAX_MIDI, found));
    };

    const noteOn = (channel: number, note: number, raw: number): void => {
      activity.current = `CH${channel + 1} NOTE ${note} v${raw}`;
      const velocity = raw / MAX_MIDI;
      const notes = expandIncomingNote(note, velocity, optsRef.current.padChords);
      sounding.current.set(note, notes);
      for (const n of notes) {
        const refs = noteRefs.current.get(n) ?? 0;
        noteRefs.current.set(n, refs + 1);
        if (refs === 0) optsRef.current.onNoteOn(n, velocity);
      }
    };

    const noteOff = (channel: number, note: number): void => {
      activity.current = `CH${channel + 1} OFF ${note}`;
      const held = sounding.current.get(note);
      const notes = held ?? collapseNoteOff(note, optsRef.current.padChords);
      sounding.current.delete(note);
      for (const n of notes) {
        const refs = (noteRefs.current.get(n) ?? 1) - 1;
        if (refs <= 0) {
          noteRefs.current.delete(n);
          optsRef.current.onNoteOff(n);
        } else {
          noteRefs.current.set(n, refs);
        }
      }
    };

    const realtime = (status: number): void => {
      if (status === CLOCK_START || status === CLOCK_STOP) {
        clockCount.current = 0;
        clockAt.current = 0;
        activity.current = status === CLOCK_START ? 'CLOCK START' : 'CLOCK STOP';
        return;
      }
      // A beat is 24 clocks; timing whole beats keeps the estimate steady.
      if (status !== CLOCK) return;
      clockCount.current += 1;
      if (clockCount.current < CLOCKS_PER_BEAT) return;
      clockCount.current = 0;
      const now = performance.now();
      const last = clockAt.current;
      clockAt.current = now;
      if (last === 0) return;
      const bpm = 60000 / (now - last);
      if (bpm > 20 && bpm < 400) activity.current = `CLOCK ${bpm.toFixed(1)} BPM`;
    };

    const onMessage = (event: MidiMessageLike): void => {
      const data = event.data;
      if (data === null || data.length === 0) return;
      const status = data[0] as number;
      if (status >= CLOCK) { realtime(status); return; }
      if (data.length < 3) return;
      const type = status & 0xf0;
      const channel = status & 0x0f;
      const a = data[1] as number;
      const b = data[2] as number;
      if (a > MAX_MIDI) return;
      if (type === NOTE_ON && b > 0) noteOn(channel, a, b);
      else if (type === NOTE_ON || type === NOTE_OFF) noteOff(channel, a);
      else if (type === CONTROL_CHANGE) control(channel, a, b, `CC${a}`);
      // 14-bit bend folded onto the 0-127 knob path so it can be learned too.
      else if (type === PITCH_BEND) control(channel, PITCH_BEND_CC, ((b << 7) | a) >> 7, 'BEND');
    };

    const detach = (): void => {
      for (const input of attached) input.onmidimessage = null;
      attached.length = 0;
    };

    const attach = (current: MidiAccessLike): void => {
      detach();
      const names: string[] = [];
      for (const input of current.inputs.values()) {
        if (input.state === 'disconnected') continue;
        input.onmidimessage = onMessage;
        attached.push(input);
        names.push(input.name ?? 'MIDI device');
      }
      setDevices(names);
    };

    let pending: Promise<MidiAccessLike> | null = null;
    try { pending = request.call(navigator, { sysex: false }); } catch { pending = null; }

    pending
      ?.then((granted): void => {
        if (cancelled) return;
        access = granted;
        granted.onstatechange = (): void => { if (!cancelled) attach(granted); };
        attach(granted);
      })
      .catch((): void => { if (!cancelled) setDevices([]); });

    return (): void => {
      cancelled = true;
      detach();
      if (access !== null) access.onstatechange = null;
      // Anything still held would ring forever once the handler is gone.
      for (const notes of sounding.current.values()) {
        for (const n of notes) optsRef.current.onNoteOff(n);
      }
      sounding.current.clear();
      setDevices([]);
      activity.current = null;
      setLastActivity(null);
    };
  }, [opts.enabled, commit]);

  return { mappings, learning, startLearn, cancelLearn, clearMapping, devices, lastActivity };
}
