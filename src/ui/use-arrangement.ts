'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SerialisedPatch } from '@/audio/patch-format';
import { loadArrangement, serialiseArrangement } from '@/audio/arrangement-format';
import { inPlugin } from '@/audio/plugin-bridge';
import type { ScaleName } from '@/dsp/chords';
import { PPQ } from '@/dsp/sequencer';
import { DEFAULT_ENGINE_ID, engineById } from '@/dsp/registry';
import type { PlaybackSong } from '@/dsp/song-schedule';
import * as A from '@/dsp/arrangement';
import type {
  Arrangement, ClipRecord, NoteRecord, PatternRecord, SectionRecord, SerialisedArrangement,
} from '@/dsp/arrangement';
import { cellViews, playbackSong, sectionViews, trackViews } from './arrangement-views';
import type { TimelineCell, TimelineSection, TimelineTrack } from './timeline-geometry';

/**
 * The arrangement, and nothing else. Every mutation lands here; the maths and
 * the recovery rules live in src/dsp/arrangement.ts and
 * src/audio/arrangement-format.ts, which are pure, portable and already tested.
 * This file owns only what a hook can own — React state, selection, the view
 * models and persistence.
 *
 * Audio nodes are not here (the instrument owns the one live host), the loop
 * pedal is not here (use-sequencer.ts), and the clock is not here
 * (use-arrangement-playback.ts). Components take props and hand back ids.
 */

export const MAX_TRACKS = A.MAX_TRACKS;

/**
 * Written on every change; the old `sigil.session.v2` key is deliberately left
 * where it is, so a rollback does not eat anyone's sound (IA section 2.6).
 */
const ARRANGEMENT_KEY = 'sigil.arrangement.v1';

export type Scope = 'sound' | 'song';

export interface CellRef { trackId: string; sectionId: string }

/** What the loop pedal hands over when a pass is captured. */
export interface CapturedPattern {
  lengthBars: number;
  beatsPerBar: number;
  notes: readonly NoteRecord[];
}

export interface ArrangementController {
  arrangement: Arrangement;
  scope: Scope; setScope: (s: Scope) => void;
  selectedTrackId: string; selectTrack: (id: string) => void;
  selectedCell: CellRef | null;
  selectCell: (trackId: string, sectionId: string) => void;

  addTrack: (engineId: string) => string | null;
  removeTrack: (id: string) => void;
  renameTrack: (id: string, name: string) => void;
  setTrackGain: (id: string, gain: number) => void;
  toggleMute: (id: string) => void;
  toggleSolo: (id: string) => void;
  /** Changing a track's engine keeps its notes — notes are pitches. */
  setTrackEngine: (id: string, engineId: string) => void;
  setTrackPatch: (id: string, patch: SerialisedPatch) => void;

  addSection: (afterId: string | null) => string | null;
  editSection: (id: string, patch: Partial<Omit<SectionRecord, 'id'>>) => void;
  removeSection: (id: string) => void;

  /** The loop pedal's landing point: pattern and clip, in one gesture. */
  captureLoop: (trackId: string, sectionId: string, pattern: CapturedPattern) => void;
  /** One tap, one note, creating the clip if the cell is empty. */
  addNote: (trackId: string, sectionId: string, midi: number) => void;
  moveClip: (clipId: string, toTrackId: string, toSectionId: string) => void;
  clearCell: (trackId: string, sectionId: string) => void;
  setClipTranspose: (clipId: string, semitones: number) => void;
  clipAt: (trackId: string, sectionId: string) => ClipRecord | null;

  setTempo: (bpm: number) => void;
  setKey: (root: number, scale: ScaleName) => void;

  save: () => SerialisedArrangement;
  load: (raw: unknown) => string[];
  warnings: readonly string[];
  note: (message: string) => void;

  sectionViews: readonly TimelineSection[];
  trackViews: readonly TimelineTrack[];
  cells: Readonly<Record<string, Readonly<Record<string, TimelineCell>>>>;
  song: PlaybackSong;
  remainingSlots: number;
}

/**
 * First run: one track named Scratch, one section. SOUND scope then renders
 * precisely today's app, and the thing becomes a song at exactly one gesture —
 * + TRACK — and not before.
 */
