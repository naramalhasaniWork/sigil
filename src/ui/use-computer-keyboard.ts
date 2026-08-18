'use client';

import { useEffect, useRef, useState } from 'react';

export interface KeyboardOptions {
  onNoteOn: (midi: number) => void;
  onNoteOff: (midi: number) => void;
  octave: number;
  enabled: boolean;
}

/**
 * Physical key code -> semitone offset above the base octave.
 * Lower row is the base octave, upper row is one octave above, exactly like a
 * tracker. Codes are used rather than `key` so the layout stays in the same
 * physical place on AZERTY, QWERTZ, Dvorak and friends.
 */
const SEMITONE_BY_CODE = new Map<string, number>([
  ['KeyZ', 0], ['KeyS', 1], ['KeyX', 2], ['KeyD', 3], ['KeyC', 4], ['KeyV', 5],
  ['KeyG', 6], ['KeyB', 7], ['KeyH', 8], ['KeyN', 9], ['KeyJ', 10], ['KeyM', 11],
  ['KeyQ', 12], ['Digit2', 13], ['KeyW', 14], ['Digit3', 15], ['KeyE', 16],
  ['KeyR', 17], ['Digit5', 18], ['KeyT', 19], ['Digit6', 20], ['KeyY', 21],
  ['Digit7', 22], ['KeyU', 23], ['KeyI', 24],
]);

const OCTAVE_DOWN = 'Comma';
const OCTAVE_UP = 'Period';
const MIN_SHIFT = -3;
const MAX_SHIFT = 3;
const MIN_MIDI = 0;
const MAX_MIDI = 127;

function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Plays notes from the computer keyboard. Returns the set of MIDI notes
 * currently sounding so the on-screen keys can light up in sympathy.
 */
export function useComputerKeyboard(opts: KeyboardOptions): { held: ReadonlySet<number> } {
  const [held, setHeld] = useState<ReadonlySet<number>>(() => new Set<number>());

  // Latest callbacks/props without re-binding listeners on every render.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // code -> midi note issued for that key press (so octave shifts mid-hold
  // still release the note that actually started).
  const downCodes = useRef(new Map<string, number>());
  // midi -> how many physical keys are holding it.
  const counts = useRef(new Map<number, number>());
  const shift = useRef(0);

  useEffect(() => {
    const codes = downCodes.current;
    const active = counts.current;

    const press = (midi: number): void => {
      const prev = active.get(midi) ?? 0;
      active.set(midi, prev + 1);
      if (prev > 0) return;
      setHeld((set) => {
        const next = new Set(set);
        next.add(midi);
        return next;
      });
      optsRef.current.onNoteOn(midi);
    };

    const release = (midi: number): void => {
      const prev = active.get(midi) ?? 0;
      if (prev > 1) {
        active.set(midi, prev - 1);
        return;
      }
      active.delete(midi);
      setHeld((set) => {
        const next = new Set(set);
        next.delete(midi);
        return next;
      });
      optsRef.current.onNoteOff(midi);
    };

    const releaseAll = (): void => {
      if (codes.size === 0 && active.size === 0) return;
      codes.clear();
      const sounding = Array.from(active.keys());
      active.clear();
      setHeld((set) => (set.size === 0 ? set : new Set<number>()));
      for (const midi of sounding) optsRef.current.onNoteOff(midi);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      // Auto-repeat would retrigger the note forever while a key is held.
      if (e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!optsRef.current.enabled) return;
      if (isTypingTarget(e.target)) return;

      if (e.code === OCTAVE_DOWN || e.code === OCTAVE_UP) {
        const delta = e.code === OCTAVE_UP ? 1 : -1;
        shift.current = Math.max(MIN_SHIFT, Math.min(MAX_SHIFT, shift.current + delta));
        e.preventDefault();
        return;
      }

      const semitone = SEMITONE_BY_CODE.get(e.code);
      if (semitone === undefined) return;
      e.preventDefault();
      if (codes.has(e.code)) return;

      const midi = 12 * (optsRef.current.octave + shift.current) + semitone;
      if (midi < MIN_MIDI || midi > MAX_MIDI) return;
      codes.set(e.code, midi);
      press(midi);
    };

    // Key-up is handled unconditionally for keys we know are down: a note must
    // never hang because a modifier was pressed or focus moved mid-hold.
    const onKeyUp = (e: KeyboardEvent): void => {
      const midi = codes.get(e.code);
      if (midi === undefined) return;
      codes.delete(e.code);
      release(midi);
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') releaseAll();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseAll);
    window.addEventListener('pagehide', releaseAll);
    document.addEventListener('visibilitychange', onVisibility);

    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
      window.removeEventListener('pagehide', releaseAll);
      document.removeEventListener('visibilitychange', onVisibility);
      releaseAll();
    };
  }, []);

  // Turning the keyboard off must not strand whatever it was already holding.
  useEffect(() => {
    if (opts.enabled) return;
    const codes = downCodes.current;
    const active = counts.current;
    if (codes.size === 0 && active.size === 0) return;
    codes.clear();
    const sounding = Array.from(active.keys());
    active.clear();
    setHeld(new Set<number>());
    for (const midi of sounding) optsRef.current.onNoteOff(midi);
  }, [opts.enabled]);

  return { held };
}
