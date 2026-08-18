/**
 * Arrangement scheduling maths. No React, no DOM, no timers, no audio — the
 * same discipline as sequencer.ts, whose primitives this reuses rather than
 * re-derives. Everything here is deterministic, so the transport can be
 * reasoned about (and tested) without making a sound.
 *
 * TWO TIMELINES, and the distinction is the whole design:
 *  - PLAY ticks are monotonic and never repeat. Wall-clock times, the commit
 *    cursor and every armed timer live here.
 *  - SONG ticks are where the music is, and they repeat when a section loops.
 * A note's off is emitted in PLAY ticks, so a note held across a loop point is
 * released at the right instant rather than stranded by the jump back. That one
 * choice is what stops looping from hanging notes.
 *
 * A PlayAnchor ties one PLAY tick to one SONG tick; moving it (seek, loop on or
 * off) changes only where the music is read from, never when a pending event
 * fires, so timers already armed stay valid. Tempo moves the other mapping —
 * see reanchorOrigin.
 */

import { PPQ, patternTicks, scheduleWindow, type Pattern } from './sequencer';

export interface PlaybackNote {
  readonly id: string; readonly midi: number; readonly velocity: number;
  readonly startTick: number; readonly durationTicks: number; readonly pass?: number;
}
export interface PlaybackPattern {
  readonly lengthBars: number; readonly beatsPerBar: number; readonly ppq: number;
  readonly notes: readonly PlaybackNote[];
}
export interface PlaybackSection {
  readonly id: string; readonly bars: number; readonly repeats?: number;
}
export interface PlaybackTrack {
  readonly id: string; readonly muted?: boolean; readonly soloed?: boolean;
}
export interface PlaybackClip {
  readonly id: string; readonly trackId: string; readonly sectionId: string;
  readonly patternId: string; readonly fill?: 'loop' | 'once';
  readonly transpose?: number; readonly velocityScale?: number; readonly muted?: boolean;
}
/** Structurally the runtime slice of a serialised arrangement, nothing more. */
export interface PlaybackSong {
  readonly beatsPerBar: number;
  readonly sections: readonly PlaybackSection[];
  readonly tracks: readonly PlaybackTrack[];
  readonly clips: readonly PlaybackClip[];
  readonly patterns: Readonly<Record<string, PlaybackPattern>>;
}

export interface SectionSpan {
  readonly id: string; readonly startTick: number; readonly endTick: number;
}
export interface SongTimeline {
  readonly spans: readonly SectionSpan[];
  readonly totalTicks: number; readonly barTicks: number; readonly ppq: number;
}
export interface SongPosition {
  readonly sectionId: string; readonly bar: number; readonly beat: number;
}
export interface LoopRange { readonly startTick: number; readonly endTick: number }
/** Ties one PLAY tick to one SONG tick. Everything else follows from it. */
export interface PlayAnchor { readonly playTick: number; readonly songTick: number }
export interface WindowSegment {
  readonly playFrom: number; readonly playTo: number;
  /** songTick = playTick + offset, constant across the segment. */
  readonly offset: number;
  /** PLAY tick where this mapping stops — the loop point or the song end. */
  readonly limitPlay: number;
}
export interface SongEvent {
  readonly clipId: string; readonly trackId: string; readonly noteId: string;
  readonly midi: number; readonly velocity: number;
  /** PLAY ticks. offTick is always strictly greater than onTick. */
  readonly onTick: number; readonly offTick: number;
}

function wrap(v: number, total: number): number { return ((v % total) + total) % total; }
function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

/** PlaybackPattern -> Pattern (pass defaults to 0), memoised per object. */
const PATTERNS = new WeakMap<PlaybackPattern, Pattern>();
function asPattern(p: PlaybackPattern): Pattern {
  const hit = PATTERNS.get(p);
  if (hit) return hit;
  const made: Pattern = {
    lengthBars: p.lengthBars, beatsPerBar: p.beatsPerBar, ppq: p.ppq,
    notes: p.notes.map((n) => ({
      id: n.id, midi: n.midi, velocity: n.velocity,
      startTick: n.startTick, durationTicks: n.durationTicks, pass: n.pass ?? 0,
    })),
  };
  PATTERNS.set(p, made);
  return made;
}

/** Sections laid end to end in song ticks, repeats expanded in place. */
export function buildTimeline(
  sections: readonly PlaybackSection[], beatsPerBar = 4, ppq: number = PPQ,
): SongTimeline {
  const barTicks = Math.max(1, Math.floor(beatsPerBar)) * ppq;
  const spans: SectionSpan[] = [];
  let cursor = 0;
  for (const s of sections) {
    const len = Math.max(1, Math.floor(s.bars)) * Math.max(1, Math.floor(s.repeats ?? 1)) * barTicks;
    spans.push({ id: s.id, startTick: cursor, endTick: cursor + len });
    cursor += len;
  }
  return { spans, totalTicks: cursor, barTicks, ppq };
}

