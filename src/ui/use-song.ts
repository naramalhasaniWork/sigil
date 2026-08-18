'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EngineHost } from '@/audio/engine-host';
import type { SerialisedPatch } from '@/audio/patch-format';
import { loadPatch } from '@/audio/patch-format';
import { TrackPool } from '@/audio/track-pool';
import { FX_DESCRIPTOR } from '@/dsp/fx-descriptor';
import { FX_MAGIC_DESCRIPTOR } from '@/dsp/fx-magic-descriptor';
import { addressOf } from '@/audio/param-space';
import { engineById } from '@/dsp/registry';
import type { Track } from '@/dsp/arrangement';
import { cellViews } from './arrangement-views';
import { useArrangement, type ArrangementController, type CellRef } from './use-arrangement';
import { useArrangementPlayback, type ArrangementPlayback } from './use-arrangement-playback';
import { useSequencer, type Sequencer } from './use-sequencer';
import type { TimelineCell } from './timeline-geometry';

/**
 * The join. Three things that were each built and tested alone — the
 * arrangement, the song transport and the loop pedal — meet the one live
 * instrument here, and nowhere else.
 *
 * WHAT THIS FILE KNOWS THAT NOTHING ELSE DOES:
 *
 *  1. Selecting a track swaps the instrument's sound. The sound you are leaving
 *     is written back to the track you are leaving first, so a patch is never
 *     lost by clicking away from it.
 *  2. The loop pedal has a TARGET CELL. REC captures it once, so the cell does
 *     not wander out from under you while the song rolls.
 *  3. Where a note goes. The SELECTED track plays through `EngineHost` — the
 *     node the tabs are editing, that capture and bounce read, that Panic
 *     reaches. Every OTHER track plays through its own node in `TrackPool`,
 *     `setEngine`'d and patched independently, so a physical part and an FM
 *     part in the same song are actually a physical part and an FM part. Two
 *     clips overlapping no longer re-timbre each other, because they are not
 *     sharing a voice manager any more.
 */

export interface SongInstrument {
  noteOn: (midi: number, velocity?: number) => void;
  noteOff: (midi: number) => void;
  /** Engine and patch together — see the seam in use-instrument.ts. */
  applySound: (engineId: string, patch?: unknown) => void;
  exportPatch: (name?: string) => SerialisedPatch | null;
  host: EngineHost | null;
  engineId: string;
}

export interface SongDeck {
  arr: ArrangementController;
  seq: Sequencer;
  transport: ArrangementPlayback;
  /** Cell view models, with the sounding clips lit. */
  cells: Readonly<Record<string, Readonly<Record<string, TimelineCell>>>>;
  /** "Scratch · A" — the cell REC will write into. */
  targetLabel: string;
  /** Arm or disarm the loop pedal. Wraps `seq.toggleRecord`. */
  toggleRecord: () => void;
  /** Play-surface note in: sounds it AND offers it to the loop pedal. */
  noteOn: (midi: number, velocity?: number) => void;
  noteOff: (midi: number) => void;
  /** Point the selected track at another engine. */
  selectEngine: (engineId: string) => void;

  /** The selected cell, and what can be done to it. */
  cell: CellRef | null;
  cellLabel: string;
  cellHasClip: boolean;
  /** A clip armed for tap-to-place. Non-null lights every landing spot. */
  pendingClipId: string | null;
  armMove: () => void;
  /** Tap a cell: completes an armed move, otherwise just selects. */
  tapCell: (trackId: string, sectionId: string) => void;
  addNote: (midi: number) => void;
  clearCell: () => void;
  transposeCell: (semitones: number) => void;

  /** Stop everything and release every track's notes, live or pooled. */
  panicAll: () => void;
  /** Re-assert every non-live track's sound onto its own node. */
  prepareTracks: () => void;
}

interface ResolvedSound {
  values: Float32Array;
  extras: readonly (readonly [number, number])[];
}

/**
 * A track's stored patch resolved against ITS engine's descriptor. A patch read
 * against the wrong descriptor is a patch read wrong — parameter ids are keyed
 * per engine — so the engine id comes from the track, never from the UI.
 */
