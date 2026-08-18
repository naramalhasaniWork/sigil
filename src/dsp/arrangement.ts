import { PPQ, type SeqNote } from '@/dsp/sequencer';
import type { ScaleName } from '@/dsp/chords';
import type { SerialisedPatch } from '@/audio/patch-format';

/**
 * The arrangement model: sections left to right, tracks top to bottom, and a
 * clip in the cell where the two meet. No React, no DOM, no audio, no clock —
 * every function here is deterministic and returns new values, exactly like
 * sequencer.ts, so a whole song can be reasoned about without making a sound.
 *
 * Two rules the rest of the system leans on:
 *
 *  - Time is ticks at PPQ 96 and nothing else. Bars, beats and milliseconds are
 *    conversions that live at the edges. Two representations of time inside the
 *    model is how a compatible format becomes an incompatible one.
 *  - Cross-references are always by id, never by index, so inserting a track
 *    cannot silently re-point every clip. Section ORDER is the exception and it
 *    is array order: the order of `sections` IS the song, not a rendering hint.
 *    An `order` field would be a second source of truth, and the first time the
 *    two disagreed the song would play in an order nobody chose.
 */

export const MIN_BPM = 20;
export const MAX_BPM = 300;
/** Eight AudioWorkletNodes is ~92 MB of capture buffer. A cap, by design. */
export const MAX_TRACKS = 8;
/** `setActiveSample` is a worklet-global, so two samplers cannot differ. */
export const MAX_SAMPLER_TRACKS = 1;
export const MAX_SECTION_BARS = 64;
export const MAX_BEATS_PER_BAR = 16;
export const DEFAULT_TRACK_GAIN = 0.8;
export const DEFAULT_MASTER_GAIN = 0.9;
export const SAMPLER_ENGINE_ID = 'sampler';

export interface TempoSpec {
  /** 20..300, matching MIN_BPM/MAX_BPM in src/ui/use-sequencer.ts. */
  bpm: number;
  beatsPerBar: number;
  /** Must equal PPQ (96). Anything else is rescaled on load, with a warning. */
  ppq: number;
}

export interface KeySpec {
  /** Pitch class 0..11, the scale-picker convention. */
  root: number;
  scale: ScaleName;
}

/** Unknown fields written by a newer build, kept verbatim across load/save. */
export type Meta = Readonly<Record<string, unknown>>;

export interface SectionRecord {
  id: string;
  name: string;
  /** 1..64. */
  bars: number;
  /** Play the section this many times. Default 1. */
  repeats?: number;
  colour?: string;
  meta?: Meta;
}

export interface TrackRecord {
  id: string;
  name: string;
  /** An id from ENGINES in src/dsp/registry.ts. */
  engineId: string;
  /** The full sound — the same type a preset saves, not a parallel format. */
  patch?: SerialisedPatch;
  /** Alternative to `patch`: a PRESETS id. `patch` wins if both are present. */
  presetId?: string;
  /** 0..1, default 0.8. */
  gain?: number;
  /** -1..1, default 0. Stored now, honoured once voices are stereo. */
  pan?: number;
  muted?: boolean;
  soloed?: boolean;
  colour?: string;
  /** Sampler tracks: the sample's NAME only. Bytes never enter this file. */
  sampleRef?: string;
  meta?: Meta;
}

/** `SeqNote` plus an optional `pass`, so sequencer.ts needs no adapter. */
export interface NoteRecord {
  id: string;
  midi: number;
  velocity: number;
  /** Clip-local, in [0, patternTicks). */
  startTick: number;
  durationTicks: number;
  pass?: number;
  meta?: Meta;
}

export interface PatternRecord {
  id: string;
  name?: string;
  lengthBars: number;
  beatsPerBar: number;
  ppq: number;
  notes: readonly NoteRecord[];
  meta?: Meta;
}

