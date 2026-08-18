'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PPQ, msPerTick } from '@/dsp/sequencer';
import {
  audibleTracks, buildTimeline, clipsAt, createNoteLedger, positionAt, reanchorOrigin,
  songTickAt, songWindowEvents, spanOf, tickOfBar,
  type LoopRange, type NoteLedger, type PlayAnchor, type PlaybackSong, type SongPosition,
  type SongTimeline,
} from '@/dsp/song-schedule';

/**
 * The song transport: ONE clock, N stateless pattern queries. The maths lives in
 * src/dsp/song-schedule.ts; this file owns only what a hook can own — the
 * wall-clock origin, the 25ms wake, the armed timers, cleanup. Position is
 * derived from the clock each time it is asked for: a per-tick counter
 * accumulates error and the song audibly wanders.
 *
 * Do NOT run one `useSequencer` per track: each owns its own origin and its own
 * interval, so eight of them drift apart and machine-gun on tab resume.
 * `use-sequencer.ts` stays what it is — the loop pedal for one cell.
 *
 * THE PATCH TRADEOFF, stated rather than hidden. A track carries its own patch
 * and a patch cannot be attached to a note — the worklet takes bulk parameter
 * messages, not per-note ones. So this hook emits `onClipEnter(trackId, clipId)`
 * PREPARE_MS before a clip's first note and lets the sink decide what it means.
 * One AudioWorkletNode per track (TrackPool): a cheap idempotent re-assert of
 * that track's params on that track's node, correct always. ONE shared node: it
 * cannot be correct, since track B's patch re-timbres track A's still-ringing
 * notes and last writer wins — such a sink must accept that or refuse to overlap
 * tracks. Rejected: a patch per note (no such message) and per-voice patch
 * routing (a worklet change, off limits here).
 */

const WAKE_MS = 25;
const LOOKAHEAD_MS = 100;
/** Lead time on the clip-enter callback, so a patch lands before the note. */
const PREPARE_MS = 12;

export interface ArrangementPlaybackOptions {
  song: PlaybackSong;
  /** Changing this while playing re-anchors and re-arms; nothing is lost. */
  bpm: number;
  onNoteOn: (trackId: string, midi: number, velocity: number) => void;
  onNoteOff: (trackId: string, midi: number) => void;
  /** Fired PREPARE_MS before a clip's first note. See the tradeoff above. */
  onClipEnter?: (trackId: string, clipId: string) => void;
  /** Injected so the transport can be driven by a fake clock. */
  getCurrentTimeMs?: () => number;
}

export interface ArrangementPlayback {
  isPlaying: boolean;
  /** `fromBar` is a 1-indexed absolute song bar. */
  play: (fromBar?: number) => void; stop: () => void;
  songTick: number; position: SongPosition | null;
  loopSectionId: string | null; setLoopSection: (sectionId: string | null) => void;
  soundingClipIds: ReadonlySet<string>;
  timeline: SongTimeline;
}

interface Pair {
  id: number; trackId: string; midi: number; velocity: number;
  onTick: number; offTick: number; enter: string | null;
  timers: number[]; sounding: boolean;
}

/**
 * Where the next window starts. A cursor a hair behind the clock is a note a few
 * milliseconds late — play it, because late beats missing and the first note of
 * a song sits at exactly this boundary. A long way behind is a background tab
 * that just woke: jump, or it machine-guns everything it slept through. Clock
 * bookkeeping rather than song maths, so it lives with the clock.
 */
export function catchUpCursor(cursor: number, nowTick: number, lookaheadTicks: number): number {
  return nowTick - cursor > Math.max(1, lookaheadTicks) ? nowTick : cursor;
}

