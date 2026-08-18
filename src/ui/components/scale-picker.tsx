'use client';

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { SCALES, type ScaleName } from '@/dsp/chords';

export type PadMode = 'notes' | 'chords';

/** Pitch classes 0–11 with conventional flat spellings for the black keys. */
export const NOTE_NAMES = [
  'C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B',
] as const;

const SCALE_LABELS: Readonly<Record<ScaleName, string>> = {
  major: 'Major',
  minor: 'Minor',
  dorian: 'Dorian',
  phrygian: 'Phrygian',
  lydian: 'Lydian',
  mixolydian: 'Mixolydian',
  harmonicMinor: 'Harmonic minor',
  pentatonicMinor: 'Pentatonic minor',
  wholeTone: 'Whole tone',
  chromatic: 'Chromatic',
};

const STORAGE_KEY = 'sigil.scale.v1';

interface ScaleState {
  /** Root pitch class, 0 (C) to 11 (B). */
  root: number;
  scale: ScaleName;
  mode: PadMode;
}

export interface ScaleStateHandle extends ScaleState {
  setRoot: (pc: number) => void;
  setScale: (scale: ScaleName) => void;
  setMode: (mode: PadMode) => void;
}

const DEFAULTS: ScaleState = { root: 0, scale: 'minor', mode: 'chords' };

function parseStored(raw: string | null): ScaleState | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { root, scale, mode } = value as Record<string, unknown>;
    if (typeof root !== 'number' || !Number.isInteger(root) || root < 0 || root > 11) return null;
    if (typeof scale !== 'string' || !(scale in SCALES)) return null;
    if (mode !== 'notes' && mode !== 'chords') return null;
    return { root, scale: scale as ScaleName, mode };
  } catch {
    return null;
  }
}

/**
 * Root, scale and pad mode, persisted so the instrument reopens in the key
 * you were playing in. Reads storage after mount to keep SSR markup stable.
 */
export function useScaleState(): ScaleStateHandle {
  const [state, setState] = useState<ScaleState>(DEFAULTS);
  const hydrated = useRef(false);

  useEffect(() => {
    try {
      const stored = parseStored(window.localStorage.getItem(STORAGE_KEY));
      if (stored !== null) setState(stored);
    } catch { /* storage unavailable — play on with defaults */ }
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch { /* storage unavailable — the session still works */ }
  }, [state]);

  const setRoot = useCallback((pc: number): void => {
    setState((s) => ({ ...s, root: Math.min(11, Math.max(0, Math.round(pc))) }));
  }, []);
  const setScale = useCallback((scale: ScaleName): void => {
    setState((s) => ({ ...s, scale }));
  }, []);
  const setMode = useCallback((mode: PadMode): void => {
    setState((s) => ({ ...s, mode }));
  }, []);

  return { ...state, setRoot, setScale, setMode };
}

interface ScalePickerProps {
  state: ScaleStateHandle;
  colour: string;
}

/** One footer row: pick a root, pick a scale, choose notes or chords on the pads. */
export function ScalePicker({ state, colour }: ScalePickerProps): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Root, scale and pad mode"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5 border-b-[3px]"
      style={{ borderColor: '#2A2A28' }}
    >
      <div role="group" aria-label="Root note" className="flex flex-wrap gap-1">
        {NOTE_NAMES.map((name, pc) => {
          const active = state.root === pc;
          return (
            <button
              key={name}
              type="button"
              aria-pressed={active}
              aria-label={`Root ${name}`}
              onClick={(): void => state.setRoot(pc)}
              className="min-w-11 min-h-11 border-[3px] text-[11px] font-bold"
              style={{
                borderColor: active ? colour : 'var(--muted)',
                background: active ? colour : 'transparent',
                color: active ? 'var(--bg)' : 'var(--ink)',
              }}
            >
              {name}
            </button>
          );
        })}
      </div>

      <label className="flex items-center gap-1.5">
        <span className="label">Scale</span>
        <select
          value={state.scale}
          onChange={(e): void => state.setScale(e.target.value as ScaleName)}
          className="min-h-11 border-[3px] px-2 text-[11px] font-bold"
          style={{ borderColor: 'var(--ink)', background: 'var(--bg)', color: 'var(--ink)' }}
        >
          {(Object.keys(SCALES) as ScaleName[]).map((s) => (
            <option key={s} value={s}>{SCALE_LABELS[s]}</option>
          ))}
        </select>
      </label>

      <div role="group" aria-label="Pad mode" className="flex gap-1">
        {(['notes', 'chords'] as const).map((m) => {
          const active = state.mode === m;
          return (
            <button
              key={m}
              type="button"
              aria-pressed={active}
              onClick={(): void => state.setMode(m)}
              className="min-h-11 border-[3px] px-3 text-[10px] font-bold uppercase tracking-[0.16em]"
              style={{
                borderColor: active ? colour : 'var(--muted)',
                background: active ? colour : 'transparent',
                color: active ? 'var(--bg)' : 'var(--ink)',
              }}
            >
              {m}
            </button>
          );
        })}
      </div>
    </div>
  );
}
