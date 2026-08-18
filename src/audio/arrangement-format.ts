import { PPQ } from '@/dsp/sequencer';
import { SCALES, type ScaleName } from '@/dsp/chords';
import { engineById, DEFAULT_ENGINE_ID } from '@/dsp/registry';
import { PRESETS } from '@/dsp/presets';
import { FX_DESCRIPTOR } from '@/dsp/fx-descriptor';
import { FX_MAGIC_DESCRIPTOR } from '@/dsp/fx-magic-descriptor';
import { loadPatch, type SerialisedPatch } from '@/audio/patch-format';
import {
  MAX_BEATS_PER_BAR, MAX_BPM, MAX_SAMPLER_TRACKS, MAX_SECTION_BARS, MAX_TRACKS, MIN_BPM,
  SAMPLER_ENGINE_ID, normalisePatternNotes, patternTicksOf,
} from '@/dsp/arrangement';
import type {
  Arrangement, ClipRecord, KeySpec, Meta, NoteRecord, PatternRecord, SectionRecord,
  SerialisedArrangement, TempoSpec, Track, TrackRecord, MasterRecord,
} from '@/dsp/arrangement';

export type {
  Arrangement, ClipRecord, KeySpec, MasterRecord, Meta, NoteRecord, PatternRecord,
  SectionRecord, SerialisedArrangement, TempoSpec, Track, TrackRecord,
} from '@/dsp/arrangement';

/**
 * The saved-song format, following src/audio/patch-format.ts exactly: keyed
 * rather than positional, versioned, unknown things reported rather than
 * silently eaten, missing things defaulted, numbers clamped to their range, and
 * every single recovery pushed onto `warnings` where somebody can see it.
 *
 * It goes one step FURTHER than patch-format in one place, deliberately. That
 * module ignores unknown parameter ids: losing one unknown knob is survivable.
 * Losing an unknown TRACK is not — you would open a friend's song in an older
 * build, save it, and hand back a shorter piece of music. So here the rule is
 * preserve-and-warn, not ignore-and-warn: unknown fields are parked verbatim in
 * `meta`, unknown entities are kept and flagged, and clips that cannot attach
 * are quarantined rather than deleted. A load->save round trip of a file this
 * build does not fully understand must lose nothing.
 *
 * Everything here is plain JSON: no Float32Array, no Blob, no sample bytes, no
 * browser types, real parameter units, deterministic ordering so two saves of
 * one song produce identical text and files diff cleanly. This is one of the
 * files that has to port to C++ when SIGIL becomes a plugin.
 */
export const ARRANGEMENT_FORMAT_VERSION = 1;

export interface ArrangementLoadResult {
  arrangement: Arrangement;
  /** Every recovery, in the order it happened. Surfaced, never swallowed. */
  warnings: string[];
  /** Entities that could not attach, kept verbatim so a re-save loses nothing. */
  quarantined: readonly unknown[];
}

const TOP_KEYS = [
  'version', 'id', 'name', 'savedAt', 'tempo', 'key', 'sections', 'tracks',
  'patterns', 'clips', 'master', 'meta',
] as const;
const SECTION_KEYS = ['id', 'name', 'bars', 'repeats', 'colour', 'meta'] as const;
const TRACK_KEYS = [
  'id', 'name', 'engineId', 'patch', 'presetId', 'gain', 'pan', 'muted', 'soloed',
  'colour', 'sampleRef', 'meta',
] as const;
const PATTERN_KEYS = ['id', 'name', 'lengthBars', 'beatsPerBar', 'ppq', 'notes', 'meta'] as const;
const NOTE_KEYS = ['id', 'midi', 'velocity', 'startTick', 'durationTicks', 'pass', 'meta'] as const;
const MASTER_KEYS = ['gain', 'meta'] as const;
const CLIP_KEYS = [
  'id', 'trackId', 'sectionId', 'patternId', 'fill', 'transpose', 'velocityScale', 'muted', 'meta',
] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return v < min ? min : v > max ? max : v;
}

/** A required number: missing or unusable falls back, out of range clamps. */
function reqNum(
  o: Record<string, unknown>, key: string, min: number, max: number,
  fallback: number, label: string, w: string[],
): number {
  const raw = o[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    w.push(`${label}: no ${key}, using ${fallback}`);
    return fallback;
  }
  const fixed = clamp(raw, min, max);
  if (fixed !== raw) w.push(`${label}: ${key} ${raw} is out of range, clamped to ${fixed}`);
  return fixed;
}

