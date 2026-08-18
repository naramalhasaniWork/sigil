'use client';

import { useCallback, useMemo, useState } from 'react';
import type { SerialisedPatch } from '@/audio/patch-format';
import type { ScaleName } from '@/dsp/chords';
import { PPQ } from '@/dsp/sequencer';
import { DEFAULT_ENGINE_ID, ENGINES, engineById } from '@/dsp/registry';
import { clampBars, type TimelineCell, type TimelineSection, type TimelineTrack } from './timeline-geometry';

/*
 * TODO(arrangement-format): these records are the shape agreed in
 * docs/design/arrangement-ia.md §3.3 and belong in src/audio/arrangement-format.ts —
 * pure, portable, and the file that ports to C++. That module is not written yet,
 * so they are declared here to keep this hook compiling. When it lands, delete
 * this block and import the types; the shapes are deliberately identical, and
 * `load()` below should delegate to its `loadArrangement()` recovery table rather
 * than keep the deliberately thin version at the bottom of this file.
 */
export const ARRANGEMENT_FORMAT_VERSION = 1;
/** 11.5 MB of capture buffer per worklet node at 48kHz. The cap is a design. */
export const MAX_TRACKS = 8;

export interface TempoSpec { bpm: number; beatsPerBar: number; ppq: number }
export interface KeySpec { root: number; scale: ScaleName }
export interface SectionRecord { id: string; name: string; bars: number; repeats?: number; colour?: string }
export interface TrackRecord {
  id: string; name: string; engineId: string; patch?: SerialisedPatch; presetId?: string;
  gain?: number; pan?: number; muted?: boolean; soloed?: boolean; colour?: string; sampleRef?: string;
}
export interface NoteRecord {
  id: string; midi: number; velocity: number; startTick: number; durationTicks: number; pass?: number;
}
export interface PatternRecord {
  id: string; name?: string; lengthBars: number; beatsPerBar: number; ppq: number;
  notes: readonly NoteRecord[];
}
export interface ClipRecord {
  id: string; trackId: string; sectionId: string; patternId: string;
  fill?: 'loop' | 'once'; transpose?: number; velocityScale?: number; muted?: boolean;
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

export interface ArrangementController {
  arrangement: SerialisedArrangement;
  scope: 'sound' | 'song'; setScope: (s: 'sound' | 'song') => void;
  selectedTrackId: string; selectTrack: (id: string) => void;
  selectedCell: { trackId: string; sectionId: string } | null;
  selectCell: (trackId: string, sectionId: string) => void;
  addTrack: (engineId: string) => string | null;
  removeTrack: (id: string) => void;
  renameTrack: (id: string, name: string) => void;
  setTrackGain: (id: string, gain: number) => void;
  toggleMute: (id: string) => void;
  toggleSolo: (id: string) => void;
  addSection: (afterId: string | null) => string;
  editSection: (id: string, patch: Partial<SectionRecord>) => void;
  removeSection: (id: string) => void;
  placeClip: (trackId: string, sectionId: string, patternId: string) => void;
  moveClip: (clipId: string, toTrackId: string, toSectionId: string) => void;
  clearCell: (trackId: string, sectionId: string) => void;
  setClipTranspose: (clipId: string, semitones: number) => void;
  setTempo: (bpm: number) => void;
  setKey: (root: number, scale: ScaleName) => void;
  save: () => SerialisedArrangement;
  load: (raw: unknown) => string[];
  warnings: readonly string[];
  /** View models for the timeline. Components never derive these themselves. */
  sectionViews: readonly TimelineSection[];
  trackViews: readonly TimelineTrack[];
  cells: Readonly<Record<string, Readonly<Record<string, TimelineCell>>>>;
  remainingSlots: number;
}

const DEFAULT_GAIN = 0.8;
/** Two notes a beat reads as "busy"; the fill is an impression, not a piano roll. */
const DENSE_NOTES_PER_BEAT = 2;

function clamp(v: number, lo: number, hi: number): number {
  return !Number.isFinite(v) ? lo : v < lo ? lo : v > hi ? hi : v;
}

/**
 * Slug ids, never UUIDs — and enforced here at generation, not just documented.
 * The MCP consumer is a language model: it can refer back to `track_bass` from
 * three messages ago and it cannot refer to `a7f3c2e1-…`, so if the web UI
 * quietly minted UUIDs the composition path would degrade in silence.
 */
export function slugId(prefix: string, name: string, taken: ReadonlySet<string>): string {
  const base = `${prefix}_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`
    || `${prefix}_x`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

function colourOf(engineId: string): string {
  return engineById(engineId)?.descriptor.colour ?? 'var(--muted)';
}

export function createArrangement(): SerialisedArrangement {
  return {
    version: ARRANGEMENT_FORMAT_VERSION,
    id: 'song_untitled',
    name: 'Untitled',
    tempo: { bpm: 96, beatsPerBar: 4, ppq: PPQ },
    key: { root: 0, scale: 'minor' },
    // One track, one section: today's SIGIL exactly. It becomes a song at one
    // gesture (+ TRACK) and not before.
    sections: [{ id: 'sec_a', name: 'A', bars: 8 }],
    tracks: [{ id: 'track_scratch', name: 'Scratch', engineId: DEFAULT_ENGINE_ID, gain: DEFAULT_GAIN }],
    patterns: {},
    clips: [],
  };
}

/**
 * The arrangement, and nothing else. Every mutation is here; components take
 * props and hand back ids. Audio nodes belong to TrackPool, the loop belongs to
 * useSequencer, and neither of them lives in this file.
 */
export function useArrangement(
  options: { soundingClipIds?: ReadonlySet<string> } = {},
): ArrangementController {
  const { soundingClipIds } = options;
  const [arrangement, setArrangement] = useState<SerialisedArrangement>(createArrangement);
  const [scope, setScope] = useState<'sound' | 'song'>('sound');
  const [selectedTrackId, setSelectedTrackId] = useState<string>(() => 'track_scratch');
  const [selectedCell, setSelectedCell] = useState<{ trackId: string; sectionId: string } | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);

  const edit = useCallback((fn: (a: SerialisedArrangement) => SerialisedArrangement): void => {
    setArrangement((a) => fn(a));
  }, []);

  const selectTrack = useCallback((id: string): void => {
    setSelectedTrackId(id);
    setSelectedCell((cell) => (cell === null ? null : { ...cell, trackId: id }));
  }, []);

  const selectCell = useCallback((trackId: string, sectionId: string): void => {
    setSelectedTrackId(trackId);
    setSelectedCell({ trackId, sectionId });
  }, []);

  const addTrack = useCallback((engineId: string): string | null => {
    let created: string | null = null;
    edit((a) => {
      if (a.tracks.length >= MAX_TRACKS) return a;
      // One sampler track per song: setActiveSample is a module-level global in
      // the worklet bundle, so two sampler nodes cannot hold different samples.
      const sampler = engineId === 'sampler' && a.tracks.some((t) => t.engineId === 'sampler');
      const name = engineById(engineId)?.descriptor.name ?? 'Track';
      const id = slugId('track', name, new Set(a.tracks.map((t) => t.id)));
      created = id;
      const track: TrackRecord = { id, name, engineId: sampler ? DEFAULT_ENGINE_ID : engineId, gain: DEFAULT_GAIN };
      if (sampler) setWarnings((w) => [...w, 'Only one sampler track per song — added an analog track instead.']);
      return { ...a, tracks: [...a.tracks, track] };
    });
    return created;
  }, [edit]);

  const removeTrack = useCallback((id: string): void => {
    edit((a) => (a.tracks.length <= 1 ? a : {
      ...a,
      tracks: a.tracks.filter((t) => t.id !== id),
      clips: a.clips.filter((c) => c.trackId !== id),
    }));
    setSelectedTrackId((cur) => (cur === id ? 'track_scratch' : cur));
  }, [edit]);

  const patchTrack = useCallback((id: string, patch: Partial<TrackRecord>): void => {
    edit((a) => ({ ...a, tracks: a.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  }, [edit]);

  const renameTrack = useCallback((id: string, name: string): void => {
    patchTrack(id, { name: name.trim() === '' ? 'Track' : name });
  }, [patchTrack]);

  const setTrackGain = useCallback((id: string, gain: number): void => {
    patchTrack(id, { gain: clamp(gain, 0, 1) });
  }, [patchTrack]);

  const toggleMute = useCallback((id: string): void => {
    edit((a) => ({ ...a, tracks: a.tracks.map((t) => (t.id === id ? { ...t, muted: t.muted !== true } : t)) }));
  }, [edit]);

  /** Solo is a radio, not a checkbox — multi-solo is a mixing workflow. */
  const toggleSolo = useCallback((id: string): void => {
    edit((a) => {
      const on = a.tracks.find((t) => t.id === id)?.soloed === true;
      return { ...a, tracks: a.tracks.map((t) => ({ ...t, soloed: !on && t.id === id })) };
    });
  }, [edit]);

  const addSection = useCallback((afterId: string | null): string => {
    let created = '';
    edit((a) => {
      const taken = new Set(a.sections.map((s) => s.id));
      const id = slugId('sec', `s${a.sections.length + 1}`, taken);
      created = id;
      const at = afterId === null ? a.sections.length : a.sections.findIndex((s) => s.id === afterId) + 1;
      const next = [...a.sections];
      next.splice(at <= 0 ? a.sections.length : at, 0, { id, name: `S${a.sections.length + 1}`, bars: 8 });
      return { ...a, sections: next };
    });
    return created;
  }, [edit]);

  const editSection = useCallback((id: string, patch: Partial<SectionRecord>): void => {
    edit((a) => ({
      ...a,
      sections: a.sections.map((s) => (s.id === id
        ? { ...s, ...patch, bars: clampBars(patch.bars ?? s.bars) }
        : s)),
    }));
  }, [edit]);

  const removeSection = useCallback((id: string): void => {
    edit((a) => (a.sections.length <= 1 ? a : {
      ...a,
      sections: a.sections.filter((s) => s.id !== id),
      clips: a.clips.filter((c) => c.sectionId !== id),
    }));
    setSelectedCell((cell) => (cell?.sectionId === id ? null : cell));
  }, [edit]);

  const placeClip = useCallback((trackId: string, sectionId: string, patternId: string): void => {
    edit((a) => {
      const taken = new Set(a.clips.map((c) => c.id));
      const id = slugId('clip', `${trackId}_${sectionId}`, taken);
      const kept = a.clips.filter((c) => !(c.trackId === trackId && c.sectionId === sectionId));
      return { ...a, clips: [...kept, { id, trackId, sectionId, patternId }] };
    });
  }, [edit]);

  const moveClip = useCallback((clipId: string, toTrackId: string, toSectionId: string): void => {
    edit((a) => {
      const moving = a.clips.find((c) => c.id === clipId);
      if (moving === undefined) return a;
      const kept = a.clips.filter((c) => c.id !== clipId
        && !(c.trackId === toTrackId && c.sectionId === toSectionId));
      return { ...a, clips: [...kept, { ...moving, trackId: toTrackId, sectionId: toSectionId }] };
    });
  }, [edit]);

  const clearCell = useCallback((trackId: string, sectionId: string): void => {
    edit((a) => ({
      ...a,
      clips: a.clips.filter((c) => !(c.trackId === trackId && c.sectionId === sectionId)),
    }));
  }, [edit]);

  const setClipTranspose = useCallback((clipId: string, semitones: number): void => {
    edit((a) => ({
      ...a,
      clips: a.clips.map((c) => (c.id === clipId
        ? { ...c, transpose: Math.round(clamp(semitones, -24, 24)) }
        : c)),
    }));
  }, [edit]);

  const setTempo = useCallback((bpm: number): void => {
    edit((a) => ({ ...a, tempo: { ...a.tempo, bpm: clamp(Math.round(bpm), 20, 300) } }));
  }, [edit]);

  const setKey = useCallback((root: number, scale: ScaleName): void => {
    edit((a) => ({ ...a, key: { root: ((Math.round(root) % 12) + 12) % 12, scale } }));
  }, [edit]);

  /** Deterministic ordering, so two saves of one song produce identical JSON. */
  const save = useCallback((): SerialisedArrangement => ({
    ...arrangement,
    savedAt: new Date().toISOString(),
    patterns: Object.fromEntries(Object.entries(arrangement.patterns).sort(([a], [b]) => (a < b ? -1 : 1))),
    clips: [...arrangement.clips].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }), [arrangement]);

  /*
   * Deliberately thin. The exhaustive recovery table — unknown engines kept and
   * flagged, unknown keys preserved into `meta`, ppq rescaling, quarantined
   * clips — belongs to loadArrangement() in arrangement-format.ts, which is not
   * written yet. This does the shape check and the referential integrity pass so
   * a load cannot leave a clip pointing at a track that is not there, and warns
   * about everything it touches rather than swallowing it.
   */
  const load = useCallback((raw: unknown): string[] => {
    if (typeof raw !== 'object' || raw === null) return ['Not an arrangement.'];
    const it = raw as Partial<SerialisedArrangement>;
    if (!Array.isArray(it.sections) || !Array.isArray(it.tracks)) return ['Not an arrangement.'];
    const found: string[] = [];
    if ((it.version ?? 0) > ARRANGEMENT_FORMAT_VERSION) found.push('Saved by a newer build — loading what is understood.');
    const tracks = it.tracks.slice(0, MAX_TRACKS);
    if (it.tracks.length > tracks.length) found.push(`Past the ${MAX_TRACKS}-track cap — ${it.tracks.length - tracks.length} not loaded.`);
    const trackIds = new Set(tracks.map((t) => t.id));
    const sectionIds = new Set(it.sections.map((s) => s.id));
    const clips = (it.clips ?? []).filter((c) => trackIds.has(c.trackId) && sectionIds.has(c.sectionId));
    if ((it.clips ?? []).length !== clips.length) found.push(`${(it.clips ?? []).length - clips.length} clip(s) pointed at nothing and were dropped.`);
    const base = createArrangement();
    const next: SerialisedArrangement = {
      ...base, ...it,
      sections: it.sections.map((s) => ({ ...s, bars: clampBars(s.bars) })),
      tracks, clips, patterns: it.patterns ?? {},
    };
    setArrangement(next);
    setSelectedTrackId(tracks[0]?.id ?? base.tracks[0]?.id ?? '');
    setSelectedCell(null);
    setWarnings(found);
    return found;
  }, []);

  const sectionViews = useMemo<readonly TimelineSection[]>(
    () => arrangement.sections.map((s) => ({ id: s.id, name: s.name, bars: s.bars, repeats: s.repeats })),
    [arrangement.sections],
  );

  const trackViews = useMemo<readonly TimelineTrack[]>(() => arrangement.tracks.map((t) => ({
    id: t.id,
    name: t.name,
    engineId: t.engineId,
    colour: colourOf(t.engineId),
    gain: t.gain ?? DEFAULT_GAIN,
    muted: t.muted === true,
    soloed: t.soloed === true,
    unplayable: engineById(t.engineId) === undefined ? true : undefined,
  })), [arrangement.tracks]);

  const cells = useMemo(() => {
    const { beatsPerBar } = arrangement.tempo;
    const out: Record<string, Record<string, TimelineCell>> = {};
    for (const track of arrangement.tracks) {
      const row: Record<string, TimelineCell> = {};
      for (const section of arrangement.sections) {
        const clip = arrangement.clips.find((c) => c.trackId === track.id && c.sectionId === section.id);
        const pattern = clip === undefined ? undefined : arrangement.patterns[clip.patternId];
        const beats = Math.max(1, (pattern?.lengthBars ?? 1) * (pattern?.beatsPerBar ?? beatsPerBar));
        const noteCount = pattern?.notes.length ?? 0;
        row[section.id] = {
          clipId: clip?.id ?? null,
          noteCount,
          density: clamp(noteCount / (beats * DENSE_NOTES_PER_BEAT), 0, 1),
          muted: track.muted === true || clip?.muted === true,
          playing: clip !== undefined && soundingClipIds?.has(clip.id) === true,
        };
      }
      out[track.id] = row;
    }
    return out;
  }, [arrangement, soundingClipIds]);

  return {
    arrangement, scope, setScope, selectedTrackId, selectTrack, selectedCell, selectCell,
    addTrack, removeTrack, renameTrack, setTrackGain, toggleMute, toggleSolo,
    addSection, editSection, removeSection,
    placeClip, moveClip, clearCell, setClipTranspose, setTempo, setKey,
    save, load, warnings,
    sectionViews, trackViews, cells,
    remainingSlots: Math.max(0, MAX_TRACKS - arrangement.tracks.length),
  };
}

/** Engine choices for a new track, in registry order. Colour travels as a prop. */
export const TRACK_ENGINE_CHOICES: readonly { id: string; name: string; colour: string }[] =
  ENGINES.map((e) => ({ id: e.descriptor.id, name: e.descriptor.name, colour: e.descriptor.colour }));
