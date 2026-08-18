'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EngineDescriptor } from '@/audio/types';
import { EngineHost } from '@/audio/engine-host';
import { bouncePatch } from '@/audio/bounce';
import { FX_DESCRIPTOR } from '@/dsp/fx-descriptor';
import { FX_MAGIC_DESCRIPTOR } from '@/dsp/fx-magic-descriptor';
import { addressOf, sectionOf } from '@/audio/param-space';
import {
  PATCH_FORMAT_VERSION, serialisePatch, loadPatch, toKeyed, fromKeyed,
} from '@/audio/patch-format';
import { decodeAudioFile, toMono, normaliseSample, detectPitchHz } from '@/audio/sample-store';
import { encodeWav16, trimToZeroCrossings, normalisePeak } from '@/audio/wav';
import { KO2_SAMPLE_RATE } from '@/audio/wav';
import { ENGINES, DEFAULT_ENGINE_ID } from '@/dsp/registry';
import { PRESETS, presetToValues } from '@/dsp/presets';
import {
  makeRng, variations as makeVariations, breed, normalise, denormalise, type Patch,
} from '@/dsp/mutation';
import { nameOf, sigilOf, uniqueName, type Sigil } from '@/dsp/signature';
import { describeAcross } from '@/dsp/lineage';
import { useHuntLore } from '@/ui/use-hunt-lore';
import type { PatchSnapshot } from '@/ui/patch-snapshot';

export type Layout = 'keys' | 'pads';

const USER_PRESET_KEY = 'sigil.userPresets.v1';

/**
 * The live session. Reloading used to lose the sound, the macros and everything
 * else — the audit named that the single biggest risk, because in a plugin the
 * same gap becomes "my finished track opens sounding different".
 *
 * Values are keyed by parameter id and carry a version, so adding a parameter
 * later cannot reinterpret a stored session. This is deliberately the format a
 * plugin's getState/setState would use, so the port inherits a solved problem.
 *
 * Deliberately NOT stored: the kit and the export tray. Both hold WAV bytes and
 * localStorage caps near 5MB — a two-pad kit would blow the whole budget.
 */
const SESSION_KEY = 'sigil.session.v2';

interface StoredSession {
  version: number;
  engineId: string;
  engines: Record<string, Record<string, number>>;
  fx?: Record<string, number>;
  magic?: Record<string, number>;
  bounceMs?: number;
}

export interface UserPreset {
  id: string;
  name: string;
  engineId: string;
  values: number[];
  savedAt: string;
  /** How this patch was found, e.g. `Glass Bell → brighter → bred`. */
  lineage?: string;
}

export interface HuntVariation {
  id: string;
  name: string;
  patch: Patch;
  /** FX and character values travel with the variation — a sound is the whole
   *  chain, so mutating only the engine explored a fraction of the space. */
  fx: Float32Array;
  magic: Float32Array;
  kept: boolean;
  /** The patch's own true name, read off its parameters. */
  title: string;
  /** The patch's mark, so a grid of six reads as six things and not one. */
  sigil: Sigil;
  /** Which way this one went, relative to the seed: `Brighter`, `Longer tail`. */
  changes: readonly string[];
}

/** One generation's starting point, across all three chains. */
interface GenerationSeed {
  engine: Float32Array;
  fx: Float32Array;
  magic: Float32Array;
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

  // ---- FX ---------------------------------------------------------------
  const [fxValues, setFxValues] = useState<Float32Array>(() => defaultsFor(FX_DESCRIPTOR));
  const [magicValues, setMagicValues] = useState<Float32Array>(() => defaultsFor(FX_MAGIC_DESCRIPTOR));

  const setFxParam = useCallback((index: number, value: number): void => {
    setFxValues((prev) => {
      const next = Float32Array.from(prev);
      next[index] = value;
      return next;
    });
    hostRef.current?.setParam(addressOf('fx', index), value);
  }, []);

  const setMagicParam = useCallback((index: number, value: number): void => {
    setMagicValues((prev) => {
      const next = Float32Array.from(prev);
      next[index] = value;
      return next;
    });
    hostRef.current?.setParam(addressOf('magic', index), value);
  }, []);

  const engine = useMemo(
    () => ENGINES.find((e) => e.descriptor.id === engineId) ?? ENGINES[0],
    [engineId],
  );
  const descriptor = engine?.descriptor;
  const current = values[engineId];