/** An optional number: absent stays absent, present is clamped and reported. */
function optNum(
  o: Record<string, unknown>, key: string, min: number, max: number,
  label: string, w: string[],
): number | undefined {
  const raw = o[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    w.push(`${label}: ${key} is not a number, ignored`);
    return undefined;
  }
  const fixed = clamp(raw, min, max);
  if (fixed !== raw) w.push(`${label}: ${key} ${raw} is out of range, clamped to ${fixed}`);
  return fixed;
}

function reqStr(
  o: Record<string, unknown>, key: string, fallback: string, label: string, w: string[],
): string {
  const raw = o[key];
  if (typeof raw === 'string' && raw !== '') return raw;
  w.push(`${label}: no ${key}, using "${fallback}"`);
  return fallback;
}

function optStr(o: Record<string, unknown>, key: string): string | undefined {
  const raw = o[key];
  return typeof raw === 'string' ? raw : undefined;
}

function optBool(o: Record<string, unknown>, key: string): boolean | undefined {
  const raw = o[key];
  return typeof raw === 'boolean' ? raw : undefined;
}

/**
 * Anything this build does not recognise, kept verbatim. It is warned about
 * (so it is never a silent mystery) and preserved (so it is never a silent
 * loss). An entity's own `meta` is folded in, which makes the operation
 * idempotent: a second load of a saved file produces exactly the same `meta`.
 */