function resolveSound(track: Track): ResolvedSound | null {
  const engine = engineById(track.engineId);
  if (engine === undefined) return null;
  const d = engine.descriptor;
  if (track.patch === undefined) {
    const values = new Float32Array(d.params.length);
    for (let i = 0; i < d.params.length; i++) values[i] = d.params[i]?.default ?? 0;
    return { values, extras: [] };
  }
  const loaded = loadPatch(track.patch, d, FX_DESCRIPTOR, FX_MAGIC_DESCRIPTOR);
  if (loaded === null) return null;
  const extras: Array<readonly [number, number]> = [];
  if (loaded.fx) {
    for (let i = 0; i < loaded.fx.length; i++) extras.push([addressOf('fx', i), loaded.fx[i] as number]);
  }
  if (loaded.magic) {
    for (let i = 0; i < loaded.magic.length; i++) {
      extras.push([addressOf('magic', i), loaded.magic[i] as number]);
    }
  }
  return { values: loaded.values, extras };
}

/** Push the selected track's sound onto the shared host node. */
function assertOnHost(host: EngineHost, track: Track): void {
  const sound = resolveSound(track);
  host.setEngine(track.engineId);
  if (sound === null) return;
  host.setAllParams(sound.values);
  for (const [address, value] of sound.extras) host.setParam(address, value);
}