export function spanOf(t: SongTimeline, sectionId: string): SectionSpan | null {
  return t.spans.find((s) => s.id === sectionId) ?? null;
}

export function spanAt(t: SongTimeline, songTick: number): SectionSpan | null {
  return t.spans.find((s) => songTick >= s.startTick && songTick < s.endTick) ?? null;
}

/** 1-indexed absolute song bar -> song tick, for seeking. */
export function tickOfBar(t: SongTimeline, bar: number): number {
  return clamp((Math.floor(bar) - 1) * t.barTicks, 0, Math.max(0, t.totalTicks - 1));
}

/** Bar and beat are 1-indexed *within* the section, the way a section reads. */
export function positionAt(t: SongTimeline, songTick: number): SongPosition | null {
  const span = spanAt(t, songTick);
  if (!span) return null;
  const into = songTick - span.startTick;
  return {
    sectionId: span.id,
    bar: Math.floor(into / t.barTicks) + 1,
    beat: Math.floor((into % t.barTicks) / t.ppq) + 1,
  };
}

export function songTickAt(playTick: number, anchor: PlayAnchor, loop: LoopRange | null): number {
  const base = anchor.songTick + (playTick - anchor.playTick);
  const len = loop ? loop.endTick - loop.startTick : 0;
  return loop && len > 0 ? loop.startTick + wrap(base - loop.startTick, len) : base;
}

/**
 * Hold the playhead, change the rate underneath it: the new wall-clock origin.
 * Position is preserved exactly, so a tempo change re-times what is pending
 * instead of dropping it or firing it twice.
 */
export function reanchorOrigin(
  atMs: number, originMs: number, oldPerTick: number, newPerTick: number,
): number {
  const tick = oldPerTick > 0 ? (atMs - originMs) / oldPerTick : 0;
  return atMs - tick * newPerTick;
}

/**
 * Cut a PLAY window into pieces that each map onto SONG ticks by a constant
 * offset. Without a loop that is one piece, ending at the song end. With one it
 * is one piece per lap — this is where the loop boundary is actually handled,
 * and getting it wrong drops or doubles a note once per lap, which "feels off"
 * forever without ever looking broken.
 */
export function foldWindow(
  from: number, to: number, anchor: PlayAnchor, loop: LoopRange | null, totalTicks: number,
): WindowSegment[] {
  if (!(to > from) || totalTicks <= 0) return [];
  const len = loop ? loop.endTick - loop.startTick : 0;
  if (!loop || len <= 0) {
    const offset = anchor.songTick - anchor.playTick;
    const limitPlay = totalTicks - offset;
    const playTo = Math.min(to, limitPlay);
    return playTo > from ? [{ playFrom: from, playTo, offset, limitPlay }] : [];
  }
  const out: WindowSegment[] = [];
  let cur = from;
  // Guarded: a window many laps long is a resumed background tab, not music.
  for (let guard = 0; guard < 64 && cur < to; guard++) {
    const into = wrap(anchor.songTick - loop.startTick + (cur - anchor.playTick), len);
    const limitPlay = cur + (len - into);
    const playTo = Math.min(to, limitPlay);
    out.push({ playFrom: cur, playTo, offset: loop.startTick + into - cur, limitPlay });
    cur = playTo;
  }
  return out;
}

/** Solo is a radio: one soloed track silences the rest. Mute still wins. */
export function audibleTracks(tracks: readonly PlaybackTrack[]): ReadonlySet<string> {
  const solo = tracks.find((t) => t.soloed) ?? null;
  const out = new Set<string>();
  for (const t of tracks) {
    if (t.muted || (solo !== null && t.id !== solo.id)) continue;
    out.add(t.id);
  }
  return out;
}

/** Clips under the playhead right now, muting included. Drives the grid. */
export function clipsAt(
  song: PlaybackSong, t: SongTimeline, songTick: number,
): ReadonlySet<string> {
  const span = spanAt(t, songTick);
  const audible = audibleTracks(song.tracks);
  const out = new Set<string>();
  if (!span) return out;
  for (const c of song.clips) {
    if (c.muted || c.sectionId !== span.id || !audible.has(c.trackId)) continue;
    if (song.patterns[c.patternId]) out.add(c.id);
  }
  return out;
}

/**
 * Every note across every track whose start falls in the half-open PLAY window
 * [from, to). This is the one function the whole transport leans on.
 *
 * Note-offs are clamped to the end of the clip's section, or the loop point,
 * whichever comes first — so a clip never bleeds into the next section and a
 * lap never overlaps itself.
 */