export function initialArrangement(): Arrangement {
  const base = A.createArrangement({ name: 'Untitled', tempo: { bpm: 96, beatsPerBar: 4 } });
  const added = A.addTrack(base, { name: 'Scratch', engineId: DEFAULT_ENGINE_ID });
  return added.ok ? added.arrangement : base;
}

export function useArrangement(
  options: { soundingClipIds?: ReadonlySet<string> } = {},
): ArrangementController {
  const [arrangement, setArrangement] = useState<Arrangement>(initialArrangement);
  const [scope, setScope] = useState<Scope>('sound');
  const [selectedTrackId, setSelectedTrackId] = useState<string>(
    () => arrangement.tracks[0]?.id ?? '',
  );
  const [selectedCell, setSelectedCell] = useState<CellRef | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  /*
   * State, not a ref. A ref set inside the restore effect is already true by
   * the time the persist effect runs on the SAME mount pass — and that effect
   * still closes over the pre-restore arrangement, so it wrote the empty
   * default straight over the song that had just been read back.
   */
  const [restored, setRestored] = useState(false);

  const note = useCallback((message: string): void => {
    setWarnings((w) => [...w.slice(-8), message]);
  }, []);

  /** Applies a pure transform. `null` from the transform means "refused". */
  const edit = useCallback((fn: (a: Arrangement) => Arrangement): void => {
    setArrangement((a) => fn(a));
  }, []);

  const tryEdit = useCallback((fn: (a: Arrangement) => A.AddResult): string | null => {
    let created: string | null = null;
    let refused: string | null = null;
    setArrangement((a) => {
      const result = fn(a);
      if (!result.ok) { refused = result.reason; return a; }
      created = result.id;
      return result.arrangement;
    });
    if (refused !== null) note(refused);
    return created;
  }, [note]);

  // ---- selection ---------------------------------------------------------

  const selectTrack = useCallback((id: string): void => {
    setSelectedTrackId(id);
    setSelectedCell((cell) => (cell === null ? null : { ...cell, trackId: id }));
  }, []);

  const selectCell = useCallback((trackId: string, sectionId: string): void => {
    setSelectedTrackId(trackId);
    setSelectedCell({ trackId, sectionId });
  }, []);

  // ---- tracks ------------------------------------------------------------

  const addTrack = useCallback((engineId: string): string | null => {
    const name = engineById(engineId)?.descriptor.name ?? 'Track';
    const id = tryEdit((a) => A.addTrack(a, { name, engineId }));
    if (id !== null) setSelectedTrackId(id);
    return id;
  }, [tryEdit]);

  const removeTrack = useCallback((id: string): void => {
    edit((a) => (a.tracks.length <= 1 ? a : A.removeTrack(a, id)));
    setSelectedTrackId((cur) => {
      if (cur !== id) return cur;
      const next = arrangement.tracks.find((t) => t.id !== id);
      return next?.id ?? cur;
    });
  }, [edit, arrangement.tracks]);

  const renameTrack = useCallback((id: string, name: string): void => {
    edit((a) => A.renameTrack(a, id, name.trim() === '' ? 'Track' : name));
  }, [edit]);

  const setTrackGain = useCallback((id: string, gain: number): void => {
    edit((a) => A.setTrackGain(a, id, gain));
  }, [edit]);

  const toggleMute = useCallback((id: string): void => {
    edit((a) => A.setTrackMuted(a, id, a.tracks.find((t) => t.id === id)?.muted !== true));
  }, [edit]);

  const toggleSolo = useCallback((id: string): void => {
    edit((a) => A.setSolo(a, a.tracks.find((t) => t.id === id)?.soloed === true ? null : id));
  }, [edit]);

  const setTrackEngine = useCallback((id: string, engineId: string): void => {
    edit((a) => {
      const track = a.tracks.find((t) => t.id === id);
      if (track === undefined || track.engineId === engineId) return a;
      if (engineId === A.SAMPLER_ENGINE_ID
        && a.tracks.some((t) => t.id !== id && t.engineId === A.SAMPLER_ENGINE_ID)) return a;
      // The patch belonged to the old engine; it cannot describe the new one.
      return {
        ...a,
        tracks: a.tracks.map((t) => {
          if (t.id !== id) return t;
          const { patch: _patch, presetId: _presetId, ...rest } = t;
          return { ...rest, engineId };
        }),
      };
    });
  }, [edit]);

  const setTrackPatch = useCallback((id: string, patch: SerialisedPatch): void => {
    edit((a) => ({ ...a, tracks: a.tracks.map((t) => (t.id === id ? { ...t, patch } : t)) }));
  }, [edit]);

  // ---- sections ----------------------------------------------------------

  const addSection = useCallback((afterId: string | null): string | null => (
    tryEdit((a) => A.addSection(a, afterId, { name: `S${a.sections.length + 1}`, bars: 4 }))
  ), [tryEdit]);

  const editSection = useCallback(
    (id: string, patch: Partial<Omit<SectionRecord, 'id'>>): void => {
      edit((a) => A.editSection(a, id, patch));
    }, [edit]);

  const removeSection = useCallback((id: string): void => {
    edit((a) => (a.sections.length <= 1 ? a : A.removeSection(a, id)));
    setSelectedCell((cell) => (cell?.sectionId === id ? null : cell));
  }, [edit]);

  // ---- clips -------------------------------------------------------------

  /**
   * A cell owns its loop, so the pattern id is derived from the cell rather
   * than minted. Re-recording overwrites what is there and never reaches into a
   * pattern some other clip is also playing.
   */
  const captureLoop = useCallback((
    trackId: string, sectionId: string, spec: CapturedPattern,
  ): void => {
    edit((a) => {
      if (!a.tracks.some((t) => t.id === trackId)) return a;
      if (!a.sections.some((s) => s.id === sectionId)) return a;
      const patternId = `pat_${trackId}_${sectionId}`;
      const empty: PatternRecord = {
        id: patternId,
        lengthBars: Math.max(1, Math.round(spec.lengthBars)),
        beatsPerBar: Math.max(1, Math.round(spec.beatsPerBar)),
        ppq: PPQ,
        notes: [],
      };
      const filled = A.normalisePatternNotes(empty, spec.notes);
      const next: Arrangement = { ...a, patterns: { ...a.patterns, [patternId]: filled } };
      const here = next.clips.find((c) => c.trackId === trackId && c.sectionId === sectionId);
      if (here?.patternId === patternId) return next;
      const placed = A.placeClip(next, trackId, sectionId, patternId);
      return placed.ok ? placed.arrangement : next;
    });
  }, [edit]);

  /**
   * Put a single note in a cell.
   *
   * The loop pedal is the way parts get recorded, but "I just want one note
   * there" should not need a round trip through the keyboard and a take. This
   * drops the note on the next free beat of the cell's own pattern, creating
   * both the pattern and the clip if the cell is empty, so an empty grid can be
   * filled by tapping.
   */
  const addNote = useCallback((trackId: string, sectionId: string, midi: number): void => {
    edit((a) => {
      if (!a.tracks.some((t) => t.id === trackId)) return a;
      if (!a.sections.some((s) => s.id === sectionId)) return a;
      const here = a.clips.find((c) => c.trackId === trackId && c.sectionId === sectionId);
      const fallbackId = `pat_${trackId}_${sectionId}`;
      const base: PatternRecord = (here === undefined ? undefined : a.patterns[here.patternId])
        ?? {
          id: fallbackId,
          lengthBars: 1,
          beatsPerBar: a.tempo.beatsPerBar,
          ppq: PPQ,
          notes: [],
        };
      const beat = base.ppq;
      const slots = Math.max(1, Math.round(A.patternTicksOf(base) / beat));
      const used = new Set(base.notes.map((n) => Math.floor(n.startTick / beat)));
      let slot = 0;
      while (slot < slots && used.has(slot)) slot += 1;
      // A full bar stacks the next note on the downbeat rather than refusing:
      // refusing to add a note is a dead end, a chord is not.
      if (slot >= slots) slot = 0;
      const note: NoteRecord = {
        id: `n_${slot}_${midi}_${base.notes.length}`,
        midi: Math.round(midi),
        velocity: 0.9,
        startTick: slot * beat,
        durationTicks: beat,
        pass: 0,
      };
      const filled = A.normalisePatternNotes(base, [...base.notes, note]);
      const next: Arrangement = { ...a, patterns: { ...a.patterns, [filled.id]: filled } };
      if (here !== undefined) return next;
      const placed = A.placeClip(next, trackId, sectionId, filled.id);
      return placed.ok ? placed.arrangement : next;
    });
  }, [edit]);

  const moveClip = useCallback((clipId: string, toTrackId: string, toSectionId: string): void => {
    edit((a) => A.moveClip(a, clipId, toTrackId, toSectionId));
  }, [edit]);

  const clearCell = useCallback((trackId: string, sectionId: string): void => {
    edit((a) => A.clearCell(a, trackId, sectionId));
  }, [edit]);

  const setClipTranspose = useCallback((clipId: string, semitones: number): void => {
    edit((a) => A.setClipTranspose(a, clipId, semitones));
  }, [edit]);

  const clipAt = useCallback((trackId: string, sectionId: string): ClipRecord | null => (
    arrangement.clips.find((c) => c.trackId === trackId && c.sectionId === sectionId) ?? null
  ), [arrangement.clips]);

  // ---- song --------------------------------------------------------------

  const setTempo = useCallback((bpm: number): void => {
    edit((a) => A.setTempo(a, bpm));
  }, [edit]);

  const setKey = useCallback((root: number, scale: ScaleName): void => {
    edit((a) => A.setKey(a, root, scale));
  }, [edit]);

  const save = useCallback((): SerialisedArrangement => serialiseArrangement(arrangement), [arrangement]);

  const load = useCallback((raw: unknown): string[] => {
    const result = loadArrangement(raw);
    if (result === null) return ['That does not look like a SIGIL song.'];
    setArrangement(result.arrangement);
    setSelectedTrackId(result.arrangement.tracks[0]?.id ?? '');
    setSelectedCell(null);
    setWarnings(result.warnings);
    return result.warnings;
  }, []);

  // ---- persistence -------------------------------------------------------

  useEffect(() => {
    /*
     * Song is not part of the plugin — the DAW owns arrangement, which is why
     * the scope is hidden there — and every instance shares one WebView
     * storage, so this key is not per-instance and never can be. Restoring it
     * would pour one track's song into every other SIGIL in the project, and
     * saving it would let whichever instance you touched last decide what the
     * next one opened with. Same rule, same reason, as the session in
     * use-instrument.ts.
     */
    if (inPlugin()) {
      setRestored(true);
      return;
    }
    try {
      const raw = window.localStorage.getItem(ARRANGEMENT_KEY);
      if (raw !== null) {
        const result = loadArrangement(JSON.parse(raw));
        if (result !== null && result.arrangement.tracks.length > 0) {
          setArrangement(result.arrangement);
          setSelectedTrackId(result.arrangement.tracks[0]?.id ?? '');
          if (result.warnings.length > 0) setWarnings(result.warnings);
        }
      }
    } catch {
      // A corrupt song must never stop the instrument from opening.
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored || inPlugin()) return;
    try {
      window.localStorage.setItem(ARRANGEMENT_KEY, JSON.stringify(serialiseArrangement(arrangement)));
    } catch {
      // Storage full or blocked in private browsing. Playing continues.
    }
  }, [arrangement, restored]);

  // ---- view models -------------------------------------------------------

  const sounding = options.soundingClipIds;
  const sections = useMemo(() => sectionViews(arrangement), [arrangement]);
  const tracks = useMemo(() => trackViews(arrangement), [arrangement]);
  const cells = useMemo(
    () => cellViews(arrangement, sounding ?? new Set<string>()), [arrangement, sounding]);
  const song = useMemo(() => playbackSong(arrangement), [arrangement]);

  return {
    arrangement, scope, setScope, selectedTrackId, selectTrack, selectedCell, selectCell,
    addTrack, removeTrack, renameTrack, setTrackGain, toggleMute, toggleSolo,
    setTrackEngine, setTrackPatch,
    addSection, editSection, removeSection,
    captureLoop, addNote, moveClip, clearCell, setClipTranspose, clipAt,
    setTempo, setKey, save, load, warnings, note,
    sectionViews: sections, trackViews: tracks, cells, song,
    remainingSlots: Math.max(0, A.MAX_TRACKS - arrangement.tracks.length),
  };
}