export function useSong(inst: SongInstrument): SongDeck {
  const instRef = useRef(inst);
  instRef.current = inst;

  const arr = useArrangement();
  const arrRef = useRef(arr);
  arrRef.current = arr;

  /** One node per non-selected track. See the class comment for why. */
  const poolRef = useRef<TrackPool | null>(null);
  poolRef.current ??= new TrackPool();
  const pool = poolRef.current;

  /**
   * The pool hangs off the EngineHost's own graph, so there is one
   * AudioContext, one analyser, and Scope and Spectrum show the mix without
   * either of them changing. It can only happen after Power.
   */
  const attachPool = useCallback((): boolean => {
    const host = instRef.current.host;
    const ctx = host?.context ?? null;
    const sink = host?.analyser ?? null;
    if (ctx === null || sink === null) return false;
    pool.attach(ctx, sink);
    return true;
  }, [pool]);

  /** Everything except the live one, patched onto its own node. */
  const prepareTracks = useCallback((): void => {
    if (!attachPool()) return;
    const a = arrRef.current;
    for (const track of a.arrangement.tracks) {
      if (track.id === a.selectedTrackId || track.unplayable !== undefined) {
        pool.release(track.id);
        continue;
      }
      const sound = resolveSound(track);
      pool.prepare(track.id, track.engineId, sound?.values ?? null, sound?.extras ?? []);
      pool.setGain(track.id, track.gain ?? 0.8);
    }
  }, [attachPool, pool]);

  const [target, setTarget] = useState<CellRef | null>(null);
  const targetRef = useRef<CellRef | null>(null);

  // ---- the song transport ------------------------------------------------

  const onNoteOn = useCallback((trackId: string, midi: number, velocity: number): void => {
    if (trackId === arrRef.current.selectedTrackId) instRef.current.noteOn(midi, velocity);
    else pool.noteOn(trackId, midi, velocity);
  }, [pool]);

  const onNoteOff = useCallback((trackId: string, midi: number): void => {
    if (trackId === arrRef.current.selectedTrackId) instRef.current.noteOff(midi);
    else pool.noteOff(trackId, midi);
  }, [pool]);

  /*
   * A patch cannot be attached to a note — the worklet takes bulk parameter
   * messages, not per-note ones — so the transport says "this clip is about to
   * start" a few ms early and the sink decides what that means. With a node per
   * track it means a cheap, idempotent re-assert on THAT track's node, which is
   * correct always rather than correct-until-two-clips-overlap.
   */
  const onClipEnter = useCallback((trackId: string): void => {
    const a = arrRef.current;
    const track = a.arrangement.tracks.find((t) => t.id === trackId);
    if (track === undefined || track.unplayable !== undefined) return;
    if (trackId === a.selectedTrackId) return;
    if (!attachPool()) return;
    const sound = resolveSound(track);
    pool.prepare(trackId, track.engineId, sound?.values ?? null, sound?.extras ?? []);
    pool.setGain(trackId, track.gain ?? 0.8);
  }, [attachPool, pool]);

  const transport = useArrangementPlayback({
    song: arr.song,
    bpm: arr.arrangement.tempo.bpm,
    onNoteOn,
    onNoteOff,
    onClipEnter,
  });

  // Coming off the transport, put the selected track's sound back on the node,
  // so what the tabs are showing is what the keyboard plays.
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (transport.isPlaying && !wasPlaying.current) prepareTracks();
    if (wasPlaying.current && !transport.isPlaying) {
      pool.releaseAll();
      // Coming off the transport, put the selected track's sound back on the
      // live node: what the tabs are showing must be what the keyboard plays.
      const host = instRef.current.host;
      const a = arrRef.current;
      const track = a.arrangement.tracks.find((t) => t.id === a.selectedTrackId);
      if (host !== null && track !== undefined) assertOnHost(host, track);
    }
    wasPlaying.current = transport.isPlaying;
  }, [transport.isPlaying, prepareTracks, pool]);

  // Never leave a pool node holding a note after this hook goes away.
  useEffect(() => (): void => { pool.dispose(); }, [pool]);

  // ---- the loop pedal ----------------------------------------------------

  const seq = useSequencer({
    onNoteOn: (midi, velocity) => instRef.current.noteOn(midi, velocity),
    onNoteOff: (midi) => instRef.current.noteOff(midi),
    getCurrentTimeMs: () => performance.now(),
  });
  const seqRef = useRef(seq);
  seqRef.current = seq;

  // The looper's tempo IS the song's tempo. One tempo, one signature.
  const { setBpm } = seq;
  const { bpm } = arr.arrangement.tempo;
  useEffect(() => { setBpm(bpm); }, [bpm, setBpm]);

  /** Where a loop would land right now: under the playhead, else the selection. */
  const liveCell = useCallback((): CellRef | null => {
    const a = arrRef.current;
    const trackId = a.selectedTrackId;
    if (trackId === '') return null;
    const sectionId = transport.position?.sectionId
      ?? a.selectedCell?.sectionId
      ?? a.arrangement.sections[0]?.id;
    return sectionId === undefined ? null : { trackId, sectionId };
  }, [transport.position]);

  /**
   * REC captures the cell once. The looper holds ONE pattern, not one per cell,
   * so arming it over a different cell starts a fresh loop rather than smearing
   * the last one into a part of the song you did not play it into.
   */
  const toggleRecord = useCallback((): void => {
    const s = seqRef.current;
    if (!s.isRecording) {
      const cell = liveCell();
      if (cell === null) return;
      const prev = targetRef.current;
      if (prev === null || prev.trackId !== cell.trackId || prev.sectionId !== cell.sectionId) {
        s.clear();
      }
      targetRef.current = cell;
      setTarget(cell);
      arrRef.current.selectCell(cell.trackId, cell.sectionId);
    }
    s.toggleRecord();
  }, [liveCell]);

  // Every change to the loop lands in the song immediately, so the grid fills
  // in under your hands rather than at the end of a take.
  const { captureLoop, clearCell: clearArrangementCell } = arr;
  const pattern = seq.pattern;
  useEffect(() => {
    const cell = targetRef.current;
    if (cell === null) return;
    if (pattern.notes.length === 0) {
      clearArrangementCell(cell.trackId, cell.sectionId);
      return;
    }
    captureLoop(cell.trackId, cell.sectionId, {
      lengthBars: pattern.lengthBars,
      beatsPerBar: pattern.beatsPerBar,
      notes: pattern.notes,
    });
  }, [pattern, captureLoop, clearArrangementCell]);

  // ---- the play surface --------------------------------------------------

  const noteOn = useCallback((midi: number, velocity = 1): void => {
    instRef.current.noteOn(midi, velocity);
    seqRef.current.noteDown(midi, velocity);
  }, []);

  const noteOff = useCallback((midi: number): void => {
    instRef.current.noteOff(midi);
    seqRef.current.noteUp(midi);
  }, []);

  // ---- track selection swaps the sound -----------------------------------

  const selectedTrackId = arr.selectedTrackId;
  const leaving = useRef(selectedTrackId);
  useEffect(() => {
    const prev = leaving.current;
    if (prev === selectedTrackId) return;
    leaving.current = selectedTrackId;
    const a = arrRef.current;
    const patch = instRef.current.exportPatch();
    if (patch !== null) a.setTrackPatch(prev, patch);
    const track = a.arrangement.tracks.find((t) => t.id === selectedTrackId);
    if (track !== undefined) instRef.current.applySound(track.engineId, track.patch);
    // The newly live track gives its pool node back; the one being left picks
    // one up, so what it plays keeps sounding like itself.
    pool.release(selectedTrackId);
    prepareTracks();
  }, [selectedTrackId, pool, prepareTracks]);

  // ---- the selected cell -------------------------------------------------

  const [pendingClipId, setPending] = useState<string | null>(null);

  const cell = arr.selectedCell;
  const cellClip = cell === null ? null : arr.clipAt(cell.trackId, cell.sectionId);

  const armMove = useCallback((): void => {
    setPending((p) => (p !== null ? null : cellClip?.id ?? null));
  }, [cellClip]);

  /**
   * One tap on a cell. With a clip armed it is the destination — two taps to
   * move, which is the phone replacement for a drag between 44px targets.
   */
  const tapCell = useCallback((trackId: string, sectionId: string): void => {
    const armed = pendingClipId;
    if (armed !== null) {
      setPending(null);
      arrRef.current.moveClip(armed, trackId, sectionId);
    }
    arrRef.current.selectCell(trackId, sectionId);
  }, [pendingClipId]);

  const addNote = useCallback((midi: number): void => {
    const a = arrRef.current;
    const at = a.selectedCell
      ?? (a.arrangement.sections[0] === undefined
        ? null
        : { trackId: a.selectedTrackId, sectionId: a.arrangement.sections[0].id });
    if (at === null) return;
    a.addNote(at.trackId, at.sectionId, midi);
    a.selectCell(at.trackId, at.sectionId);
  }, []);

  const clearCell = useCallback((): void => {
    const at = arrRef.current.selectedCell;
    if (at !== null) arrRef.current.clearCell(at.trackId, at.sectionId);
    setPending(null);
  }, []);

  const transposeCell = useCallback((semitones: number): void => {
    const a = arrRef.current;
    const at = a.selectedCell;
    if (at === null) return;
    const clip = a.clipAt(at.trackId, at.sectionId);
    if (clip !== null) a.setClipTranspose(clip.id, (clip.transpose ?? 0) + semitones);
  }, []);

  const selectEngine = useCallback((engineId: string): void => {
    const a = arrRef.current;
    a.setTrackEngine(a.selectedTrackId, engineId);
    instRef.current.applySound(engineId);
  }, []);

  /** Panic reaches every track, not just the one in front of you. */
  const panicAll = useCallback((): void => {
    pool.releaseAll();
    transport.stop();
    seqRef.current.stop();
  }, [pool, transport]);

  // ---- derived -----------------------------------------------------------

  const cells = useMemo(
    () => cellViews(arr.arrangement, transport.soundingClipIds),
    [arr.arrangement, transport.soundingClipIds],
  );

  const nameCell = useCallback((at: CellRef | null): string => {
    if (at === null) return '—';
    const a = arrRef.current;
    const track = a.arrangement.tracks.find((t) => t.id === at.trackId)?.name ?? '?';
    const section = a.arrangement.sections.find((s) => s.id === at.sectionId)?.name ?? '?';
    return `${track} · ${section}`;
  }, []);

  const targetLabel = useMemo(
    () => nameCell(target ?? liveCell()), [target, liveCell, nameCell]);
  const cellLabel = useMemo(
    () => nameCell(cell ?? liveCell()), [cell, liveCell, nameCell]);

  return {
    arr, seq, transport, cells, targetLabel, toggleRecord, noteOn, noteOff, selectEngine,
    cell, cellLabel, cellHasClip: cellClip !== null,
    pendingClipId, armMove, tapCell, addNote, clearCell, transposeCell,
    panicAll, prepareTracks,
  };
}