  /** Read synchronously by applySound, which must not depend on `values`. */
  const valuesRef = useRef(values);
  valuesRef.current = values;

  /*
   * Where the current sound came from, and what the machine has worked out about
   * your ear. Declared here rather than beside Hunt because loading a preset is
   * what starts a story, and that happens further up.
   */
  const lore = useHuntLore(engineId);
  const {
    commit: loreCommit, suggest: loreSuggest, observe: loreObserve,
    seedFor: loreSeedFor, reset: loreReset, forget: forgetTaste,
  } = lore;

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
    for (let i = 0; i < fxValues.length; i++) {
      hostRef.current.setParam(addressOf('fx', i), fxValues[i] as number);
    }
    for (let i = 0; i < magicValues.length; i++) {
      hostRef.current.setParam(addressOf('magic', i), magicValues[i] as number);
    }
    setStarted(true);
  }, [engineId, values, fxValues, magicValues]);

  /**
   * Give the audio device back when this hook goes away.
   *
   * Without this, every remount built a SECOND AudioWorkletNode onto the same
   * destination while the first kept running, and two engines summing into one
   * output comb-filter each other. It does not sound like a crash — it sounds
   * like the instrument lost its clarity — and Panic cannot clear it, because
   * Panic only reaches the host the UI is currently holding. In development
   * every hot reload stacked another one.
   *
   * No dependencies, so the cleanup runs exactly once, on genuine unmount. The
   * host is built on the power gesture rather than at mount, so React's
   * StrictMode mount/unmount/mount pass finds `hostRef.current` still null on
   * its first cleanup and disposes nothing; the ref is cleared either way, so
   * `start()` builds a fresh host rather than resuming a closed context.
   *
   * `started` needs no correction here: it is component state, and the only
   * thing that disposes the host is that component going away with it.
   */
  useEffect(() => (): void => {
    const host = hostRef.current;
    hostRef.current = null;
    void host?.dispose();
  }, []);

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
    // A new patch is a new starting point, and the macros are back at neutral
    // because they have not been moved away from it yet.
    anchorRef.current[engineId] = Float32Array.from(next);
    setMacros([0.5, 0.5, 0.5, 0.5]);
  }, [engineId]);

  /**
   * Sets a parameter by its flat address, routing to the right chain. MIDI learn
   * and any other address-based source uses this rather than needing to know
   * which chain a knob belongs to.
   */
  const setParamByAddress = useCallback((address: number, value: number): void => {
    const { section, index } = sectionOf(address);
    if (section === 'fx') setFxParam(index, value);
    else if (section === 'magic') setMagicParam(index, value);
    else setParam(index, value);
  }, [setFxParam, setMagicParam, setParam]);

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

  /**
   * Start/stop a performance recording and hand back a real WAV. The worklet
   * captures its own output, so the file is exactly what was heard — the old
   * MediaRecorder path could only ever emit WebM or MP4.
   */
  const toggleRecord = useCallback(async (): Promise<void> => {
    const host = hostRef.current;
    if (!host) {
      setStatus('Hit Power first.');
      return;
    }

    if (host.isRecording) {
      const result = await host.stopCapture();
      setRecording(false);
      if (!result || result.data.length === 0) {
        setStatus('Nothing was captured.');
        return;
      }
      const trimmed = normalisePeak(trimToZeroCrossings(result.data), 0.95);
      const wav = encodeWav16([trimmed], result.sampleRate);
      const seconds = trimmed.length / result.sampleRate;
      const name = `sigil-take-${engineId}-${seconds.toFixed(1)}s`;
      setLastWav({ name, bytes: wav });

      const blob = new Blob([wav.slice().buffer as ArrayBuffer], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.wav`;
      a.click();
      URL.revokeObjectURL(url);

      setStatus(
        result.hitLimit
          ? `Stopped at the 60s limit — saved ${seconds.toFixed(1)}s WAV`
          : `Saved ${seconds.toFixed(1)}s WAV at ${result.sampleRate}Hz`,
      );
      return;
    }

    if (host.startCapture()) {
      setRecording(true);
      setStatus('Recording — play, then press Stop.');
    }
  }, [engineId]);

  // ---- Bounce -----------------------------------------------------------
  const [bouncing, setBouncing] = useState(false);
  const [lastWav, setLastWav] = useState<{ name: string; bytes: Uint8Array } | null>(null);

  /**
   * Bounce length, in milliseconds.
   *
   * This is the ONLY lever on sample size that costs no quality. 16-bit mono at
   * the KO II's native 46 875 Hz is 93.75 KB per second, and bit depth and rate
   * are the device's format rather than our choice — so a shorter bounce is the
   * whole optimisation. The pipeline already trims the dead tail (measured: a
   * 2600ms request produced 1775ms of file with 0.1KB of trimmable silence), so
   * this sets the ceiling, not the actual length.
   *
   * 1200ms suits plucks and stabs at ~112KB; 2600ms suits long releases at
   * ~244KB. Pads on the KO II have their own envelopes, so bouncing short and
   * letting the device shape it is usually the better trade.
   */
  const [bounceMs, setBounceMs] = useState(2600);

  /**
   * Renders whatever is currently held into WAV bytes without saving anything.
   * Split out from `bounceChord` so the kit builder can put a render straight
   * onto a pad instead of routing it through the downloads folder.
   */
  const renderCurrent = useCallback(async (
    name?: string,
  ): Promise<{ name: string; bytes: Uint8Array; durationMs: number; sampleRate: number } | null> => {
    const params = values[engineId];
    if (!params) return null;
    const notes = held.size > 0 ? [...held] : [60, 63, 67];
    setBouncing(true);
    setStatus('Rendering…');
    try {
      const result = await bouncePatch({
        patchParams: Float32Array.from(params),
        engineId,
        midiNotes: notes,
        durationMs: bounceMs,
        releaseAtMs: bounceMs / 2,
        targetSampleRate: KO2_SAMPLE_RATE,
      });
      return {
        name: name ?? `sigil-${engineId}-${notes.join('-')}`,
        bytes: result.wav,
        durationMs: bounceMs,
        sampleRate: result.sampleRate,
      };
    } catch (err) {
      setStatus(err instanceof Error ? `Bounce failed: ${err.message}` : 'Bounce failed');
      return null;
    } finally {
      setBouncing(false);
    }
  }, [values, engineId, held, bounceMs]);

  /** Renders the held chord and saves it as a file. */
  const bounceChord = useCallback(async (name?: string): Promise<void> => {
    const rendered = await renderCurrent(name);
    if (!rendered) return;
    setLastWav({ name: rendered.name, bytes: rendered.bytes });

    const blob = new Blob([rendered.bytes.slice().buffer as ArrayBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${rendered.name}.wav`;
    a.click();
    URL.revokeObjectURL(url);

    const kb = Math.round(rendered.bytes.length / 1024);
    setStatus(`Saved ${rendered.name}.wav — ${kb}KB at ${rendered.sampleRate}Hz`);
  }, [renderCurrent]);

  // ---- Sample loading ---------------------------------------------------
  const [sampleName, setSampleName] = useState<string | null>(null);

  /**
   * Decodes a file and hands the audio to the worklet. The worklet holds its own
   * copy of every module, so the sample must cross by message — setting module
   * state on this side would silently do nothing.
   */
  const loadSampleFile = useCallback(async (file: File): Promise<void> => {
    const host = hostRef.current;
    const ctx = host?.context;
    if (!host || !ctx) {
      setStatus('Hit Power first, then load a sample.');
      return;
    }
    setStatus(`Decoding ${file.name}…`);
    try {
      const stored = await decodeAudioFile(file, ctx);
      const mono = normaliseSample(toMono(stored), 0.95);
      const pitch = detectPitchHz(mono, stored.sampleRate);
      const rootHz = pitch ?? 261.6255653;
      host.loadSample(mono, stored.sampleRate, rootHz);
      setSampleName(stored.name);
      selectEngine('sampler');
      setStatus(
        pitch === null
          ? `Loaded ${stored.name} — unpitched, root set to C4`
          : `Loaded ${stored.name} — root ${pitch.toFixed(1)}Hz`,
      );
    } catch (err) {
      setStatus(err instanceof Error ? `Could not load: ${err.message}` : 'Could not load sample');
    }
  }, [selectEngine]);

  const presetsForEngine = useMemo(
    () => PRESETS.filter((p) => p.engineId === engineId),
    [engineId],
  );

  const [activePresetId, setActivePresetId] = useState<string | null>(null);

  const loadPreset = useCallback((presetId: string): void => {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset || !descriptor) return;
    loadValues(presetToValues(preset, descriptor));
    setActivePresetId(presetId);
    // A preset is an origin: the story of anything found from here starts here.
    loreReset(preset.name);
    setStatus(`Loaded ${preset.name}`);
  }, [descriptor, loadValues, loreReset]);

  // ---- User presets ------------------------------------------------------
  const [userPresets, setUserPresets] = useState<readonly UserPreset[]>([]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(USER_PRESET_KEY);
      if (raw) setUserPresets(JSON.parse(raw) as UserPreset[]);
    } catch {
      // Corrupt storage should never stop the instrument from opening.
    }
  }, []);

  const persistUserPresets = useCallback((next: readonly UserPreset[]): void => {
    setUserPresets(next);
    try {
      window.localStorage.setItem(USER_PRESET_KEY, JSON.stringify(next));
    } catch {
      setStatus('Could not save — browser storage is full or blocked.');
    }
  }, []);

  const savePreset = useCallback((name: string): void => {
    const arr = values[engineId];
    if (!arr) return;
    const entry: UserPreset = {
      id: `user-${engineId}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      engineId,
      values: Array.from(arr),
      savedAt: new Date().toISOString(),
      // The patch keeps the story of how it was found. A sound you can retell
      // is a sound you keep.
      ...(lore.trail === '' ? {} : { lineage: lore.trail }),
    };
    persistUserPresets([...userPresets.filter((u) => u.id !== entry.id), entry]);
    setActivePresetId(entry.id);
    // Naming it makes it an origin in its own right.
    loreReset(name);
    setStatus(`Saved ${name}`);
  }, [values, engineId, userPresets, persistUserPresets, lore.trail, loreReset]);

  const loadUserPreset = useCallback((id: string): void => {
    const found = userPresets.find((u) => u.id === id);
    if (!found) return;
    loadValues(Float32Array.from(found.values));
    setActivePresetId(id);
    loreReset(found.name);
    setStatus(`Loaded ${found.name}`);
  }, [userPresets, loadValues, loreReset]);

  const deleteUserPreset = useCallback((id: string): void => {
    persistUserPresets(userPresets.filter((u) => u.id !== id));
  }, [userPresets, persistUserPresets]);

  const userPresetsForEngine = useMemo(
    () => userPresets.filter((u) => u.engineId === engineId),
    [userPresets, engineId],
  );

  // ---- Macros -----------------------------------------------------------
  // Four controls that never move between engines, so your hands learn one
  // instrument rather than four. A macro steers every parameter assigned to it,
  // scaled by that parameter's own macroDepth, moving from its default toward
  // the macro position.
  const [macros, setMacros] = useState<[number, number, number, number]>([0.5, 0.5, 0.5, 0.5]);

  /*
   * What the macros modulate FROM: the patch as it was last loaded, per engine.
   *
   * They used to work from each parameter's descriptor DEFAULT, which meant one
   * nudge of a macro threw away the preset you were sitting on. Loading
   * "Cathedral Drift" and moving Body by 4% jumped Sub from 0.15 to 0.462 —
   * a 3x change — because the preset's value was discarded in favour of one
   * derived from the factory 0.30. Every macro on every engine did this.
   *
   * Anchoring on the loaded patch also makes 0.5 mean something: centre is the
   * patch untouched, so returning a macro to the middle actually returns the
   * sound. It could not before, and the "50" on the row was decoration.
   */
  const anchorRef = useRef<Record<string, Float32Array>>({});

  /*
   * Macros re-centre when you change engine — four dials that mean something
   * different per engine cannot keep their old positions. Undo is the one
   * exception: restoring a snapshot that came from another engine has to land
   * on that snapshot's macro positions, not on the centre. It parks them here
   * so this effect, which runs after the engine change, hands them over instead
   * of overwriting them.
   */
  const pendingMacrosRef = useRef<readonly [number, number, number, number] | null>(null);
  useEffect(() => {
    const pending = pendingMacrosRef.current;
    pendingMacrosRef.current = null;
    setMacros(pending === null ? [0.5, 0.5, 0.5, 0.5] : [...pending]);
  }, [engineId]);

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
        const anchored = anchorRef.current[engineId]?.[i];
        const base = normalise(anchored ?? p.default, p);
        /*
         * Doubling keeps the ends where they were — a depth-1 macro still
         * sweeps the full range when the anchor sits mid-travel — while making
         * the centre mean "leave the patch alone".
         */
        const target = base + (value - 0.5) * 2 * depth;
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
  const [auditioningId, setAuditioningId] = useState<string | null>(null);
  /** What this generation grew from, so a child can say how it differs. */
  const genSeedRef = useRef<GenerationSeed | null>(null);

  /**
   * Builds one generation's cards from raw mutations: each gets its own true
   * name, its own mark, and the one or two words that say how it differs from
   * what it grew out of. This is the whole difference between six cards called
   * "Variation 1..6" and six cards you can choose between.
   */
  const describeGeneration = useCallback((
    seed: GenerationSeed,
    children: readonly GenerationSeed[],
    idPrefix: string,
  ): HuntVariation[] => {
    if (!descriptor) return [];
    return children.map((child, i) => ({
      id: `${idPrefix}-${i}`,
      name: `Variation ${i + 1}`,
      patch: { engineId, values: child.engine },
      fx: child.fx,
      magic: child.magic,
      kept: false,
      title: nameOf(child.engine, descriptor),
      sigil: sigilOf(child.engine, descriptor),
      changes: describeAcross([
        { from: seed.engine, to: child.engine, descriptor },
        { from: seed.fx, to: child.fx, descriptor: FX_DESCRIPTOR },
        { from: seed.magic, to: child.magic, descriptor: FX_MAGIC_DESCRIPTOR },
      ]),
    }));
  }, [descriptor, engineId]);

  const reroll = useCallback((): void => {
    if (!descriptor || !current) return;
    /*
     * A hunt started from nothing still has an origin: the sound you were
     * already holding, under its own true name. Without this the trail reads as
     * one lonely word — "narrower" — with nothing for it to be narrower *than*.
     * Otherwise, rerolling moves on from whatever you were auditioning, so that
     * step becomes part of the story rather than a maybe.
     */
    if (lore.trail === '') loreReset(nameOf(current, descriptor));
    else loreCommit();
    const rng = makeRng(seedRef.current++);
    /*
     * The seed is nudged along the taste direction first: after a few
     * generations of keeping the same kind of thing, the machine offers that
     * kind of thing. With no taste yet this is exactly the old behaviour.
     */
    const seed: GenerationSeed = {
      engine: loreSeedFor(current, descriptor),
      fx: Float32Array.from(fxValues),
      magic: Float32Array.from(magicValues),
    };
    genSeedRef.current = seed;
    // FX move less than the engine: a wild reverb or freeze setting swamps the
    // sound being judged, so the tail stays recognisable while the voice roams.
    const engines = makeVariations({ engineId, values: seed.engine }, descriptor, 6, 0.45, rng);
    const fxs = makeVariations({ engineId: 'fx', values: seed.fx }, FX_DESCRIPTOR, 6, 0.22, rng);
    const magics = makeVariations(
      { engineId: 'magic', values: seed.magic }, FX_MAGIC_DESCRIPTOR, 6, 0.18, rng,
    );
    const children: GenerationSeed[] = engines.map((patch, i) => ({
      engine: patch.values,
      fx: fxs[i]?.values ?? Float32Array.from(seed.fx),
      magic: magics[i]?.values ?? Float32Array.from(seed.magic),
    }));
    setHuntVariations(describeGeneration(seed, children, `${seedRef.current}`));
    setAuditioningId(null);
  }, [
    descriptor, current, engineId, fxValues, magicValues,
    lore.trail, loreReset, loreCommit, loreSeedFor, describeGeneration,
  ]);

  /**
   * Throw the dice on the sound you are holding — one big mutation, applied
   * straight to the instrument rather than offered as six cards.
   *
   * Hunt is the deliberate version of this; sometimes you just want to be
   * somewhere else. It is only a reasonable gesture because undo exists: with
   * a way back, a wild patch is an experiment instead of a loss.
   */
  const randomise = useCallback((): void => {
    if (!descriptor || !current) return;
    const rng = makeRng(seedRef.current++);
    const [engineNext] = makeVariations(
      { engineId, values: Float32Array.from(current) }, descriptor, 1, 0.8, rng,
    );
    if (engineNext === undefined) return;
    loadValues(engineNext.values);
    // FX roam less than the voice, for the same reason they do in Hunt: a wild
    // tail swamps the sound you are trying to judge.
    const [fxNext] = makeVariations(
      { engineId: 'fx', values: Float32Array.from(fxValues) }, FX_DESCRIPTOR, 1, 0.3, rng,
    );
    if (fxNext !== undefined) {
      setFxValues(fxNext.values);
      for (let i = 0; i < fxNext.values.length; i++) {
        hostRef.current?.setParam(addressOf('fx', i), fxNext.values[i] as number);
      }
    }
    setActivePresetId(null);
    setStatus('Rolled a new patch');
  }, [descriptor, current, engineId, fxValues, loadValues]);

  const breedKept = useCallback((): void => {
    if (!descriptor) return;
    const kept = huntVariations.filter((v) => v.kept);
    const first = kept[0];
    if (first === undefined) return;

    /*
     * Keeping is a vote, and this is where it is counted: the offsets between
     * what was offered and what you kept become the standing taste, which biases
     * every generation from here on.
     */
    const offered = genSeedRef.current;
    if (offered !== null) {
      loreObserve(offered.engine, kept.map((k) => k.patch.values), descriptor);
    }
    loreCommit('bred');

    const rng = makeRng(seedRef.current++);
    const children: GenerationSeed[] = [];
    for (let i = 0; i < 6; i++) {
      const pa = kept[i % kept.length];
      const pb = kept[(i + 1) % kept.length] ?? pa;
      if (!pa || !pb) continue;
      children.push({
        engine: breed(pa.patch, pb.patch, descriptor, rng).values,
        fx: breed({ engineId: 'fx', values: pa.fx },
                  { engineId: 'fx', values: pb.fx }, FX_DESCRIPTOR, rng).values,
        magic: breed({ engineId: 'magic', values: pa.magic },
                     { engineId: 'magic', values: pb.magic }, FX_MAGIC_DESCRIPTOR, rng).values,
      });
    }

    // Children are described against the first parent, because "how does this
    // differ from the one I kept" is the question you are actually asking.
    const parent: GenerationSeed = {
      engine: first.patch.values, fx: first.fx, magic: first.magic,
    };
    genSeedRef.current = parent;
    setHuntVariations(describeGeneration(parent, children, `${seedRef.current}-b`));
    setAuditioningId(null);
  }, [descriptor, huntVariations, loreObserve, loreCommit, describeGeneration]);

  const auditionVariation = useCallback((id: string): void => {
    const found = huntVariations.find((v) => v.id === id);
    if (!found) return;
    loadValues(found.patch.values);
    setFxValues(Float32Array.from(found.fx));
    setMagicValues(Float32Array.from(found.magic));
    const host = hostRef.current;
    if (host) {
      for (let i = 0; i < found.fx.length; i++) {
        host.setParam(addressOf('fx', i), found.fx[i] as number);
      }
      for (let i = 0; i < found.magic.length; i++) {
        host.setParam(addressOf('magic', i), found.magic[i] as number);
      }
    }
    /*
     * Auditioning a sibling is a lateral move, not a step deeper, so its word
     * REPLACES the last one in the trail instead of stacking. Clicking through
     * all six cards must not leave you with a six-word story you did not write.
     */
    loreSuggest(found.changes[0]);
    setAuditioningId(id);
  }, [huntVariations, loadValues, loreSuggest]);

  const toggleKeep = useCallback((id: string): void => {
    setHuntVariations((prev) => prev.map((v) => (v.id === id ? { ...v, kept: !v.kept } : v)));
  }, []);

  /*
   * The current sound's identity, read straight off its parameters — so it is
   * correct the instant a macro moves, with nothing to invalidate and nothing
   * stored. The name is only a suggestion; it lands in the Save prompt already
   * filled in, which is the difference between naming a thing and doing admin.
   */
  const sigil = useMemo(
    () => (descriptor && current ? sigilOf(current, descriptor) : null),
    [descriptor, current],
  );

  const trueName = useMemo(
    () => (descriptor && current ? nameOf(current, descriptor) : null),
    [descriptor, current],
  );

  const suggestedName = useMemo(
    () => (trueName === null
      ? ''
      : uniqueName(trueName, userPresetsForEngine.map((u) => u.name))),
    [trueName, userPresetsForEngine],
  );

  // ---- Session persistence ----------------------------------------------
  /**
   * Restore once on mount, then save on every change. Restore happens before the
   * first start(), so powering on already pushes the recovered patch into the
   * worklet and nothing special is needed at power-on.
   */
  const restored = useRef(false);
  /**
   * True once the stored session has been put back. Undo watches it: without
   * this, restoring last night's patch on page load looked exactly like an
   * edit, and the first Cmd-Z of the day threw the session away and dropped
   * you on engine defaults.
   */
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      const raw = window.localStorage.getItem(SESSION_KEY);
      if (raw === null) return;
      const session = JSON.parse(raw) as StoredSession;
      if (typeof session !== 'object' || session === null) return;

      const notes: string[] = [];
      const nextValues: Record<string, Float32Array> = {};
      for (const e of ENGINES) {
        const stored = session.engines?.[e.descriptor.id];
        const r = fromKeyed(e.descriptor, stored, e.descriptor.name);
        nextValues[e.descriptor.id] = r.values;
        if (stored !== undefined) notes.push(...r.warnings);
      }
      setValues(nextValues);

      if (session.fx) {
        const r = fromKeyed(FX_DESCRIPTOR, session.fx, 'FX');
        setFxValues(r.values);
        notes.push(...r.warnings);
      }
      if (session.magic) {
        const r = fromKeyed(FX_MAGIC_DESCRIPTOR, session.magic, 'Character');
        setMagicValues(r.values);
        notes.push(...r.warnings);
      }
      if (typeof session.bounceMs === 'number') setBounceMs(session.bounceMs);
      if (
        typeof session.engineId === 'string'
        && ENGINES.some((e) => e.descriptor.id === session.engineId)
      ) {
        setEngineId(session.engineId);
      }

      // Only speak up when something had to be recovered; a clean restore is
      // supposed to be invisible.
      if (notes.length > 0) setStatus(notes[0] ?? null);
    } catch {
      // A corrupt session must never stop the instrument from opening.
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!restored.current) return;
    const engines: Record<string, Record<string, number>> = {};
    for (const e of ENGINES) {
      const v = values[e.descriptor.id];
      if (v) engines[e.descriptor.id] = toKeyed(e.descriptor, v);
    }
    const session: StoredSession = {
      version: PATCH_FORMAT_VERSION,
      engineId,
      engines,
      fx: toKeyed(FX_DESCRIPTOR, fxValues),
      magic: toKeyed(FX_MAGIC_DESCRIPTOR, magicValues),
      bounceMs,
    };
    try {
      window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      // Storage full or blocked in private browsing. Playing continues.
    }
  }, [values, engineId, fxValues, magicValues, bounceMs]);

  /**
   * The whole instrument as one serialisable object — exactly what a plugin host
   * asks for on save. Exposed so the port has an obvious seam instead of needing
   * this rebuilt.
   */
  const exportPatch = useCallback((name?: string) => {
    if (!descriptor || !current) return null;
    return serialisePatch({
      engine: descriptor,
      values: current,
      fxDescriptor: FX_DESCRIPTOR,
      fx: fxValues,
      magicDescriptor: FX_MAGIC_DESCRIPTOR,
      magic: magicValues,
      name,
    });
  }, [descriptor, current, fxValues, magicValues]);

  const importPatch = useCallback((raw: unknown): boolean => {
    if (!descriptor) return false;
    const loaded = loadPatch(raw, descriptor, FX_DESCRIPTOR, FX_MAGIC_DESCRIPTOR);
    if (loaded === null) {
      setStatus('That does not look like a SIGIL patch.');
      return false;
    }
    loadValues(loaded.values);
    if (loaded.fx) {
      setFxValues(loaded.fx);
      for (let i = 0; i < loaded.fx.length; i++) {
        hostRef.current?.setParam(addressOf('fx', i), loaded.fx[i] as number);
      }
    }
    if (loaded.magic) {
      setMagicValues(loaded.magic);
      for (let i = 0; i < loaded.magic.length; i++) {
        hostRef.current?.setParam(addressOf('magic', i), loaded.magic[i] as number);
      }
    }
    setStatus(loaded.warnings[0] ?? 'Patch loaded');
    return true;
  }, [descriptor, loadValues]);

  /**
   * Point the whole instrument at another sound: engine and patch together, in
   * one gesture. Selecting a track in SONG scope is exactly this — sculpt,
   * deep, fx and hunt keep their meaning and simply start editing the track you
   * picked. This is the one seam section 2.7 of the arrangement IA asks for.
   *
   * It cannot be selectEngine() followed by importPatch(): importPatch resolves
   * its descriptor from the CURRENT engine, and that state has not landed yet,
   * so the patch would be read against the engine you were leaving.
   *
   * A track with no stored patch keeps whatever that engine already holds,
   * which is what makes a one-track song byte-for-byte today's app.
   */
  const applySound = useCallback((nextEngineId: string, patch?: unknown): void => {
    const target = ENGINES.find((e) => e.descriptor.id === nextEngineId);
    if (!target) return;
    const host = hostRef.current;
    setEngineId(nextEngineId);
    host?.setEngine(nextEngineId);

    const loaded = patch === undefined || patch === null
      ? null
      : loadPatch(patch, target.descriptor, FX_DESCRIPTOR, FX_MAGIC_DESCRIPTOR);

    if (loaded === null) {
      const held = valuesRef.current[nextEngineId];
      if (held) host?.setAllParams(held);
      return;
    }

    setValues((prev) => ({ ...prev, [nextEngineId]: Float32Array.from(loaded.values) }));
    host?.setAllParams(loaded.values);
    if (loaded.fx) {
      setFxValues(loaded.fx);
      for (let i = 0; i < loaded.fx.length; i++) {
        host?.setParam(addressOf('fx', i), loaded.fx[i] as number);
      }
    }
    if (loaded.magic) {
      setMagicValues(loaded.magic);
      for (let i = 0; i < loaded.magic.length; i++) {
        host?.setParam(addressOf('magic', i), loaded.magic[i] as number);
      }
    }
  }, []);

  /**
   * Put a whole sound back, in one gesture — the seam undo/redo needs.
   *
   * It cannot be selectEngine() + loadValues() + setFxParam()xN: those are four
   * separate state updates whose intermediate frames are audible, and the macro
   * re-centre effect would fire between them and wipe the restored positions.
   * One call, so the sound moves once.
   */
  const restorePatch = useCallback((snap: PatchSnapshot): void => {
    const target = ENGINES.find((e) => e.descriptor.id === snap.engineId);
    if (!target) return;
    const host = hostRef.current;

    if (snap.engineId !== engineId) {
      // Hand the macro-reset effect the positions to land on. See its comment.
      pendingMacrosRef.current = snap.macros;
      setEngineId(snap.engineId);
      host?.setEngine(snap.engineId);
    }

    setValues((prev) => ({ ...prev, [snap.engineId]: Float32Array.from(snap.values) }));
    host?.setAllParams(snap.values);
    // Undo restores the macro POSITIONS too, so the anchor has to be the patch
    // those positions were measured against, not whatever was loaded last.
    anchorRef.current[snap.engineId] = Float32Array.from(snap.values);

    setFxValues(Float32Array.from(snap.fx));
    for (let i = 0; i < snap.fx.length; i++) {
      host?.setParam(addressOf('fx', i), snap.fx[i] as number);
    }
    setMagicValues(Float32Array.from(snap.magic));
    for (let i = 0; i < snap.magic.length; i++) {
      host?.setParam(addressOf('magic', i), snap.magic[i] as number);
    }

    setMacros([...snap.macros]);
    setActivePresetId(snap.presetId);
  }, [engineId]);

  return {
    exportPatch, importPatch, applySound, restorePatch,
    host: hostRef.current,
    started, start,
    engine, descriptor, engineId, selectEngine,
    values: current, setParam, loadValues,
    layout, chooseLayout,
    held, noteOn, noteOff, panic,
    recording, toggleRecord,
    bouncing, bounceChord, renderCurrent, lastWav, bounceMs, setBounceMs,
    sampleName, loadSampleFile,
    presets: presetsForEngine, loadPreset, activePresetId,
    userPresets: userPresetsForEngine, savePreset, loadUserPreset, deleteUserPreset,
    huntVariations, reroll, breedKept, auditionVariation, toggleKeep, auditioningId,
    randomise,
    sigil, trueName, suggestedName,
    trail: lore.trail, tasteLabels: lore.tasteLabels, forgetTaste,
    macros, setMacro, macroNames, setParamByAddress,
    fxDescriptor: FX_DESCRIPTOR, fxValues, setFxParam,
    magicDescriptor: FX_MAGIC_DESCRIPTOR, magicValues, setMagicParam,
    status, setStatus, hydrated,
    engineTrim: ENGINE_TRIM[engineId] ?? 1,
  };
}
