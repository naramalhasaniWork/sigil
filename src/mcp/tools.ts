/**
 * The MCP tool layer: everything a language model can do to a SIGIL song,
 * expressed as plain functions.
 *
 * Three rules hold this file together.
 *
 *  1. PURE. No HTTP, no React, no DOM. Arguments in, results out, storage
 *     injected. `src/mcp/server.ts` speaks JSON-RPC; this file never does.
 *  2. NEVER THROW AT THE BOUNDARY. Every tool returns `{ok:false, error}`
 *     with a sentence a model can act on. A stack trace teaches it nothing.
 *  3. ONE REPRESENTATION OF TIME IN THE FILE. Ticks at PPQ 96, always. Bars
 *     and beats are an ergonomic input, converted HERE and never stored —
 *     two ways to say one thing is how a compatible format rots.
 *
 * Ids are SLUGS (`track_bass`, `sec_drop`, `pat_bass_drop`), not UUIDs. A
 * model can reference `track_bass` from three messages ago; it cannot
 * reference `a7f3c2e1-…`, and it will invent one rather than admit that.
 */
import { ENGINES, engineById } from '@/dsp/registry';
import { FX_DESCRIPTOR } from '@/dsp/fx-descriptor';
import { FX_MAGIC_DESCRIPTOR } from '@/dsp/fx-magic-descriptor';
import { PRESETS, presetToValues } from '@/dsp/presets';
import {
  fromKeyed,
  serialisePatch,
  toKeyed,
  type SerialisedPatch,
} from '@/audio/patch-format';
import { PPQ } from '@/dsp/sequencer';
import {
  SCALES,
  diatonicChord,
  noteName,
  scaleNotes,
  voiceChord,
  type ChordQuality,
  type ScaleName,
} from '@/dsp/chords';

/* ------------------------------------------------------------------ shape */

/*
 * MIRROR of the arrangement format described in docs/design/arrangement-ia.md §3.
 * `src/audio/arrangement-format.ts` is being written in a parallel pass and is
 * not on this task's file list; the field names, units and ranges below are
 * taken from that spec verbatim so the two agree on the wire. When that module
 * lands, delete this block and import its types — nothing else here changes.
 */
export const ARRANGEMENT_FORMAT_VERSION = 1;
export const MAX_TRACKS = 8;
export const MIN_BPM = 20;
export const MAX_BPM = 300;

export interface TempoSpec { bpm: number; beatsPerBar: number; ppq: number }
export interface KeySpec { root: number; scale: ScaleName }
export interface SectionRecord {
  id: string; name: string; bars: number; repeats?: number; colour?: string;
}
export interface TrackRecord {
  id: string; name: string; engineId: string; patch?: SerialisedPatch;
  presetId?: string; gain?: number; pan?: number; muted?: boolean;
  soloed?: boolean; colour?: string; sampleRef?: string;
}
export interface NoteRecord {
  id: string; midi: number; velocity: number; startTick: number;
  durationTicks: number; pass?: number;
}
export interface PatternRecord {
  id: string; name?: string; lengthBars: number; beatsPerBar: number;
  ppq: number; notes: readonly NoteRecord[];
}
export interface ClipRecord {
  id: string; trackId: string; sectionId: string; patternId: string;
  fill?: 'loop' | 'once'; transpose?: number; velocityScale?: number;
  muted?: boolean;
}
export interface SerialisedArrangement {
  version: number; id: string; name: string; savedAt?: string;
  tempo: TempoSpec; key: KeySpec;
  sections: readonly SectionRecord[];
  tracks: readonly TrackRecord[];
  patterns: Readonly<Record<string, PatternRecord>>;
  clips: readonly ClipRecord[];
  master?: { gain?: number };
  meta?: Readonly<Record<string, unknown>>;
}

/* ---------------------------------------------------------------- storage */

export interface ArrangementSummary {
  id: string; name: string; savedAt?: string; tracks: number; sections: number;
}

/**
 * The seam the database will slot into. Async on purpose: a Postgres-backed
 * store must not force every tool to be rewritten, and an in-memory one loses
 * nothing by awaiting.
 */
export interface ArrangementStore {
  get(id: string): Promise<SerialisedArrangement | null>;
  put(arrangement: SerialisedArrangement): Promise<void>;
  list(): Promise<readonly ArrangementSummary[]>;
  delete(id: string): Promise<boolean>;
}