function collectUnknown(
  o: Record<string, unknown>, known: readonly string[],
): Meta | undefined {
  const out: Record<string, unknown> = {};
  const own = o['meta'];
  if (isObj(own)) Object.assign(out, own);
  for (const k of Object.keys(o)) {
    if (!known.includes(k)) out[k] = o[k];
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function keepUnknown(
  o: Record<string, unknown>, known: readonly string[], label: string, w: string[],
): Meta | undefined {
  const strays = Object.keys(o).filter((k) => !known.includes(k));
  if (strays.length > 0) {
    w.push(`${label}: kept ${strays.length} unknown field(s) written by a newer build`);
  }
  return collectUnknown(o, known);
}

/** First wins; a later duplicate is renamed rather than overwriting the first. */
function uniqueId(id: string, seen: Set<string>, label: string, w: string[]): string {
  if (!seen.has(id)) { seen.add(id); return id; }
  for (let n = 2; ; n += 1) {
    const candidate = `${id}__${n}`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      w.push(`${label}: duplicate id "${id}", renamed to "${candidate}"`);
      return candidate;
    }
  }
}

function loadTempo(raw: unknown, w: string[]): TempoSpec {
  if (!isObj(raw)) {
    w.push('Tempo: missing, using 120bpm 4/4');
    return { bpm: 120, beatsPerBar: 4, ppq: PPQ };
  }
  const bpm = reqNum(raw, 'bpm', MIN_BPM, MAX_BPM, 120, 'Tempo', w);
  const beatsPerBar = Math.round(reqNum(raw, 'beatsPerBar', 1, MAX_BEATS_PER_BAR, 4, 'Tempo', w));
  const ppq = typeof raw['ppq'] === 'number' ? raw['ppq'] : PPQ;
  if (ppq !== PPQ) {
    w.push(`Tempo: ppq ${ppq} is not ${PPQ}; ticks are stored at ${PPQ} and were rescaled`);
  }
  return { bpm, beatsPerBar, ppq: PPQ };
}

function loadKey(raw: unknown, w: string[]): KeySpec {
  if (!isObj(raw)) {
    w.push('Key: missing, using C minor');
    return { root: 0, scale: 'minor' };
  }
  const root = Math.round(reqNum(raw, 'root', 0, 11, 0, 'Key', w));
  const scale = raw['scale'];
  if (typeof scale === 'string' && Object.prototype.hasOwnProperty.call(SCALES, scale)) {
    return { root, scale: scale as ScaleName };
  }
  w.push(`Key: unknown scale "${String(scale)}", using minor`);
  return { root, scale: 'minor' };
}

function loadSection(
  raw: unknown, index: number, seen: Set<string>, w: string[],
): SectionRecord | null {
  if (!isObj(raw)) return null;
  const label = `Section ${index + 1}`;
  const id = uniqueId(reqStr(raw, 'id', `sec_${index + 1}`, label, w), seen, label, w);
  const out: SectionRecord = {
    id,
    name: reqStr(raw, 'name', `Section ${index + 1}`, label, w),
    bars: Math.round(reqNum(raw, 'bars', 1, MAX_SECTION_BARS, 4, label, w)),
  };
  const repeats = optNum(raw, 'repeats', 1, MAX_SECTION_BARS, label, w);
  if (repeats !== undefined) out.repeats = Math.round(repeats);
  const colour = optStr(raw, 'colour');
  if (colour !== undefined) out.colour = colour;
  const meta = keepUnknown(raw, SECTION_KEYS, label, w);
  if (meta !== undefined) out.meta = meta;
  return out;
}

/** The patch body is handed to loadPatch verbatim, its warnings re-emitted. */
function checkPatch(patch: unknown, engineId: string, label: string, w: string[]): void {
  const engine = engineById(engineId);
  if (engine === undefined || !isObj(patch)) return;
  const result = loadPatch(patch, engine.descriptor, FX_DESCRIPTOR, FX_MAGIC_DESCRIPTOR);
  if (result === null) {
    w.push(`${label}: patch could not be read, the engine's defaults will be used`);
    return;
  }
  for (const warning of result.warnings) w.push(`${label}: ${warning}`);
}

function loadTrack(
  raw: unknown, index: number, seen: Set<string>, samplers: { count: number }, w: string[],
): Track | null {
  if (!isObj(raw)) return null;
  const label = `Track ${index + 1}`;
  const id = uniqueId(reqStr(raw, 'id', `track_${index + 1}`, label, w), seen, label, w);
  const engineId = reqStr(raw, 'engineId', DEFAULT_ENGINE_ID, label, w);
  const out: Track = { id, name: reqStr(raw, 'name', id, label, w), engineId };
  const name = out.name;

  if (engineById(engineId) === undefined) {
    // Kept, not dropped: deleting the track would delete the user's music to
    // punish them for an engine this build happens not to have.
    out.unplayable = `unknown engine "${engineId}"`;
    w.push(`${name}: unknown engine "${engineId}"; the track is kept but cannot play`);
  } else if (index >= MAX_TRACKS) {
    out.unplayable = `past the ${MAX_TRACKS}-track limit`;
    w.push(`${name}: past the ${MAX_TRACKS}-track limit; kept but cannot play`);
  } else if (engineId === SAMPLER_ENGINE_ID) {
    samplers.count += 1;
    if (samplers.count > MAX_SAMPLER_TRACKS) {
      out.unplayable = 'only one sampler track: every track shares one loaded sample';
      w.push(`${name}: a second sampler track cannot hold its own sample; kept but cannot play`);
    }
  }

  const patch = raw['patch'];
  if (isObj(patch)) {
    out.patch = patch as unknown as SerialisedPatch;
    checkPatch(patch, engineId, name, w);
  }
  const presetId = optStr(raw, 'presetId');
  if (presetId !== undefined) {
    out.presetId = presetId;
    if (!PRESETS.some((p) => p.id === presetId)) {
      w.push(`${name}: preset "${presetId}" is not in this build, using engine defaults`);
    }
  }
  if (out.patch === undefined && out.presetId === undefined && out.unplayable === undefined) {
    w.push(`${name}: no patch and no presetId, using engine defaults`);
  }
  const gain = optNum(raw, 'gain', 0, 1, name, w);
  if (gain !== undefined) out.gain = gain;
  const pan = optNum(raw, 'pan', -1, 1, name, w);
  if (pan !== undefined) out.pan = pan;
  const muted = optBool(raw, 'muted');
  if (muted !== undefined) out.muted = muted;
  const soloed = optBool(raw, 'soloed');
  if (soloed !== undefined) out.soloed = soloed;
  const colour = optStr(raw, 'colour');
  if (colour !== undefined) out.colour = colour;
  const sampleRef = optStr(raw, 'sampleRef');
  if (sampleRef !== undefined) out.sampleRef = sampleRef;
  const meta = keepUnknown(raw, TRACK_KEYS, name, w);
  if (meta !== undefined) out.meta = meta;
  return out;
}

function loadNotes(
  raw: unknown, pattern: PatternRecord, scale: number, label: string, w: string[],
): NoteRecord[] {
  if (!Array.isArray(raw)) return [];
  const total = patternTicksOf(pattern);
  const seen = new Set<string>();
  const out: NoteRecord[] = [];
  let dropped = 0;
  let strange = 0;
  raw.forEach((entry, i) => {
    if (!isObj(entry)) { dropped += 1; return; }
    const start = Math.round(clamp(Number(entry['startTick'] ?? -1), -1, Number.MAX_SAFE_INTEGER)
      * scale);
    // Out of the pattern means dropped, never re-homed — the same call
    // setLengthBars makes in use-sequencer.ts, for the same reason.
    if (!(start >= 0) || start >= total) { dropped += 1; return; }
    const note: NoteRecord = {
      id: uniqueId(reqStr(entry, 'id', `${pattern.id}_n${i}`, label, w), seen, label, w),
      midi: Math.round(reqNum(entry, 'midi', 0, 127, 60, label, w)),
      velocity: reqNum(entry, 'velocity', 0, 1, 0.8, label, w),
      startTick: start,
      durationTicks: Math.max(
        1,
        Math.round(reqNum(entry, 'durationTicks', 1, total, PPQ, label, w) * scale),
      ),
    };
    const pass = optNum(entry, 'pass', 0, 1024, label, w);
    if (pass !== undefined) note.pass = Math.round(pass);
    // Notes are the one entity numerous enough that a warning each would bury
    // everything else, so unknown fields are counted here and reported once.
    const meta = collectUnknown(entry, NOTE_KEYS);
    if (meta !== undefined) { note.meta = meta; strange += 1; }
    out.push(note);
  });
  if (dropped > 0) w.push(`${label}: dropped ${dropped} note(s) outside the pattern`);
  if (strange > 0) {
    w.push(`${label}: kept unknown field(s) on ${strange} note(s) written by a newer build`);
  }
  return out;
}

function loadPattern(key: string, raw: unknown, w: string[]): PatternRecord | null {
  if (!isObj(raw)) return null;
  const label = `Pattern ${key}`;
  const bodyId = optStr(raw, 'id');
  if (bodyId !== undefined && bodyId !== key) {
    w.push(`${label}: id "${bodyId}" disagrees with its key, the key wins`);
  }
  const ppq = typeof raw['ppq'] === 'number' && raw['ppq'] > 0 ? raw['ppq'] : PPQ;
  const scale = PPQ / ppq;
  if (ppq !== PPQ) w.push(`${label}: ppq ${ppq} rescaled to ${PPQ}`);
  const shell: PatternRecord = {
    id: key,
    lengthBars: Math.round(reqNum(raw, 'lengthBars', 1, MAX_SECTION_BARS, 1, label, w)),
    beatsPerBar: Math.round(reqNum(raw, 'beatsPerBar', 1, MAX_BEATS_PER_BAR, 4, label, w)),
    ppq: PPQ,
    notes: [],
  };
  const out = normalisePatternNotes(shell, loadNotes(raw['notes'], shell, scale, label, w));
  const name = optStr(raw, 'name');
  if (name !== undefined) out.name = name;
  const meta = keepUnknown(raw, PATTERN_KEYS, label, w);
  if (meta !== undefined) out.meta = meta;
  return out;
}

function loadClip(
  raw: unknown, index: number, seen: Set<string>, w: string[],
): ClipRecord | null {
  if (!isObj(raw)) return null;
  const label = `Clip ${index + 1}`;
  const out: ClipRecord = {
    id: uniqueId(reqStr(raw, 'id', `clip_${index + 1}`, label, w), seen, label, w),
    trackId: reqStr(raw, 'trackId', '', label, w),
    sectionId: reqStr(raw, 'sectionId', '', label, w),
    patternId: reqStr(raw, 'patternId', '', label, w),
  };
  const fill = raw['fill'];
  if (fill !== undefined) {
    if (fill === 'loop' || fill === 'once') out.fill = fill;
    else w.push(`${label}: unknown fill "${String(fill)}", using loop`);
  }
  const transpose = optNum(raw, 'transpose', -24, 24, label, w);
  if (transpose !== undefined) out.transpose = Math.round(transpose);
  const velocityScale = optNum(raw, 'velocityScale', 0, 2, label, w);
  if (velocityScale !== undefined) out.velocityScale = velocityScale;
  const muted = optBool(raw, 'muted');
  if (muted !== undefined) out.muted = muted;
  const meta = keepUnknown(raw, CLIP_KEYS, label, w);
  if (meta !== undefined) out.meta = meta;
  return out;
}

/**
 * Reads anything that might be an arrangement. Deliberately tolerant, for the
 * same reasons loadPatch is: this runs against localStorage, files a user may
 * have hand-edited, songs written by a newer build, and one day whatever a
 * plugin host hands back. Returns null only when `raw` is not an object at all.
 */
export function loadArrangement(raw: unknown): ArrangementLoadResult | null {
  if (!isObj(raw)) return null;
  const w: string[] = [];
  const quarantined: unknown[] = [];

  const version = typeof raw['version'] === 'number' ? raw['version'] : ARRANGEMENT_FORMAT_VERSION;
  if (typeof raw['version'] !== 'number') {
    w.push(`No version field; assuming format ${ARRANGEMENT_FORMAT_VERSION}`);
  } else if (version > ARRANGEMENT_FORMAT_VERSION) {
    w.push(
      `Arrangement was saved by a newer build (format ${version}); loading what this build `
      + 'understands and preserving the rest',
    );
  }

  const id = reqStr(raw, 'id', 'song', 'Arrangement', w);
  const name = reqStr(raw, 'name', 'Untitled', 'Arrangement', w);
  const tempo = loadTempo(raw['tempo'], w);
  const key = loadKey(raw['key'], w);

  const sectionIds = new Set<string>();
  const sections: SectionRecord[] = [];
  const rawSections = raw['sections'];
  if (Array.isArray(rawSections)) {
    rawSections.forEach((entry, i) => {
      const section = loadSection(entry, i, sectionIds, w);
      if (section === null) { quarantined.push(entry); w.push(`Section ${i + 1}: not an object`); }
      else sections.push(section);
    });
  } else {
    w.push('No sections, starting with one 4-bar section');
    sections.push({ id: 'sec_a', name: 'A', bars: 4 });
  }

  const trackIds = new Set<string>();
  const tracks: Track[] = [];
  const samplers = { count: 0 };
  const rawTracks = raw['tracks'];
  if (Array.isArray(rawTracks)) {
    rawTracks.forEach((entry, i) => {
      const track = loadTrack(entry, i, trackIds, samplers, w);
      if (track === null) { quarantined.push(entry); w.push(`Track ${i + 1}: not an object`); }
      else tracks.push(track);
    });
  } else {
    w.push('No tracks in this arrangement');
  }

  const patterns: Record<string, PatternRecord> = {};
  const rawPatterns = raw['patterns'];
  if (isObj(rawPatterns)) {
    for (const key of Object.keys(rawPatterns).sort()) {
      const pattern = loadPattern(key, rawPatterns[key], w);
      if (pattern === null) {
        quarantined.push(rawPatterns[key]);
        w.push(`Pattern ${key}: not an object, quarantined`);
      } else patterns[key] = pattern;
    }
  } else if (rawPatterns !== undefined) {
    w.push('Patterns must be keyed by id; this file had something else, so none were loaded');
    quarantined.push(rawPatterns);
  }

  const clipIds = new Set<string>();
  const clips: ClipRecord[] = [];
  const rawClips = raw['clips'];
  if (Array.isArray(rawClips)) {
    rawClips.forEach((entry, i) => {
      const clip = loadClip(entry, i, clipIds, w);
      if (clip === null) { quarantined.push(entry); w.push(`Clip ${i + 1}: not an object`); }
      else if (!tracks.some((t) => t.id === clip.trackId)
        || !sections.some((s) => s.id === clip.sectionId)
        || patterns[clip.patternId] === undefined) {
        // Dropped from play, kept in quarantine: a re-save must not lose it.
        quarantined.push(entry);
        w.push(`Clip ${clip.id}: names a track, section or pattern that is not here; quarantined`);
      } else clips.push(clip);
    });
  }

  const arrangement: Arrangement = {
    version: ARRANGEMENT_FORMAT_VERSION,
    id,
    name,
    tempo,
    key,
    sections,
    tracks,
    patterns,
    clips,
  };
  const savedAt = optStr(raw, 'savedAt');
  if (savedAt !== undefined) arrangement.savedAt = savedAt;
  const master = raw['master'];
  if (isObj(master)) {
    const record: MasterRecord = {};
    const gain = optNum(master, 'gain', 0, 1, 'Master', w);
    if (gain !== undefined) record.gain = gain;
    const masterMeta = keepUnknown(master, MASTER_KEYS, 'Master', w);
    if (masterMeta !== undefined) record.meta = masterMeta;
    arrangement.master = record;
  }
  const meta = keepUnknown(raw, TOP_KEYS, 'Arrangement', w);
  if (meta !== undefined) arrangement.meta = meta;

  return { arrangement, warnings: w, quarantined };
}

function serialiseTrack(t: Track): TrackRecord {
  const out: TrackRecord = { id: t.id, name: t.name, engineId: t.engineId };
  if (t.patch !== undefined) out.patch = t.patch;
  if (t.presetId !== undefined) out.presetId = t.presetId;
  if (t.gain !== undefined) out.gain = t.gain;
  if (t.pan !== undefined) out.pan = t.pan;
  if (t.muted !== undefined) out.muted = t.muted;
  if (t.soloed !== undefined) out.soloed = t.soloed;
  if (t.colour !== undefined) out.colour = t.colour;
  if (t.sampleRef !== undefined) out.sampleRef = t.sampleRef;
  if (t.meta !== undefined) out.meta = t.meta;
  return out;
}

function serialiseSection(s: SectionRecord): SectionRecord {
  const out: SectionRecord = { id: s.id, name: s.name, bars: s.bars };
  if (s.repeats !== undefined) out.repeats = s.repeats;
  if (s.colour !== undefined) out.colour = s.colour;
  if (s.meta !== undefined) out.meta = s.meta;
  return out;
}

function serialiseClip(c: ClipRecord): ClipRecord {
  const out: ClipRecord = {
    id: c.id, trackId: c.trackId, sectionId: c.sectionId, patternId: c.patternId,
  };
  if (c.fill !== undefined) out.fill = c.fill;
  if (c.transpose !== undefined) out.transpose = c.transpose;
  if (c.velocityScale !== undefined) out.velocityScale = c.velocityScale;
  if (c.muted !== undefined) out.muted = c.muted;
  if (c.meta !== undefined) out.meta = c.meta;
  return out;
}

function serialiseNote(n: NoteRecord): NoteRecord {
  const out: NoteRecord = {
    id: n.id,
    midi: n.midi,
    velocity: n.velocity,
    startTick: n.startTick,
    durationTicks: n.durationTicks,
  };
  if (n.pass !== undefined) out.pass = n.pass;
  if (n.meta !== undefined) out.meta = n.meta;
  return out;
}

function serialisePattern(p: PatternRecord): PatternRecord {
  const out: PatternRecord = {
    id: p.id,
    lengthBars: p.lengthBars,
    beatsPerBar: p.beatsPerBar,
    ppq: p.ppq,
    notes: p.notes.map(serialiseNote),
  };
  if (p.name !== undefined) out.name = p.name;
  if (p.meta !== undefined) out.meta = p.meta;
  return out;
}

/**
 * Writes the song out. Field order, array order and object key order are all
 * fixed here rather than inherited from whatever the runtime happened to build,
 * so two saves of one song produce identical text: a git diff then shows what
 * the musician changed and nothing else. `unplayable` is a runtime flag about
 * THIS build's capabilities, so it never reaches the file.
 *
 * `savedAt` is passed in rather than read from the clock, because a timestamp
 * that changes on every call would make determinism untestable and every save
 * a diff.
 */
export function serialiseArrangement(a: Arrangement, savedAt?: string): SerialisedArrangement {
  const clips = [...a.clips].sort((x, y) => (
    x.trackId !== y.trackId
      ? (x.trackId < y.trackId ? -1 : 1)
      : x.sectionId !== y.sectionId
        ? (x.sectionId < y.sectionId ? -1 : 1)
        : x.id < y.id ? -1 : x.id > y.id ? 1 : 0
  ));
  const patterns: Record<string, PatternRecord> = {};
  for (const key of Object.keys(a.patterns).sort()) {
    const pattern = a.patterns[key];
    if (pattern !== undefined) patterns[key] = serialisePattern(pattern);
  }
  const out: SerialisedArrangement = {
    version: ARRANGEMENT_FORMAT_VERSION,
    id: a.id,
    name: a.name,
    tempo: { bpm: a.tempo.bpm, beatsPerBar: a.tempo.beatsPerBar, ppq: PPQ },
    key: { root: a.key.root, scale: a.key.scale },
    sections: a.sections.map(serialiseSection),
    tracks: a.tracks.map(serialiseTrack),
    patterns,
    clips: clips.map(serialiseClip),
  };
  const stamp = savedAt ?? a.savedAt;
  if (stamp !== undefined) out.savedAt = stamp;
  if (a.master !== undefined) {
    const master: MasterRecord = {};
    if (a.master.gain !== undefined) master.gain = a.master.gain;
    if (a.master.meta !== undefined) master.meta = a.master.meta;
    out.master = master;
  }
  if (a.meta !== undefined) out.meta = a.meta;
  return out;
}
