'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EngineDescriptor } from '@/audio/types';
import { EngineHost } from '@/audio/engine-host';
import { bouncePatch } from '@/audio/bounce';
import { KO2_SAMPLE_RATE } from '@/audio/wav';
import { ENGINES, DEFAULT_ENGINE_ID } from '@/dsp/registry';
import { PRESETS, presetToValues } from '@/dsp/presets';
import {
  makeRng, variations as makeVariations, breed, normalise, denormalise, type Patch,
} from '@/dsp/mutation';

export type Layout = 'keys' | 'pads';

export interface HuntVariation {
  id: string;
  name: string;
  patch: Patch;
  kept: boolean;
}

function defaultsFor(d: EngineDescriptor): Float32Array {
  const v = new Float32Array(d.params.length);
  for (let i = 0; i < d.params.length; i++) v[i] = d.params[i]?.default ?? 0;
  return v;
}

/**
 * Engines were measured at wildly different output levels (FM peaked 4x hotter
 * than Physical), which made switching engines a volume jump. These trims
 * equalise perceived loudness so the rail is safe to explore.
 */
const ENGINE_TRIM: Readonly<Record<string, number>> = {
  analog: 1.0,
  fm: 0.55,
  physical: 2.2,
  granular: 1.15,
};

export function useInstrument() {
  const hostRef = useRef<EngineHost | null>(null);
  const [started, setStarted] = useState(false);
  const [engineId, setEngineId] = useState<string>(DEFAULT_ENGINE_ID);
  const [layout, setLayout] = useState<Layout>('keys');
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<ReadonlySet<number>>(new Set());
  const [status, setStatus] = useState<string | null>(null);

  const [values, setValues] = useState<Record<string, Float32Array>>(() => {
    const initial: Record<string, Float32Array> = {};
    for (const e of ENGINES) initial[e.descriptor.id] = defaultsFor(e.descriptor);
    return initial;
  });

  const engine = useMemo(
    () => ENGINES.find((e) => e.descriptor.id === engineId) ?? ENGINES[0],
    [engineId],
  );
  const descriptor = engine?.descriptor;
  const current = values[engineId];

  // Phone gets pads, desktop gets keys — overridable, and the choice sticks.
  useEffect(() => {
    const saved = window.localStorage.getItem('sigil.layout');
    if (saved === 'keys' || saved === 'pads') {
      setLayout(saved);
      return;
    }
    setLayout(window.matchMedia('(max-width: 767px)').matches ? 'pads' : 'keys');
  }, []);

  const chooseLayout = useCallback((next: Layout): void => {
    setLayout(next);
    window.localStorage.setItem('sigil.layout', next);
  }, []);

  const start = useCallback(async (): Promise<void> => {
    hostRef.current ??= new EngineHost();
    await hostRef.current.start();
    hostRef.current.setEngine(engineId);
    const v = values[engineId];
    if (v) hostRef.current.setAllParams(v);
    setStarted(true);
  }, [engineId, values]);

  const selectEngine = useCallback((id: string): void => {
    setEngineId(id);
    const host = hostRef.current;
    if (!host) return;
    host.setEngine(id);
    const v = values[id];
    if (v) host.setAllParams(v);
  }, [values]);

  const setParam = useCallback((index: number, value: number): void => {
    setValues((prev) => {
      const arr = prev[engineId];
      if (!arr) return prev;
      const next = Float32Array.from(arr);
      next[index] = value;
      return { ...prev, [engineId]: next };
    });
    hostRef.current?.setParam(index, value);
  }, [engineId]);

  const loadValues = useCallback((next: Float32Array): void => {
    setValues((prev) => ({ ...prev, [engineId]: Float32Array.from(next) }));
    hostRef.current?.setAllParams(next);
  }, [engineId]);

  const noteOn = useCallback((midi: number, velocity = 1): void => {
    hostRef.current?.noteOn(midi, velocity);
    setHeld((prev) => new Set(prev).add(midi));
  }, []);

  const noteOff = useCallback((midi: number): void => {
    hostRef.current?.noteOff(midi);
    setHeld((prev) => {
      const next = new Set(prev);
      next.delete(midi);
      return next;
    });
  }, []);

  const panic = useCallback((): void => {
    hostRef.current?.allNotesOff();
    setHeld(new Set());
  }, []);

  const toggleRecord = useCallback(async (): Promise<void> => {
    const host = hostRef.current;
    if (!host) return;
    if (host.isRecording) {
      const blob = await host.stopRecording();
      setRecording(false);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sigil-take-${Date.now()}.webm`;
        a.click();
        URL.revokeObjectURL(url);
        setStatus('Take saved. On iPhone this is MP4/AAC — use Bounce for true WAV.');
      }
      return;
    }
    if (host.startRecording()) setRecording(true);
  }, []);

  // ---- Bounce -----------------------------------------------------------
  const [bouncing, setBouncing] = useState(false);
  const [lastWav, setLastWav] = useState<{ name: string; bytes: Uint8Array } | null>(null);

  /**
   * Renders whatever is currently held — a chord bounces as one sample, which
   * is the material that actually lands on a KO II pad. Offline, through our
   * own WAV encoder, because MediaRecorder yields MP4/AAC on iOS.
   */
  const bounceChord = useCallback(async (name?: string): Promise<void> => {
    const params = values[engineId];
    if (!params) return;
    const notes = held.size > 0 ? [...held] : [60, 63, 67];
    setBouncing(true);
    setStatus('Rendering…');
    try {
      const result = await bouncePatch({
        patchParams: Float32Array.from(params),
        engineId,
        midiNotes: notes,
        durationMs: 2600,
        releaseAtMs: 1300,
        targetSampleRate: KO2_SAMPLE_RATE,
      });
      const label = name ?? `sigil-${engineId}-${notes.join('-')}`;
      setLastWav({ name: label, bytes: result.wav });

      const blob = new Blob([result.wav.slice().buffer as ArrayBuffer], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${label}.wav`;
      a.click();
      URL.revokeObjectURL(url);

      const kb = Math.round(result.wav.length / 1024);
      setStatus(
        `Saved ${label}.wav — ${kb}KB at ${result.sampleRate}Hz` +
        (result.usedResample ? ' (resampled)' : ' (native KO II rate)'),
      );
    } catch (err) {
      setStatus(err instanceof Error ? `Bounce failed: ${err.message}` : 'Bounce failed');
    } finally {
      setBouncing(false);
    }
  }, [values, engineId, held]);

  const presetsForEngine = useMemo(
    () => PRESETS.filter((p) => p.engineId === engineId),
    [engineId],
  );

  const loadPreset = useCallback((presetId: string): void => {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset || !descriptor) return;
    loadValues(presetToValues(preset, descriptor));
    setStatus(`Loaded ${preset.name}`);
  }, [descriptor, loadValues]);

  // ---- Macros -----------------------------------------------------------
  // Four controls that never move between engines, so your hands learn one
  // instrument rather than four. A macro steers every parameter assigned to it,
  // scaled by that parameter's own macroDepth, moving from its default toward
  // the macro position.
  const [macros, setMacros] = useState<[number, number, number, number]>([0.5, 0.5, 0.5, 0.5]);

  useEffect(() => { setMacros([0.5, 0.5, 0.5, 0.5]); }, [engineId]);

  const setMacro = useCallback((index: 0 | 1 | 2 | 3, value: number): void => {
    setMacros((prev) => {
      const next: [number, number, number, number] = [...prev];
      next[index] = value;
      return next;
    });
    if (!descriptor) return;
    const host = hostRef.current;
    setValues((prev) => {
      const arr = prev[engineId];
      if (!arr) return prev;
      const out = Float32Array.from(arr);
      for (let i = 0; i < descriptor.params.length; i++) {
        const p = descriptor.params[i];
        if (!p || p.macro !== index) continue;
        const depth = p.macroDepth ?? 1;
        const base = normalise(p.default, p);
        const target = base + (value - base) * depth;
        const real = denormalise(Math.min(1, Math.max(0, target)), p);
        out[i] = real;
        host?.setParam(i, real);
      }
      return { ...prev, [engineId]: out };
    });
  }, [descriptor, engineId]);

  const macroNames = descriptor?.macroNames ?? (['Body', 'Air', 'Grit', 'Motion'] as const);

  // ---- Hunt -------------------------------------------------------------
  const seedRef = useRef(1);
  const [huntVariations, setHuntVariations] = useState<readonly HuntVariation[]>([]);

  const reroll = useCallback((): void => {
    if (!descriptor || !current) return;
    const rng = makeRng(seedRef.current++);
    const seed: Patch = { engineId, values: Float32Array.from(current) };
    const next = makeVariations(seed, descriptor, 6, 0.45, rng).map((patch, i) => ({
      id: `${seedRef.current}-${i}`,
      name: `Variation ${i + 1}`,
      patch,
      kept: false,
    }));
    setHuntVariations(next);
  }, [descriptor, current, engineId]);

  const breedKept = useCallback((): void => {
    if (!descriptor) return;
    const kept = huntVariations.filter((v) => v.kept);
    if (kept.length === 0) return;
    const rng = makeRng(seedRef.current++);
    const next: HuntVariation[] = [];
    for (let i = 0; i < 6; i++) {
      const a = kept[i % kept.length]?.patch;
      const b = kept[(i + 1) % kept.length]?.patch ?? a;
      if (!a || !b) continue;
      next.push({
        id: `${seedRef.current}-b${i}`,
        name: `Child ${i + 1}`,
        patch: breed(a, b, descriptor, rng),
        kept: false,
      });
    }
    setHuntVariations(next);
  }, [descriptor, huntVariations]);

  const auditionVariation = useCallback((id: string): void => {
    const found = huntVariations.find((v) => v.id === id);
    if (found) loadValues(found.patch.values);
  }, [huntVariations, loadValues]);

  const toggleKeep = useCallback((id: string): void => {
    setHuntVariations((prev) => prev.map((v) => (v.id === id ? { ...v, kept: !v.kept } : v)));
  }, []);

  return {
    host: hostRef.current,
    started, start,
    engine, descriptor, engineId, selectEngine,
    values: current, setParam, loadValues,
    layout, chooseLayout,
    held, noteOn, noteOff, panic,
    recording, toggleRecord,
    bouncing, bounceChord, lastWav,
    presets: presetsForEngine, loadPreset,
    huntVariations, reroll, breedKept, auditionVariation, toggleKeep,
    macros, setMacro, macroNames,
    status, setStatus,
    engineTrim: ENGINE_TRIM[engineId] ?? 1,
  };
}