export function createMemoryStore(
  seed: readonly SerialisedArrangement[] = [],
): ArrangementStore {
  const rows = new Map<string, SerialisedArrangement>();
  for (const a of seed) rows.set(a.id, a);
  return {
    async get(id) { return rows.get(id) ?? null; },
    async put(a) { rows.set(a.id, a); },
    async list() {
      return [...rows.values()].map((a) => ({
        id: a.id,
        name: a.name,
        ...(a.savedAt === undefined ? {} : { savedAt: a.savedAt }),
        tracks: a.tracks.length,
        sections: a.sections.length,
      }));
    },
    async delete(id) { return rows.delete(id); },
  };
}

/* -------------------------------------------------------------- results */

export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** Thrown internally by the argument readers; never escapes a tool. */
class BadArgs extends Error {}

function bad(message: string): never { throw new BadArgs(message); }

/** Wraps a tool body so a bad argument becomes a sentence, not a 500. */
async function guard<T>(fn: () => Promise<T> | T): Promise<ToolResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof BadArgs) return { ok: false, error: err.message };
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Internal error: ${detail}` };
  }
}

/* ------------------------------------------------------- argument readers */

function rec(args: unknown, what = 'arguments'): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    bad(`Expected ${what} to be an object, got ${args === null ? 'null' : typeof args}.`);
  }
  return args as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string, dflt?: string): string {
  const v = o[key];
  if (v === undefined || v === null) {
    if (dflt !== undefined) return dflt;
    bad(`Missing required argument "${key}" (a string).`);
  }
  if (typeof v !== 'string' || v.trim() === '') {
    bad(`Argument "${key}" must be a non-empty string, got ${JSON.stringify(v)}.`);
  }
  return v.trim();
}

function optStr(o: Record<string, unknown>, key: string): string | undefined {
  return o[key] === undefined || o[key] === null ? undefined : str(o, key);
}

function num(
  o: Record<string, unknown>, key: string, min: number, max: number, dflt?: number,
): number {
  const v = o[key];
  if (v === undefined || v === null) {
    if (dflt !== undefined) return dflt;
    bad(`Missing required argument "${key}" (a number between ${min} and ${max}).`);
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    bad(`Argument "${key}" must be a finite number, got ${JSON.stringify(v)}.`);
  }
  if (v < min || v > max) {
    bad(`Argument "${key}" must be between ${min} and ${max}, got ${v}.`);
  }
  return v;
}

function optNum(
  o: Record<string, unknown>, key: string, min: number, max: number,
): number | undefined {
  return o[key] === undefined || o[key] === null ? undefined : num(o, key, min, max);
}

function bool(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') bad(`Argument "${key}" must be true or false.`);
  return v;
}

function arr(o: Record<string, unknown>, key: string, required = true): unknown[] {
  const v = o[key];
  if (v === undefined || v === null) {
    if (!required) return [];
    bad(`Missing required argument "${key}" (an array).`);
  }
  if (!Array.isArray(v)) bad(`Argument "${key}" must be an array.`);
  return v;
}

/** A keyed parameter map, e.g. `{"filter-cutoff": 800}`. */
function keyedNumbers(
  o: Record<string, unknown>, key: string,
): Record<string, number> | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  const obj = rec(v, `"${key}"`);
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(obj)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      bad(`"${key}.${k}" must be a finite number, got ${JSON.stringify(raw)}.`);
    }
    out[k] = raw;
  }
  return out;
}

function oneOf<T extends string>(
  value: string, allowed: readonly T[], label: string,
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  bad(`${label} must be one of: ${allowed.join(', ')}. Got "${value}".`);
}

/* ------------------------------------------------------------ ids & notes */

export function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return base === '' ? 'x' : base;
}

/** `prefix_slug`, with `__2`, `__3`… on collision. Deterministic. */
export function uniqueId(prefix: string, name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `${prefix}${slugify(name)}`;
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}__${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}__${used.size}`;
}

const PITCH_CLASSES: Readonly<Record<string, number>> = {
  c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11,
};