export function useArrangementPlayback(opts: ArrangementPlaybackOptions): ArrangementPlayback {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const timeline = useMemo(
    () => buildTimeline(opts.song.sections, opts.song.beatsPerBar),
    [opts.song.sections, opts.song.beatsPerBar],
  );
  const tlRef = useRef(timeline);
  tlRef.current = timeline;

  const [isPlaying, setPlayingState] = useState(false);
  const [songTick, setSongTick] = useState(0);
  const [loopSectionId, setLoopSectionId] = useState<string | null>(null);
  const [soundingClipIds, setSoundingClips] = useState<ReadonlySet<string>>(() => new Set());

  const playingRef = useRef(false);
  /** Wall-clock time of PLAY tick 0, and the current ms per tick. */
  const originRef = useRef(0);
  const perRef = useRef(msPerTick(opts.bpm, PPQ));
  const anchorRef = useRef<PlayAnchor>({ playTick: 0, songTick: 0 });
  /** PLAY tick committed through, exclusive. */
  const cursorRef = useRef(0);
  const loopRef = useRef<LoopRange | null>(null);
  const pairsRef = useRef(new Map<number, Pair>());
  const idRef = useRef(0);
  /** Clips already told to prepare, so a patch is not re-sent per note. */
  const activeRef = useRef(new Set<string>());

  const nowMs = useCallback(
    (): number => optsRef.current.getCurrentTimeMs?.() ?? performance.now(), []);

  const ledgerRef = useRef<NoteLedger | null>(null);
  ledgerRef.current ??= createNoteLedger(
    (t, m, v) => optsRef.current.onNoteOn(t, m, v), (t, m) => optsRef.current.onNoteOff(t, m));
  const ledger = (): NoteLedger => ledgerRef.current as NoteLedger;

  const clearTimers = useCallback((pair: Pair): void => {
    for (const id of pair.timers) window.clearTimeout(id);
    pair.timers = [];
  }, []);

  /**
   * Anchor every timer to an absolute instant computed from the origin, so error
   * never accumulates. Re-arming a sounding pair re-times its release only.
   */
  const armPair = useCallback((pair: Pair): void => {
    const at = nowMs();
    const onAt = originRef.current + pair.onTick * perRef.current;
    const arm = (when: number, fire: () => void): void => {
      pair.timers.push(window.setTimeout(fire, Math.max(0, when - at)));
    };
    if (!pair.sounding) {
      const clipId = pair.enter;
      if (clipId !== null) {
        arm(onAt - PREPARE_MS, () => optsRef.current.onClipEnter?.(pair.trackId, clipId));
      }
      arm(onAt, () => {
        pair.sounding = true;
        ledger().hold(pair.trackId, pair.midi, pair.velocity);
      });
    }
    arm(originRef.current + pair.offTick * perRef.current, () => {
      pairsRef.current.delete(pair.id);
      if (pair.sounding) { pair.sounding = false; ledger().release(pair.trackId, pair.midi); }
    });
  }, [nowMs]);

  /** Throw away what has not started. Sounding notes keep their release. */
  const dropArmed = useCallback((): void => {
    for (const pair of [...pairsRef.current.values()]) {
      if (pair.sounding) continue;
      clearTimers(pair);
      pairsRef.current.delete(pair.id);
    }
  }, [clearTimers]);

  const playTickNow = useCallback((): number => (
    perRef.current > 0 ? (nowMs() - originRef.current) / perRef.current : 0
  ), [nowMs]);

  const stopClock = useCallback((): void => {
    playingRef.current = false;
    setPlayingState(false);
    activeRef.current.clear();
    setSoundingClips(new Set());
  }, []);

  const wake = useCallback((): void => {
    const t = tlRef.current;
    const per = perRef.current;
    if (per <= 0 || t.totalTicks <= 0) return;
    const nowTick = playTickNow();
    // Background tabs throttle timers hard: on resume jump rather than
    // machine-gun, and drop the lookahead armed before the sleep.
    const catchUp = catchUpCursor(cursorRef.current, nowTick, LOOKAHEAD_MS / per);
    if (catchUp !== cursorRef.current) dropArmed();
    cursorRef.current = catchUp;
    const from = cursorRef.current;
    const to = nowTick + LOOKAHEAD_MS / per;
    const scheduled = new Set<string>();
    if (to > from) {
      const song = optsRef.current.song;
      for (const ev of songWindowEvents(song, t, from, to, anchorRef.current, loopRef.current)) {
        scheduled.add(ev.clipId);
        const first = !activeRef.current.has(ev.clipId);
        if (first) activeRef.current.add(ev.clipId);
        const pair: Pair = {
          id: idRef.current++, trackId: ev.trackId, midi: ev.midi, velocity: ev.velocity,
          onTick: ev.onTick, offTick: ev.offTick, enter: first ? ev.clipId : null,
          timers: [], sounding: false,
        };
        pairsRef.current.set(pair.id, pair);
        armPair(pair);
      }
      cursorRef.current = to;
    }
    const at = songTickAt(nowTick, anchorRef.current, loopRef.current);
    setSongTick((prev) => (Math.floor(prev) === Math.floor(at) ? prev : at));
    const under = clipsAt(optsRef.current.song, t, at);
    setSoundingClips((prev) => (
      prev.size === under.size && [...under].every((id) => prev.has(id)) ? prev : under));
    // A clip stays "entered" while the playhead is in it OR while its notes are
    // still being committed ahead of it: prune eagerly and every note is an
    // entry, which means a patch blast per note.
    for (const id of [...activeRef.current]) {
      if (!under.has(id) && !scheduled.has(id)) activeRef.current.delete(id);
    }
    // End of song: stop the clock but let sounding notes release, so the last
    // chord is not chopped off by its own ending.
    if (!loopRef.current && at >= t.totalTicks) { dropArmed(); stopClock(); }
  }, [armPair, dropArmed, playTickNow, stopClock]);

  useEffect(() => {
    if (!isPlaying) return;
    wake();
    const id = window.setInterval(wake, WAKE_MS);
    return (): void => window.clearInterval(id);
  }, [isPlaying, wake]);

  // Tempo. Hold the playhead, change the rate underneath it, then re-arm every
  // pending timer from its unchanged PLAY tick: a note in flight moves to its
  // new instant rather than being dropped or fired twice.
  useEffect(() => {
    const next = msPerTick(opts.bpm, tlRef.current.ppq);
    const prev = perRef.current;
    if (next <= 0 || next === prev) return;
    if (!playingRef.current) { perRef.current = next; return; }
    const at = nowMs();
    originRef.current = reanchorOrigin(at, originRef.current, prev, next);
    perRef.current = next;
    for (const pair of pairsRef.current.values()) { clearTimers(pair); armPair(pair); }
  }, [opts.bpm, armPair, clearTimers, nowMs]);

  // Mute or solo mid-note: silence the track at once, live and pending alike.
  const audibleKey = useMemo(
    () => JSON.stringify([...audibleTracks(opts.song.tracks)].sort()),
    [opts.song.tracks],
  );
  useEffect(() => {
    const audible = new Set<string>(JSON.parse(audibleKey) as string[]);
    for (const pair of [...pairsRef.current.values()]) {
      if (audible.has(pair.trackId)) continue;
      clearTimers(pair);
      pairsRef.current.delete(pair.id);
    }
    for (const track of optsRef.current.song.tracks) {
      if (!audible.has(track.id)) ledger().releaseTrack(track.id);
    }
  }, [audibleKey, clearTimers]);

  const play = useCallback((fromBar = 1): void => {
    const t = tlRef.current;
    if (playingRef.current || t.totalTicks <= 0) return;
    perRef.current = msPerTick(optsRef.current.bpm, t.ppq);
    const loop = loopRef.current;
    let start = tickOfBar(t, fromBar);
    if (loop && (start < loop.startTick || start >= loop.endTick)) start = loop.startTick;
    originRef.current = nowMs();
    anchorRef.current = { playTick: 0, songTick: start };
    cursorRef.current = 0;
    activeRef.current.clear();
    setSongTick(start);
    playingRef.current = true;
    setPlayingState(true);
  }, [nowMs]);

  const stop = useCallback((): void => {
    for (const pair of [...pairsRef.current.values()]) clearTimers(pair);
    pairsRef.current.clear();
    ledger().releaseAll();
    stopClock();
  }, [clearTimers, stopClock]);

  /** Re-anchors rather than re-origins, so armed releases survive the change. */
  const setLoopSection = useCallback((sectionId: string | null): void => {
    const span = sectionId === null ? null : spanOf(tlRef.current, sectionId);
    const range = span === null ? null : { startTick: span.startTick, endTick: span.endTick };
    if (playingRef.current) {
      const at = playTickNow();
      let song = songTickAt(at, anchorRef.current, loopRef.current);
      if (range && (song < range.startTick || song >= range.endTick)) song = range.startTick;
      anchorRef.current = { playTick: at, songTick: song };
      dropArmed();
      cursorRef.current = at;
    }
    loopRef.current = range;
    setLoopSectionId(span === null ? null : span.id);
  }, [dropArmed, playTickNow]);

  // Never leave the engine holding notes after this hook goes away.
  useEffect(() => (): void => {
    for (const pair of pairsRef.current.values()) clearTimers(pair);
    pairsRef.current.clear();
    ledgerRef.current?.releaseAll();
  }, [clearTimers]);

  return {
    isPlaying, play, stop, songTick,
    position: isPlaying ? positionAt(timeline, songTick) : null,
    loopSectionId, setLoopSection, soundingClipIds, timeline,
  };
}