export interface ClipRecord {
  id: string;
  trackId: string;
  sectionId: string;
  patternId: string;
  /** 'loop' fills the section (default); 'once' plays from the top and stops. */
  fill?: 'loop' | 'once';
  /** Semitones, -24..24. The one editing affordance the timeline gets. */
  transpose?: number;
  /** 0..2. */
  velocityScale?: number;
  muted?: boolean;
  meta?: Meta;
}

export interface MasterRecord {
  /** 0..1, default 0.9 to match EngineHost's master gain. */
  gain?: number;
  meta?: Meta;
}

export interface SerialisedArrangement {
  version: number;
  id: string;
  name: string;
  savedAt?: string;
  tempo: TempoSpec;
  key: KeySpec;
  sections: readonly SectionRecord[];
  tracks: readonly TrackRecord[];
  /** Keyed by pattern id so several clips can share one pattern. */
  patterns: Readonly<Record<string, PatternRecord>>;
  clips: readonly ClipRecord[];
  master?: MasterRecord;
  meta?: Meta;
}

/**
 * Runtime track. `unplayable` is a REASON, set by the loader when a track
 * cannot be given a voice (missing engine, past the track cap, second sampler).
 * The track and its clips survive regardless — dropping them would delete the
 * user's music to punish them for a build difference. It is never serialised.
 */
export interface Track extends TrackRecord {
  unplayable?: string;
}
export type Section = SectionRecord;
export type Clip = ClipRecord;

export interface Arrangement extends Omit<SerialisedArrangement, 'tracks'> {
  tracks: readonly Track[];
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return v < min ? min : v > max ? max : v;
}

function clampInt(v: number, min: number, max: number): number {
  return Math.round(clamp(v, min, max));
}

/**
 * Ids are human-readable slugs — `track_bass`, `sec_chorus`, `pat_bass_a` — and
 * never UUIDs. A language model composing through MCP can reference
 * `track_bass` three messages later; it cannot reference `a7f3c2e1-...`, and it
 * will invent one rather than admit that. Enforced here, at generation.
 */