/** "C3" / "F#2" / "Bb4" -> MIDI. Also accepts a bare pitch name at octave 3. */
export function parseNoteName(text: string): number | null {
  const m = /^([a-gA-G])([#b]?)(-?\d+)?$/.exec(text.trim());
  if (!m) return null;
  const letter = PITCH_CLASSES[(m[1] ?? 'c').toLowerCase()];
  if (letter === undefined) return null;
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const octave = m[3] === undefined ? 3 : Number(m[3]);
  const midi = (octave + 1) * 12 + letter + accidental;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/** A pitch class 0..11 from a number or a name like "F#". */
function readRoot(o: Record<string, unknown>, key: string, dflt: number): number {
  const v = o[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v === 'number') return num(o, key, 0, 11);
  if (typeof v === 'string') {
    const midi = parseNoteName(v);
    if (midi === null) bad(`Argument "${key}" is not a note name or 0..11: "${v}".`);
    return ((midi % 12) + 12) % 12;
  }
  bad(`Argument "${key}" must be a pitch class 0..11 or a note name like "F#".`);
}

const ROMAN: Readonly<Record<string, number>> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7,
};

/** 1-based scale degree from `4`, `"IV"`, `"iv"`. Quality comes from the scale. */
export function parseDegree(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = Math.round(value);
    if (d < 1 || d > 16) bad(`Degree ${value} is out of range (1..16).`);
    return d;
  }
  if (typeof value === 'string') {
    const cleaned = value.trim().toLowerCase().replace(/[^ivx0-9]/g, '');
    if (/^\d+$/.test(cleaned)) return parseDegree(Number(cleaned));
    const roman = ROMAN[cleaned];
    if (roman !== undefined) return roman;
  }
  bad(`Could not read the scale degree ${JSON.stringify(value)}. Use 1..7 or "I".."vii".`);
}

/* ------------------------------------------------------- catalogue tools */

export function listEngines(args: unknown): Promise<ToolResult> {
  return guard(() => {
    const o = rec(args ?? {});
    const filter = optStr(o, 'engineId');
    const engines = ENGINES
      .filter((e) => filter === undefined || e.descriptor.id === filter)
      .map((e) => ({
        id: e.descriptor.id,
        name: e.descriptor.name,
        colour: e.descriptor.colour,
        macros: e.descriptor.macroNames,
        paramCount: e.descriptor.params.length,
        presets: PRESETS.filter((p) => p.engineId === e.descriptor.id).length,
      }));
    if (filter !== undefined && engines.length === 0) {
      bad(`No engine "${filter}". Known engines: ${ENGINES.map((e) => e.descriptor.id).join(', ')}.`);
    }
    return { engines };
  });
}

function paramView(descriptor: { params: readonly {
  id: string; name: string; group: string; unit: string; min: number; max: number;
  default: number; curve: string; explain: string; macro?: number;
}[] }, group?: string) {
  return descriptor.params
    .filter((p) => group === undefined || p.group.toLowerCase() === group.toLowerCase())
    .map((p) => ({
      id: p.id, name: p.name, group: p.group, unit: p.unit,
      min: p.min, max: p.max, default: p.default, curve: p.curve,
      ...(p.macro === undefined ? {} : { macro: p.macro }),
      explain: p.explain,
    }));
}

/**
 * Full parameter table for one engine, or for the shared `fx` / `character`
 * chains. `explain` is the point of this tool: it is the sentence that lets a
 * model pick "filter-cutoff" over "osc-drift" for the word "brighter".
 */
export function describeEngine(args: unknown): Promise<ToolResult> {
  return guard(() => {
    const o = rec(args);
    const id = str(o, 'engineId');
    const group = optStr(o, 'group');
    if (id === 'fx' || id === 'character' || id === 'magic') {
      const d = id === 'fx' ? FX_DESCRIPTOR : FX_MAGIC_DESCRIPTOR;
      return { id: d.id, name: d.name, macros: d.macroNames, params: paramView(d, group) };
    }
    const engine = engineById(id);
    if (!engine) {
      bad(`No engine "${id}". Known engines: ${ENGINES.map((e) => e.descriptor.id).join(', ')}, plus "fx" and "character".`);
    }
    const d = engine.descriptor;
    return { id: d.id, name: d.name, colour: d.colour, macros: d.macroNames, params: paramView(d, group) };
  });
}

export function listPresets(args: unknown): Promise<ToolResult> {
  return guard(() => {
    const o = rec(args ?? {});
    const character = optStr(o, 'character');
    const engineId = optStr(o, 'engineId');
    const tags = [...new Set(PRESETS.flatMap((p) => p.character))].sort();
    if (character !== undefined && !tags.includes(character)) {
      bad(`No preset carries the character "${character}". Tags in the library: ${tags.join(', ')}.`);
    }
    const presets = PRESETS
      .filter((p) => character === undefined || p.character.includes(character))
      .filter((p) => engineId === undefined || p.engineId === engineId)
      .map((p) => ({ id: p.id, name: p.name, engineId: p.engineId, character: p.character }));
    return { tags, count: presets.length, presets };
  });
}

/* ------------------------------------------------------------ patch tools */

function engineOrDie(id: string) {
  const engine = engineById(id);
  if (!engine) {
    bad(`No engine "${id}". Known engines: ${ENGINES.map((e) => e.descriptor.id).join(', ')}.`);
  }
  return engine.descriptor;
}

function buildPatch(opts: {
  engineId: string;
  presetId?: string | undefined;
  values?: Record<string, number> | undefined;
  fx?: Record<string, number> | undefined;
  magic?: Record<string, number> | undefined;
  name?: string | undefined;
  base?: Record<string, number> | undefined;
}): { patch: SerialisedPatch; warnings: string[] } {
  const d = engineOrDie(opts.engineId);
  const warnings: string[] = [];

  let start: Record<string, number>;
  if (opts.base !== undefined) {
    start = opts.base;
  } else if (opts.presetId !== undefined) {
    const preset = PRESETS.find((p) => p.id === opts.presetId);
    if (!preset) {
      bad(`No preset "${opts.presetId}". Call list_presets to see what exists.`);
    }
    if (preset.engineId !== d.id) {
      bad(`Preset "${preset.id}" is for engine "${preset.engineId}", not "${d.id}".`);
    }
    start = toKeyed(d, presetToValues(preset, d));
  } else {
    start = toKeyed(d, fromKeyed(d, undefined, d.name).values);
  }

  const merged = { ...start, ...(opts.values ?? {}) };
  const loaded = fromKeyed(d, merged, d.name);
  warnings.push(...loaded.warnings);

  let fx: Float32Array | undefined;
  if (opts.fx !== undefined) {
    const r = fromKeyed(FX_DESCRIPTOR, opts.fx, 'FX');
    fx = r.values;
    warnings.push(...r.warnings.filter((w) => !w.includes('not in the patch')));
  }
  let magic: Float32Array | undefined;
  if (opts.magic !== undefined) {
    const r = fromKeyed(FX_MAGIC_DESCRIPTOR, opts.magic, 'Character');
    magic = r.values;
    warnings.push(...r.warnings.filter((w) => !w.includes('not in the patch')));
  }

  const patch = serialisePatch({
    engine: d,
    values: loaded.values,
    ...(fx === undefined ? {} : { fxDescriptor: FX_DESCRIPTOR, fx }),
    ...(magic === undefined ? {} : { magicDescriptor: FX_MAGIC_DESCRIPTOR, magic }),
    ...(opts.name === undefined ? {} : { name: opts.name }),
  });
  return { patch, warnings };
}

export function createPatch(args: unknown): Promise<ToolResult> {
  return guard(() => {
    const o = rec(args);
    return buildPatch({
      engineId: str(o, 'engineId'),
      presetId: optStr(o, 'presetId'),
      values: keyedNumbers(o, 'values'),
      fx: keyedNumbers(o, 'fx'),
      magic: keyedNumbers(o, 'character') ?? keyedNumbers(o, 'magic'),
      name: optStr(o, 'name'),
    });
  });
}

export function modifyPatch(args: unknown): Promise<ToolResult> {
  return guard(() => {
    const o = rec(args);
    const existing = rec(o['patch'], '"patch"');
    const engineId = typeof existing['engineId'] === 'string' ? existing['engineId'] : '';
    if (engineId === '') bad('The "patch" argument has no engineId — pass a patch from create_patch.');
    const baseValues = keyedNumbers(existing, 'values') ?? {};
    const baseFx = keyedNumbers(existing, 'fx');
    const baseMagic = keyedNumbers(existing, 'magic');
    const fx = keyedNumbers(o, 'fx');
    const magic = keyedNumbers(o, 'character') ?? keyedNumbers(o, 'magic');
    return buildPatch({
      engineId,
      base: { ...baseValues, ...(keyedNumbers(o, 'values') ?? {}) },
      ...(fx === undefined && baseFx === undefined ? {} : { fx: { ...baseFx, ...fx } }),
      ...(magic === undefined && baseMagic === undefined ? {} : { magic: { ...baseMagic, ...magic } }),
      name: optStr(o, 'name') ?? (typeof existing['name'] === 'string' ? existing['name'] : undefined),
    });
  });
}

/* --------------------------------------------------------- progressions */

export interface ChordView {
  degree: number; label: string; quality: ChordQuality;
  notes: number[]; noteNames: string[]; startTick: number; durationTicks: number;
}

/**
 * A diatonic progression, built with src/dsp/chords.ts so every note is in the
 * scale by construction rather than by hope.
 */
export function generateProgression(args: unknown): Promise<ToolResult> {
  return guard(() => {
    const o = rec(args);
    const scale = oneOf(
      str(o, 'scale', 'minor'),
      Object.keys(SCALES) as ScaleName[],
      'Argument "scale"',
    );
    const root = readRoot(o, 'root', 0);
    const octave = num(o, 'octave', 0, 7, 3);
    const beatsPerBar = num(o, 'beatsPerBar', 1, 16, 4);
    const barsPerChord = num(o, 'barsPerChord', 0.25, 8, 1);
    const spread = num(o, 'spread', 0, 3, 0);
    const velocity = num(o, 'velocity', 0.05, 1, 0.8);
    const gate = num(o, 'gate', 0.05, 1, 0.95);
    const notesPerChord = Math.round(num(o, 'notesPerChord', 3, 5, 3));
    const rawDegrees = arr(o, 'degrees');
    if (rawDegrees.length === 0) bad('Argument "degrees" needs at least one scale degree.');
    if (rawDegrees.length > 32) bad('Argument "degrees" is limited to 32 chords.');

    const scaleLength = SCALES[scale].length;
    const rootMidi = root + (octave + 1) * 12;
    const barTicks = Math.round(beatsPerBar * PPQ);
    const chordTicks = Math.max(1, Math.round(barsPerChord * barTicks));
    const warnings: string[] = [];

    const chords: ChordView[] = rawDegrees.map((raw, index) => {
      const degree = parseDegree(raw);
      const start = (((degree - 1) % scaleLength) + scaleLength) % scaleLength;
      const pool = scaleNotes(rootMidi, scale, start + 2 * (notesPerChord - 1) + 1);
      const stacked: number[] = [];
      for (let i = 0; i < notesPerChord; i++) stacked.push(pool[start + 2 * i] ?? rootMidi);
      const named = diatonicChord(rootMidi, scale, start);
      const voiced = voiceChord(stacked, spread).filter((n) => {
        if (n >= 0 && n <= 127) return true;
        warnings.push(`Chord ${index + 1} lost a note that fell outside MIDI 0..127.`);
        return false;
      });
      return {
        degree,
        label: named.label,
        quality: named.quality,
        notes: voiced,
        noteNames: voiced.map(noteName),
        startTick: index * chordTicks,
        durationTicks: Math.max(1, Math.round(chordTicks * gate)),
      };
    });

    const notes: NoteRecord[] = [];
    chords.forEach((chord, ci) => {
      chord.notes.forEach((midi, ni) => {
        notes.push({
          id: `n${ci + 1}_${ni + 1}`,
          midi,
          velocity,
          startTick: chord.startTick,
          durationTicks: chord.durationTicks,
        });
      });
    });

    const totalTicks = chords.length * chordTicks;
    return {
      key: { root, scale, rootNote: noteName(rootMidi) },
      beatsPerBar,
      ppq: PPQ,
      lengthBars: Math.max(1, Math.ceil(totalTicks / barTicks)),
      chords,
      notes,
      warnings,
    };
  });
}

/* --------------------------------------------------------- arrangements */

function nowIso(): string { return new Date().toISOString(); }

async function loadArrangement(
  store: ArrangementStore, o: Record<string, unknown>,
): Promise<SerialisedArrangement> {
  const id = str(o, 'arrangementId');
  const found = await store.get(id);
  if (!found) bad(`No arrangement "${id}". Call list_arrangements or create_arrangement first.`);
  return found;
}

export function createArrangement(
  store: ArrangementStore, args: unknown,
): Promise<ToolResult> {
  return guard(async () => {
    const o = rec(args);
    const name = str(o, 'name');
    const scale = oneOf(
      str(o, 'scale', 'minor'), Object.keys(SCALES) as ScaleName[], 'Argument "scale"',
    );
    const existing = await store.list();
    const arrangement: SerialisedArrangement = {
      version: ARRANGEMENT_FORMAT_VERSION,
      id: uniqueId('arr_', name, existing.map((a) => a.id)),
      name,
      savedAt: nowIso(),
      tempo: {
        bpm: num(o, 'bpm', MIN_BPM, MAX_BPM, 100),
        beatsPerBar: Math.round(num(o, 'beatsPerBar', 1, 16, 4)),
        ppq: PPQ,
      },
      key: { root: readRoot(o, 'root', 0), scale },
      sections: [],
      tracks: [],
      patterns: {},
      clips: [],
    };

    const sections: SectionRecord[] = [];
    for (const raw of arr(o, 'sections', false)) {
      const s = rec(raw, 'each entry of "sections"');
      const sectionName = str(s, 'name');
      const section: SectionRecord = {
        id: uniqueId('sec_', sectionName, sections.map((x) => x.id)),
        name: sectionName,
        bars: Math.round(num(s, 'bars', 1, 64, 4)),
      };
      const repeats = optNum(s, 'repeats', 1, 32);
      if (repeats !== undefined) section.repeats = Math.round(repeats);
      sections.push(section);
    }
    const withSections = { ...arrangement, sections };
    await store.put(withSections);
    return { arrangementId: withSections.id, arrangement: withSections };
  });
}

export function addSection(store: ArrangementStore, args: unknown): Promise<ToolResult> {
  return guard(async () => {
    const o = rec(args);
    const a = await loadArrangement(store, o);
    const name = str(o, 'name');
    const section: SectionRecord = {
      id: uniqueId('sec_', name, a.sections.map((s) => s.id)),
      name,
      bars: Math.round(num(o, 'bars', 1, 64, 4)),
    };
    const repeats = optNum(o, 'repeats', 1, 32);
    if (repeats !== undefined) section.repeats = Math.round(repeats);

    const after = optStr(o, 'after');
    const sections = [...a.sections];
    if (after === undefined) {
      sections.push(section);
    } else {
      const at = sections.findIndex((s) => s.id === after);
      if (at < 0) bad(`No section "${after}" to place this one after.`);
      sections.splice(at + 1, 0, section);
    }
    const next = { ...a, sections, savedAt: nowIso() };
    await store.put(next);
    return { sectionId: section.id, sections: next.sections };
  });
}

export function addTrack(store: ArrangementStore, args: unknown): Promise<ToolResult> {
  return guard(async () => {
    const o = rec(args);
    const a = await loadArrangement(store, o);
    if (a.tracks.length >= MAX_TRACKS) {
      bad(`This arrangement already has ${MAX_TRACKS} tracks, which is the cap — each track is its own audio node and eight is what a phone renders in time.`);
    }
    const engineId = str(o, 'engineId');
    const descriptor = engineOrDie(engineId);
    if (engineId === 'sampler' && a.tracks.some((t) => t.engineId === 'sampler')) {
      bad('Only one sampler track is possible: the loaded sample is a module-level global shared by every voice node, so a second sampler track could not hold a different sample.');
    }
    const name = str(o, 'name');
    const track: TrackRecord = {
      id: uniqueId('track_', name, a.tracks.map((t) => t.id)),
      name,
      engineId,
      colour: descriptor.colour,
    };

    const presetId = optStr(o, 'presetId');
    const values = keyedNumbers(o, 'values');
    const fx = keyedNumbers(o, 'fx');
    const magic = keyedNumbers(o, 'character') ?? keyedNumbers(o, 'magic');
    const warnings: string[] = [];
    if (presetId !== undefined || values !== undefined || fx !== undefined || magic !== undefined) {
      const built = buildPatch({ engineId, presetId, values, fx, magic, name });
      track.patch = built.patch;
      warnings.push(...built.warnings);
      if (presetId !== undefined) track.presetId = presetId;
    }
    const gain = optNum(o, 'gain', 0, 1);
    track.gain = gain ?? 0.8;
    const pan = optNum(o, 'pan', -1, 1);
    if (pan !== undefined) track.pan = pan;
    const muted = bool(o, 'muted');
    if (muted !== undefined) track.muted = muted;
    const sampleRef = optStr(o, 'sampleRef');
    if (sampleRef !== undefined) track.sampleRef = sampleRef;

    const next = { ...a, tracks: [...a.tracks, track], savedAt: nowIso() };
    await store.put(next);
    return { trackId: track.id, track, warnings, remainingSlots: MAX_TRACKS - next.tracks.length };
  });
}

export function updateTrack(store: ArrangementStore, args: unknown): Promise<ToolResult> {
  return guard(async () => {
    const o = rec(args);
    const a = await loadArrangement(store, o);
    const trackId = str(o, 'trackId');
    const index = a.tracks.findIndex((t) => t.id === trackId);
    if (index < 0) bad(`No track "${trackId}" in "${a.id}".`);
    const current = a.tracks[index];
    if (current === undefined) bad(`No track "${trackId}" in "${a.id}".`);

    const track: TrackRecord = { ...current };
    const warnings: string[] = [];
    const name = optStr(o, 'name');
    if (name !== undefined) track.name = name;
    const gain = optNum(o, 'gain', 0, 1);
    if (gain !== undefined) track.gain = gain;
    const pan = optNum(o, 'pan', -1, 1);
    if (pan !== undefined) track.pan = pan;
    const muted = bool(o, 'muted');
    if (muted !== undefined) track.muted = muted;
    const soloed = bool(o, 'soloed');
    if (soloed !== undefined) track.soloed = soloed;

    const presetId = optStr(o, 'presetId');
    const values = keyedNumbers(o, 'values');
    if (presetId !== undefined || values !== undefined) {
      const base = presetId === undefined && track.patch !== undefined
        ? { ...track.patch.values }
        : undefined;
      const built = buildPatch({
        engineId: track.engineId,
        ...(base === undefined ? {} : { base: { ...base, ...(values ?? {}) } }),
        ...(base === undefined ? { presetId, values } : {}),
        name: track.name,
      });
      track.patch = built.patch;
      warnings.push(...built.warnings);
      if (presetId !== undefined) track.presetId = presetId;
    }

    const tracks = [...a.tracks];
    tracks[index] = track;
    const next = { ...a, tracks, savedAt: nowIso() };
    await store.put(next);
    return { track, warnings };
  });
}

/** One note from a model: MIDI or note name, ticks or bar/beat. */
function readNote(
  raw: unknown, index: number, beatsPerBar: number, patternTicks: number,
  warnings: string[],
): NoteRecord | null {
  const n = rec(raw, `note ${index + 1}`);
  let midi: number;
  if (typeof n['note'] === 'string') {
    const parsed = parseNoteName(n['note']);
    if (parsed === null) bad(`Note ${index + 1}: "${String(n['note'])}" is not a note name like "C3".`);
    midi = parsed;
  } else {
    midi = Math.round(num(n, 'midi', 0, 127));
  }

  const barTicks = beatsPerBar * PPQ;
  let startTick: number;
  if (n['startTick'] !== undefined) {
    startTick = Math.round(num(n, 'startTick', 0, 1_000_000));
  } else {
    const bar = num(n, 'bar', 1, 512, 1);
    const beat = num(n, 'beat', 1, beatsPerBar + 0.999, 1);
    startTick = Math.round((bar - 1) * barTicks + (beat - 1) * PPQ);
  }

  let durationTicks: number;
  if (n['durationTicks'] !== undefined) {
    durationTicks = Math.round(num(n, 'durationTicks', 1, 1_000_000));
  } else {
    durationTicks = Math.max(1, Math.round(num(n, 'durationBeats', 0.01, 512, 1) * PPQ));
  }

  if (startTick < 0 || startTick >= patternTicks) {
    warnings.push(
      `Note ${index + 1} starts at tick ${startTick}, outside this ${patternTicks}-tick pattern, and was dropped.`,
    );
    return null;
  }
  const velocity = num(n, 'velocity', 0, 1, 0.8);
  const pass = optNum(n, 'pass', 0, 64);
  return {
    id: typeof n['id'] === 'string' ? n['id'] : `n${index + 1}`,
    midi,
    velocity,
    startTick,
    durationTicks,
    ...(pass === undefined ? {} : { pass: Math.round(pass) }),
  };
}

/**
 * Place a clip in the cell (track × section). Cells, not tick offsets: a model
 * can verify `{track, section}` against the schema, and will confidently get
 * `startTick: 6144` wrong.
 */
export function addClip(store: ArrangementStore, args: unknown): Promise<ToolResult> {
  return guard(async () => {
    const o = rec(args);
    const a = await loadArrangement(store, o);
    const trackId = str(o, 'trackId');
    const track = a.tracks.find((t) => t.id === trackId);
    if (!track) {
      bad(`No track "${trackId}". This arrangement has: ${a.tracks.map((t) => t.id).join(', ') || '(none yet)'}.`);
    }
    const sectionId = str(o, 'sectionId');
    const section = a.sections.find((s) => s.id === sectionId);
    if (!section) {
      bad(`No section "${sectionId}". This arrangement has: ${a.sections.map((s) => s.id).join(', ') || '(none yet)'}.`);
    }

    const beatsPerBar = a.tempo.beatsPerBar;
    const warnings: string[] = [];
    const patterns: Record<string, PatternRecord> = { ...a.patterns };

    let patternId = optStr(o, 'patternId');
    if (patternId !== undefined) {
      if (patterns[patternId] === undefined) {
        bad(`No pattern "${patternId}". Omit patternId and pass "notes" to make one.`);
      }
    } else {
      const rawNotes = arr(o, 'notes');
      const lengthBars = Math.round(num(o, 'lengthBars', 1, 64, section.bars));
      const patternTicks = lengthBars * beatsPerBar * PPQ;
      const notes = rawNotes
        .map((raw, i) => readNote(raw, i, beatsPerBar, patternTicks, warnings))
        .filter((n): n is NoteRecord => n !== null)
        .sort((x, y) => (x.startTick - y.startTick) || (x.midi - y.midi));
      patternId = uniqueId('pat_', `${track.name}_${section.name}`, Object.keys(patterns));
      patterns[patternId] = {
        id: patternId,
        name: `${track.name} · ${section.name}`,
        lengthBars,
        beatsPerBar,
        ppq: PPQ,
        notes,
      };
    }

    const clip: ClipRecord = {
      id: uniqueId('clip_', `${track.name}_${section.name}`, a.clips.map((c) => c.id)),
      trackId,
      sectionId,
      patternId,
      fill: oneOf(str(o, 'fill', 'loop'), ['loop', 'once'] as const, 'Argument "fill"'),
    };
    const transpose = optNum(o, 'transpose', -24, 24);
    if (transpose !== undefined) clip.transpose = Math.round(transpose);
    const velocityScale = optNum(o, 'velocityScale', 0, 2);
    if (velocityScale !== undefined) clip.velocityScale = velocityScale;
    const muted = bool(o, 'muted');
    if (muted !== undefined) clip.muted = muted;

    // One clip per cell: placing into an occupied cell replaces it.
    const replaced = a.clips.find((c) => c.trackId === trackId && c.sectionId === sectionId);
    if (replaced !== undefined) {
      warnings.push(`Replaced the clip already in ${track.name} × ${section.name}.`);
    }
    const clips = [
      ...a.clips.filter((c) => !(c.trackId === trackId && c.sectionId === sectionId)),
      clip,
    ];
    const next = { ...a, patterns, clips, savedAt: nowIso() };
    await store.put(next);
    return { clipId: clip.id, patternId, clip, warnings };
  });
}

function summarise(a: SerialisedArrangement) {
  const barsPerSection = a.sections.map((s) => s.bars * (s.repeats ?? 1));
  const totalBars = barsPerSection.reduce((sum, b) => sum + b, 0);
  const beats = totalBars * a.tempo.beatsPerBar;
  const cell = (trackId: string, sectionId: string): string => {
    const clip = a.clips.find((c) => c.trackId === trackId && c.sectionId === sectionId);
    if (!clip) return '·';
    const pattern = a.patterns[clip.patternId];
    return pattern === undefined || pattern.notes.length === 0 ? '□' : '█';
  };
  const label = Math.max(7, ...a.tracks.map((t) => t.name.length));
  const col = a.sections.map((s) => Math.max(3, s.name.length));
  const line = (head: string, at: (sectionId: string) => string): string =>
    `${head.padEnd(label)} ${a.sections.map((s, i) => at(s.id).padEnd(col[i] ?? 3)).join(' ')}`.trimEnd();
  const header = line('SECTION', (id) => a.sections.find((s) => s.id === id)?.name ?? '');
  const rows = a.tracks.map((t) => line(t.name, (sectionId) => cell(t.id, sectionId)));
  return {
    totalBars,
    seconds: Number(((beats * 60) / a.tempo.bpm).toFixed(2)),
    trackCount: a.tracks.length,
    sectionCount: a.sections.length,
    clipCount: a.clips.length,
    emptyCells: a.tracks.length * a.sections.length - a.clips.length,
    grid: [header, ...rows],
  };
}

export function getArrangement(store: ArrangementStore, args: unknown): Promise<ToolResult> {
  return guard(async () => {
    const o = rec(args);
    const a = await loadArrangement(store, o);
    const full = o['includePatterns'] !== false;
    return {
      arrangement: full ? a : { ...a, patterns: {} },
      summary: summarise(a),
    };
  });
}

export function listArrangements(store: ArrangementStore): Promise<ToolResult> {
  return guard(async () => ({ arrangements: await store.list() }));
}