export function songWindowEvents(
  song: PlaybackSong, t: SongTimeline, from: number, to: number,
  anchor: PlayAnchor, loop: LoopRange | null,
): SongEvent[] {
  const audible = audibleTracks(song.tracks);
  const events: SongEvent[] = [];
  for (const seg of foldWindow(from, to, anchor, loop, t.totalTicks)) {
    for (const clip of song.clips) {
      if (clip.muted || !audible.has(clip.trackId)) continue;
      const span = spanOf(t, clip.sectionId);
      const raw = song.patterns[clip.patternId];
      if (!span || !raw) continue;
      const startPlay = span.startTick - seg.offset;
      const wFrom = Math.max(seg.playFrom, startPlay);
      const wTo = Math.min(seg.playTo, span.endTick - seg.offset);
      if (!(wTo > wFrom)) continue;
      const pattern = asPattern(raw);
      const total = patternTicks(pattern);
      if (total <= 0) continue;
      const localFrom = wFrom - startPlay;
      if (clip.fill === 'once' && localFrom >= total) continue;
      const localTo = clip.fill === 'once' ? Math.min(wTo - startPlay, total) : wTo - startPlay;
      const boundary = Math.min(span.endTick - seg.offset, seg.limitPlay);
      // A window longer than the pattern is asked for one lap at a time:
      // scheduleWindow deliberately yields each note once per call, so a
      // three-lap window would otherwise come back holding one lap.
      for (let a = localFrom; a < localTo; a = Math.min(a + total, localTo)) {
        for (const hit of scheduleWindow(pattern, a, Math.min(a + total, localTo))) {
          // Transposed off the keyboard is dropped, not folded into an octave
          // nobody played — a wrong note is worse than a missing one.
          const midi = hit.note.midi + (clip.transpose ?? 0);
          if (midi < 0 || midi > 127) continue;
          const onTick = startPlay + hit.absTick;
          // A garbage duration — zero, negative, NaN out of a hand-edited file —
          // becomes one tick. onTick is always strictly inside the boundary, so
          // this is the only way offTick could fail to land in the future.
          const dur = hit.note.durationTicks >= 1 ? hit.note.durationTicks : 1;
          events.push({
            clipId: clip.id, trackId: clip.trackId, noteId: hit.note.id, midi,
            velocity: clamp(hit.note.velocity * (clip.velocityScale ?? 1), 0, 1),
            onTick, offTick: Math.min(onTick + dur, boundary),
          });
        }
      }
    }
  }
  events.sort((a, b) => (
    a.onTick !== b.onTick ? a.onTick - b.onTick
      : a.trackId !== b.trackId ? (a.trackId < b.trackId ? -1 : 1)
        : a.midi - b.midi));
  return events;
}

export interface NoteLedger {
  hold: (trackId: string, midi: number, velocity: number) => void;
  release: (trackId: string, midi: number) => void;
  /** Mute mid-note: silence one track and forget it, with no double release. */
  releaseTrack: (trackId: string) => void;
  releaseAll: () => void;
  readonly held: number;
}

/**
 * Who is sounding, refcounted per track per pitch, so a note retriggered before
 * its own release is not cut short by the earlier release. This is the object
 * standing between the transport and hung notes on real hardware, which is why
 * it is separable and tested as if it were the product. For a live performer,
 * it is.
 */
export function createNoteLedger(
  onNoteOn: (trackId: string, midi: number, velocity: number) => void,
  onNoteOff: (trackId: string, midi: number) => void,
): NoteLedger {
  const held = new Map<string, Map<number, number>>();
  const releaseTrack = (trackId: string): void => {
    const notes = held.get(trackId);
    if (!notes) return;
    held.delete(trackId);
    for (const midi of notes.keys()) onNoteOff(trackId, midi);
  };
  return {
    hold(trackId, midi, velocity) {
      let notes = held.get(trackId);
      if (!notes) { notes = new Map(); held.set(trackId, notes); }
      notes.set(midi, (notes.get(midi) ?? 0) + 1);
      onNoteOn(trackId, midi, velocity);
    },
    release(trackId, midi) {
      const notes = held.get(trackId);
      const left = (notes?.get(midi) ?? 1) - 1;
      if (notes && left > 0) { notes.set(midi, left); return; }
      notes?.delete(midi);
      if (notes && notes.size === 0) held.delete(trackId);
      onNoteOff(trackId, midi);
    },
    releaseTrack,
    releaseAll() { for (const trackId of [...held.keys()]) releaseTrack(trackId); },
    get held() { let n = 0; for (const m of held.values()) n += m.size; return n; },
  };
}