export function slugId(prefix: string, name: string, taken: Iterable<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const stem = `${prefix}_${base === '' ? 'x' : base}`;
  const used = new Set(taken);
  if (!used.has(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function createArrangement(opts?: {
  id?: string;
  name?: string;
  tempo?: Partial<TempoSpec>;
  key?: Partial<KeySpec>;
  sections?: readonly SectionRecord[];
}): Arrangement {
  const name = opts?.name ?? 'Untitled';
  return {
    version: 1,
    id: opts?.id ?? slugId('song', name, []),
    name,
    tempo: {
      bpm: clamp(opts?.tempo?.bpm ?? 120, MIN_BPM, MAX_BPM),
      beatsPerBar: clampInt(opts?.tempo?.beatsPerBar ?? 4, 1, MAX_BEATS_PER_BAR),
      ppq: PPQ,
    },
    key: {
      root: clampInt(opts?.key?.root ?? 0, 0, 11),
      scale: opts?.key?.scale ?? 'minor',
    },
    sections: opts?.sections ?? [{ id: 'sec_a', name: 'A', bars: 4 }],
    tracks: [],
    patterns: {},
    clips: [],
  };
}

export type AddResult =
  | { ok: true; arrangement: Arrangement; id: string }
  | { ok: false; reason: string };

export function addTrack(a: Arrangement, spec: {
  name: string;
  engineId: string;
  patch?: SerialisedPatch;
  presetId?: string;
  gain?: number;
  pan?: number;
  colour?: string;
  sampleRef?: string;
}): AddResult {
  if (a.tracks.length >= MAX_TRACKS) {
    return { ok: false, reason: `${MAX_TRACKS} tracks is the limit on this build` };
  }
  const samplers = a.tracks.filter((t) => t.engineId === SAMPLER_ENGINE_ID).length;
  if (spec.engineId === SAMPLER_ENGINE_ID && samplers >= MAX_SAMPLER_TRACKS) {
    return { ok: false, reason: 'only one sampler track: every track shares one loaded sample' };
  }
  const id = slugId('track', spec.name, a.tracks.map((t) => t.id));
  const track: Track = { id, name: spec.name, engineId: spec.engineId };
  if (spec.patch !== undefined) track.patch = spec.patch;
  if (spec.presetId !== undefined) track.presetId = spec.presetId;
  if (spec.gain !== undefined) track.gain = clamp(spec.gain, 0, 1);
  if (spec.pan !== undefined) track.pan = clamp(spec.pan, -1, 1);
  if (spec.colour !== undefined) track.colour = spec.colour;
  if (spec.sampleRef !== undefined) track.sampleRef = spec.sampleRef;
  return { ok: true, arrangement: { ...a, tracks: [...a.tracks, track] }, id };
}

/** Removes the track and every clip on it. Patterns survive — they are shared. */
export function removeTrack(a: Arrangement, trackId: string): Arrangement {
  return {
    ...a,
    tracks: a.tracks.filter((t) => t.id !== trackId),
    clips: a.clips.filter((c) => c.trackId !== trackId),
  };
}

function mapTrack(a: Arrangement, id: string, fn: (t: Track) => Track): Arrangement {
  return { ...a, tracks: a.tracks.map((t) => (t.id === id ? fn(t) : t)) };
}

export function renameTrack(a: Arrangement, id: string, name: string): Arrangement {
  return mapTrack(a, id, (t) => ({ ...t, name }));
}

export function setTrackGain(a: Arrangement, id: string, gain: number): Arrangement {
  return mapTrack(a, id, (t) => ({ ...t, gain: clamp(gain, 0, 1) }));
}

export function setTrackPan(a: Arrangement, id: string, pan: number): Arrangement {
  return mapTrack(a, id, (t) => ({ ...t, pan: clamp(pan, -1, 1) }));
}

export function setTrackMuted(a: Arrangement, id: string, muted: boolean): Arrangement {
  return mapTrack(a, id, (t) => ({ ...t, muted }));
}

/** Solo is a radio, not a checkbox: soloing one track un-solos the rest. */
export function setSolo(a: Arrangement, id: string | null): Arrangement {
  return { ...a, tracks: a.tracks.map((t) => ({ ...t, soloed: t.id === id })) };
}

export function addSection(a: Arrangement, afterId: string | null, spec?: {
  name?: string; bars?: number; repeats?: number; colour?: string;
}): AddResult {
  const name = spec?.name ?? `Section ${a.sections.length + 1}`;
  const id = slugId('sec', name, a.sections.map((s) => s.id));
  const section: SectionRecord = {
    id,
    name,
    bars: clampInt(spec?.bars ?? 4, 1, MAX_SECTION_BARS),
  };
  if (spec?.repeats !== undefined) section.repeats = clampInt(spec.repeats, 1, MAX_SECTION_BARS);
  if (spec?.colour !== undefined) section.colour = spec.colour;
  const at = afterId === null ? -1 : a.sections.findIndex((s) => s.id === afterId);
  const sections = [...a.sections];
  sections.splice(at < 0 ? sections.length : at + 1, 0, section);
  return { ok: true, arrangement: { ...a, sections }, id };
}

export function editSection(
  a: Arrangement,
  id: string,
  patch: Partial<Omit<SectionRecord, 'id'>>,
): Arrangement {
  return {
    ...a,
    sections: a.sections.map((s) => {
      if (s.id !== id) return s;
      const next: SectionRecord = { ...s, ...patch };
      next.bars = clampInt(next.bars, 1, MAX_SECTION_BARS);
      if (next.repeats !== undefined) next.repeats = clampInt(next.repeats, 1, MAX_SECTION_BARS);
      return next;
    }),
  };
}

export function removeSection(a: Arrangement, id: string): Arrangement {
  return {
    ...a,
    sections: a.sections.filter((s) => s.id !== id),
    clips: a.clips.filter((c) => c.sectionId !== id),
  };
}

export function patternTicksOf(p: PatternRecord): number {
  return p.lengthBars * p.beatsPerBar * p.ppq;
}

/** Total order over notes, so the same inputs always emit the same array. */
function compareNotes(x: NoteRecord, y: NoteRecord): number {
  if (x.startTick !== y.startTick) return x.startTick - y.startTick;
  if (x.midi !== y.midi) return x.midi - y.midi;
  const px = x.pass ?? 0;
  const py = y.pass ?? 0;
  if (px !== py) return px - py;
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}

/**
 * Notes outside [0, patternTicks) are DROPPED, never re-homed, matching
 * setLengthBars in use-sequencer.ts: silently moving someone's notes somewhere
 * they did not play them is worse than losing them.
 */
export function normalisePatternNotes(
  p: PatternRecord,
  notes: readonly NoteRecord[],
): PatternRecord {
  const total = patternTicksOf(p);
  const kept = notes
    .filter((n) => Number.isFinite(n.startTick) && n.startTick >= 0 && n.startTick < total)
    .map((n) => ({ ...n, durationTicks: Math.max(1, Math.round(n.durationTicks)) }))
    .sort(compareNotes);
  return { ...p, notes: kept };
}

export function addPattern(a: Arrangement, spec?: {
  name?: string; lengthBars?: number; beatsPerBar?: number; notes?: readonly NoteRecord[];
}): AddResult {
  const name = spec?.name ?? 'Pattern';
  const id = slugId('pat', name, Object.keys(a.patterns));
  const pattern: PatternRecord = {
    id,
    lengthBars: clampInt(spec?.lengthBars ?? 1, 1, MAX_SECTION_BARS),
    beatsPerBar: clampInt(spec?.beatsPerBar ?? a.tempo.beatsPerBar, 1, MAX_BEATS_PER_BAR),
    ppq: PPQ,
    notes: [],
  };
  if (spec?.name !== undefined) pattern.name = spec.name;
  const filled = spec?.notes === undefined
    ? pattern
    : normalisePatternNotes(pattern, spec.notes);
  return { ok: true, arrangement: { ...a, patterns: { ...a.patterns, [id]: filled } }, id };
}

export function setPatternNotes(
  a: Arrangement,
  patternId: string,
  notes: readonly NoteRecord[],
): Arrangement {
  const p = a.patterns[patternId];
  if (p === undefined) return a;
  return { ...a, patterns: { ...a.patterns, [patternId]: normalisePatternNotes(p, notes) } };
}

/** SeqNote is NoteRecord with `pass` required — the sequencer needs no adapter. */
export function toSeqNotes(p: PatternRecord): SeqNote[] {
  return p.notes.map((n) => ({ ...n, pass: n.pass ?? 0 }));
}

export function placeClip(
  a: Arrangement,
  trackId: string,
  sectionId: string,
  patternId: string,
  spec?: { fill?: 'loop' | 'once'; transpose?: number; velocityScale?: number },
): AddResult {
  if (!a.tracks.some((t) => t.id === trackId)) return { ok: false, reason: 'no such track' };
  if (!a.sections.some((s) => s.id === sectionId)) return { ok: false, reason: 'no such section' };
  if (a.patterns[patternId] === undefined) return { ok: false, reason: 'no such pattern' };
  const cleared = clearCell(a, trackId, sectionId);
  const id = slugId('clip', `${trackId}_${sectionId}`, a.clips.map((c) => c.id));
  const clip: ClipRecord = { id, trackId, sectionId, patternId };
  if (spec?.fill !== undefined) clip.fill = spec.fill;
  if (spec?.transpose !== undefined) clip.transpose = clampInt(spec.transpose, -24, 24);
  if (spec?.velocityScale !== undefined) clip.velocityScale = clamp(spec.velocityScale, 0, 2);
  return { ok: true, arrangement: { ...cleared, clips: [...cleared.clips, clip] }, id };
}

/** Moving onto an occupied cell replaces what was there — one clip per cell. */
export function moveClip(
  a: Arrangement,
  clipId: string,
  toTrackId: string,
  toSectionId: string,
): Arrangement {
  if (!a.clips.some((c) => c.id === clipId)) return a;
  if (!a.tracks.some((t) => t.id === toTrackId)) return a;
  if (!a.sections.some((s) => s.id === toSectionId)) return a;
  const cleared = clearCell(a, toTrackId, toSectionId);
  return {
    ...cleared,
    clips: cleared.clips.map((c) => (
      c.id === clipId ? { ...c, trackId: toTrackId, sectionId: toSectionId } : c
    )),
  };
}

export function clearCell(a: Arrangement, trackId: string, sectionId: string): Arrangement {
  const clips = a.clips.filter((c) => !(c.trackId === trackId && c.sectionId === sectionId));
  return clips.length === a.clips.length ? a : { ...a, clips };
}

export function setClipTranspose(a: Arrangement, clipId: string, semitones: number): Arrangement {
  return {
    ...a,
    clips: a.clips.map((c) => (
      c.id === clipId ? { ...c, transpose: clampInt(semitones, -24, 24) } : c
    )),
  };
}

/**
 * Trim a clip to `lengthBars`. A clip has no length of its own — it plays its
 * pattern — so trimming trims the pattern, and because patterns are SHARED the
 * pattern is forked first if any other clip uses it. Otherwise dragging one
 * clip's edge would shorten a part elsewhere in the song, which is the kind of
 * spooky action that makes people stop trusting a timeline.
 *
 * A trim to zero or a negative length cannot produce a negative-length pattern:
 * the length floors at one bar. Notes past the new end are dropped, not moved.
 */
export function trimClip(a: Arrangement, clipId: string, lengthBars: number): Arrangement {
  const clip = a.clips.find((c) => c.id === clipId);
  if (clip === undefined) return a;
  const pattern = a.patterns[clip.patternId];
  if (pattern === undefined) return a;
  const bars = clampInt(lengthBars, 1, MAX_SECTION_BARS);
  const shared = a.clips.some((c) => c.id !== clipId && c.patternId === clip.patternId);
  const id = shared ? slugId('pat', `${pattern.id}_trim`, Object.keys(a.patterns)) : pattern.id;
  const trimmed = normalisePatternNotes({ ...pattern, id, lengthBars: bars }, pattern.notes);
  return {
    ...a,
    patterns: { ...a.patterns, [id]: trimmed },
    clips: shared ? a.clips.map((c) => (c.id === clipId ? { ...c, patternId: id } : c)) : a.clips,
  };
}

export function setTempo(a: Arrangement, bpm: number): Arrangement {
  return { ...a, tempo: { ...a.tempo, bpm: clamp(bpm, MIN_BPM, MAX_BPM) } };
}

export function setBeatsPerBar(a: Arrangement, beats: number): Arrangement {
  return { ...a, tempo: { ...a.tempo, beatsPerBar: clampInt(beats, 1, MAX_BEATS_PER_BAR) } };
}

export function setKey(a: Arrangement, root: number, scale: ScaleName): Arrangement {
  return { ...a, key: { root: clampInt(root, 0, 11), scale } };
}

export interface SectionOccurrence {
  sectionId: string;
  /** 0-based repeat index within the section. */
  occurrence: number;
  startTick: number;
  endTick: number;
}

export function sectionTicks(a: Arrangement, section: Section): number {
  return section.bars * a.tempo.beatsPerBar * a.tempo.ppq;
}

/** Every pass of every section, in song order, with `repeats` expanded. */
export function sectionOccurrences(a: Arrangement): SectionOccurrence[] {
  const out: SectionOccurrence[] = [];
  let cursor = 0;
  for (const section of a.sections) {
    const span = sectionTicks(a, section);
    const repeats = Math.max(1, Math.floor(section.repeats ?? 1));
    for (let i = 0; i < repeats; i += 1) {
      out.push({ sectionId: section.id, occurrence: i, startTick: cursor, endTick: cursor + span });
      cursor += span;
    }
  }
  return out;
}

export function arrangementTotalTicks(a: Arrangement): number {
  return a.sections.reduce(
    (sum, s) => sum + sectionTicks(a, s) * Math.max(1, Math.floor(s.repeats ?? 1)),
    0,
  );
}

export interface TickPosition {
  sectionId: string;
  occurrence: number;
  /** Tick offset inside this pass of the section. */
  sectionLocalTick: number;
  /** 1-indexed, the way a transport display counts. */
  bar: number;
  beat: number;
}

/** Null past the end of the song — the caller decides whether to stop or wrap. */
export function locateTick(a: Arrangement, absTick: number): TickPosition | null {
  if (absTick < 0) return null;
  const perBar = a.tempo.beatsPerBar * a.tempo.ppq;
  for (const occ of sectionOccurrences(a)) {
    if (absTick >= occ.endTick) continue;
    const local = absTick - occ.startTick;
    return {
      sectionId: occ.sectionId,
      occurrence: occ.occurrence,
      sectionLocalTick: local,
      bar: Math.floor(local / perBar) + 1,
      beat: Math.floor((local % perBar) / a.tempo.ppq) + 1,
    };
  }
  return null;
}

/**
 * Where `absTick` falls inside a clip's pattern, or null if the clip is not
 * sounding then — outside its section, or past the end of a 'once' clip.
 */
export function clipLocalTick(a: Arrangement, clipId: string, absTick: number): number | null {
  const clip = a.clips.find((c) => c.id === clipId);
  if (clip === undefined) return null;
  const pattern = a.patterns[clip.patternId];
  if (pattern === undefined) return null;
  const total = patternTicksOf(pattern);
  if (total <= 0) return null;
  for (const occ of sectionOccurrences(a)) {
    if (occ.sectionId !== clip.sectionId) continue;
    if (absTick < occ.startTick || absTick >= occ.endTick) continue;
    const local = absTick - occ.startTick;
    if (clip.fill === 'once') return local < total ? local : null;
    return local % total;
  }
  return null;
}

export interface ArrangementIndex {
  trackById: ReadonlyMap<string, Track>;
  sectionById: ReadonlyMap<string, Section>;
  patternById: ReadonlyMap<string, PatternRecord>;
  clipById: ReadonlyMap<string, Clip>;
  cellAt: (trackId: string, sectionId: string) => Clip | null;
  /** Where each section FIRST begins, with earlier repeats counted. */
  sectionStartTick: ReadonlyMap<string, number>;
  occurrences: readonly SectionOccurrence[];
  totalTicks: number;
}

/** Runtime only. Built once per change, never serialised. */
export function indexArrangement(a: Arrangement): ArrangementIndex {
  const occurrences = sectionOccurrences(a);
  const sectionStartTick = new Map<string, number>();
  for (const occ of occurrences) {
    if (!sectionStartTick.has(occ.sectionId)) sectionStartTick.set(occ.sectionId, occ.startTick);
  }
  const cells = new Map<string, Clip>();
  for (const clip of a.clips) {
    const key = `${clip.trackId} ${clip.sectionId}`;
    if (!cells.has(key)) cells.set(key, clip);
  }
  return {
    trackById: new Map(a.tracks.map((t) => [t.id, t])),
    sectionById: new Map(a.sections.map((s) => [s.id, s])),
    patternById: new Map(Object.entries(a.patterns)),
    clipById: new Map(a.clips.map((c) => [c.id, c])),
    cellAt: (trackId, sectionId) => cells.get(`${trackId} ${sectionId}`) ?? null,
    sectionStartTick,
    occurrences,
    totalTicks: arrangementTotalTicks(a),
  };
}

export interface ArrangementEvent {
  /** Absolute tick on the caller's timeline, already unwrapped past a loop. */
  absTick: number;
  trackId: string;
  clipId: string;
  patternId: string;
  noteId: string;
  midi: number;
  velocity: number;
  durationTicks: number;
}

function compareEvents(x: ArrangementEvent, y: ArrangementEvent): number {
  if (x.absTick !== y.absTick) return x.absTick - y.absTick;
  if (x.trackId !== y.trackId) return x.trackId < y.trackId ? -1 : 1;
  if (x.midi !== y.midi) return x.midi - y.midi;
  if (x.clipId !== y.clipId) return x.clipId < y.clipId ? -1 : 1;
  return x.noteId < y.noteId ? -1 : x.noteId > y.noteId ? 1 : 0;
}

function collect(
  a: Arrangement,
  from: number,
  to: number,
  offset: number,
  out: ArrangementEvent[],
): void {
  const soloing = a.tracks.some((t) => t.soloed === true);
  const trackById = new Map(a.tracks.map((t) => [t.id, t]));
  for (const occ of sectionOccurrences(a)) {
    if (occ.endTick <= from || occ.startTick >= to) continue;
    const winFrom = Math.max(from, occ.startTick);
    const winTo = Math.min(to, occ.endTick);
    for (const clip of a.clips) {
      if (clip.sectionId !== occ.sectionId || clip.muted === true) continue;
      const track = trackById.get(clip.trackId);
      if (track === undefined || track.muted === true || track.unplayable !== undefined) continue;
      if (soloing && track.soloed !== true) continue;
      const pattern = a.patterns[clip.patternId];
      if (pattern === undefined) continue;
      const span = patternTicksOf(pattern);
      if (span <= 0) continue;
      const once = clip.fill === 'once';
      const first = once ? 0 : Math.max(0, Math.floor((winFrom - occ.startTick) / span));
      const last = once ? 1 : Math.ceil((winTo - occ.startTick) / span);
      const shift = clip.transpose ?? 0;
      const scale = clip.velocityScale ?? 1;
      for (let rep = first; rep < last; rep += 1) {
        const base = occ.startTick + rep * span;
        if (base >= winTo) break;
        for (const note of pattern.notes) {
          const abs = base + note.startTick;
          if (abs < winFrom || abs >= winTo) continue;
          const midi = note.midi + shift;
          // A note transposed off the keyboard is dropped, not folded back —
          // folding would sound a note the composer never wrote.
          if (midi < 0 || midi > 127) continue;
          out.push({
            absTick: offset + abs,
            trackId: clip.trackId,
            clipId: clip.id,
            patternId: pattern.id,
            noteId: note.id,
            midi,
            velocity: clamp(note.velocity * scale, 0, 1),
            durationTicks: note.durationTicks,
          });
        }
      }
    }
  }
}

/**
 * Every note that STARTS in the half-open window [fromTick, toTick), across
 * every track, ready for a transport to turn into wall-clock times. This is the
 * one function song playback leans on: get it wrong and a note at a section
 * boundary is dropped once per pass, which is exactly the failure that "feels
 * off" without ever looking broken.
 *
 * With `loop`, the window wraps at the end of the arrangement and the returned
 * `absTick`s stay on the caller's unwrapped timeline — a note at song tick 3
 * seen from a window that starts near the end comes back as next lap, not as
 * ancient history. A window longer than the song yields each note at most once.
 *
 * Muted tracks and muted clips are silent; if any track is soloed, only soloed
 * tracks sound. Unplayable tracks (no engine on this build) are silent too.
 */
export function resolveWindow(
  a: Arrangement,
  fromTick: number,
  toTick: number,
  opts?: { loop?: boolean },
): ArrangementEvent[] {
  const total = arrangementTotalTicks(a);
  const out: ArrangementEvent[] = [];
  if (total <= 0 || !(toTick > fromTick)) return out;
  if (opts?.loop !== true) {
    const from = Math.max(0, fromTick);
    const to = Math.min(toTick, total);
    if (to > from) collect(a, from, to, 0, out);
  } else {
    const end = Math.min(toTick, fromTick + total);
    let cursor = fromTick;
    while (cursor < end) {
      const lap = Math.floor(cursor / total) * total;
      const segEnd = Math.min(end, lap + total);
      collect(a, cursor - lap, segEnd - lap, lap, out);
      cursor = segEnd;
    }
  }
  out.sort(compareEvents);
  return out;
}
