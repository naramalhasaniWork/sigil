/**
 * Pure loop/pattern maths. No audio, no React, no clock — every function here
 * is deterministic and returns new values, so the scheduler can be reasoned
 * about (and tested) without ever making a sound.
 *
 * Positions are ticks. A tick is 1/PPQ of a beat, which is fine enough that
 * quantisation never fights the grid and coarse enough to stay in integers.
 */

/** Ticks per quarter note. 96 divides cleanly by 2, 3, 4, 6, 8, 12, 16, 24, 32. */
export const PPQ = 96;

export interface SeqNote {
  id: string;
  midi: number;
  velocity: number;
  /** Position inside the loop, expected in [0, patternTicks). */
  startTick: number;
  durationTicks: number;
  /** Which overdub layer laid this down. Undo strips one whole pass. */
  pass: number;
}

export interface Pattern {
  lengthBars: number;
  beatsPerBar: number;
  ppq: number;
  notes: readonly SeqNote[];
}

function wrap(value: number, total: number): number {
  return ((value % total) + total) % total;
}

export function createPattern(lengthBars: number, beatsPerBar = 4): Pattern {
  return {
    lengthBars: Math.max(1, Math.floor(lengthBars)),
    beatsPerBar: Math.max(1, Math.floor(beatsPerBar)),
    ppq: PPQ,
    notes: [],
  };
}

export function patternTicks(p: Pattern): number {
  return p.lengthBars * p.beatsPerBar * p.ppq;
}

export function ticksPerBar(p: Pattern): number {
  return p.beatsPerBar * p.ppq;
}

/**
 * Total order over notes, so every function that rebuilds the note list emits
 * the same array for the same inputs. Determinism is the whole contract here.
 */
function compareNotes(a: SeqNote, b: SeqNote): number {
  if (a.startTick !== b.startTick) return a.startTick - b.startTick;
  if (a.midi !== b.midi) return a.midi - b.midi;
  if (a.pass !== b.pass) return a.pass - b.pass;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function addNote(p: Pattern, note: SeqNote): Pattern {
  return { ...p, notes: [...p.notes, note].sort(compareNotes) };
}

/** Undo one overdub layer. Notes from every other pass survive untouched. */
export function removePass(p: Pattern, pass: number): Pattern {
  const notes = p.notes.filter((n) => n.pass !== pass);
  return notes.length === p.notes.length ? p : { ...p, notes };
}

export function clearPattern(p: Pattern): Pattern {
  return p.notes.length === 0 ? p : { ...p, notes: [] };
}

/**
 * Move one tick toward the nearest grid line. `strength` blends rather than
 * snaps: 0 leaves the performance alone, 1 lands dead on the grid, 0.5 takes
 * half the error out. Hard snapping is what makes cheap sequencers sound
 * machine-stiff, so partial is the default a musician actually wants.
 *
 * A tick that quantises up onto the loop end wraps to the start, because the
 * loop end and the loop start are the same instant.
 */
export function quantiseTick(
  tick: number,
  division: number,
  strength: number,
  totalTicks: number,
): number {
  if (!(division > 0) || !(strength > 0)) return tick;
  const s = strength > 1 ? 1 : strength;
  const target = Math.round(tick / division) * division;
  const moved = Math.round(tick + (target - tick) * s);
  return totalTicks > 0 ? wrap(moved, totalTicks) : moved;
}

/** `division` is in ticks — PPQ is a quarter, PPQ / 4 a sixteenth. */
export function quantise(p: Pattern, division: number, strength: number): Pattern {
  if (!(division > 0) || !(strength > 0)) return p;
  const total = patternTicks(p);
  const notes = p.notes.map((n) => {
    const startTick = quantiseTick(n.startTick, division, strength, total);
    return startTick === n.startTick ? n : { ...n, startTick };
  });
  return { ...p, notes: notes.sort(compareNotes) };
}

/**
 * Every note whose start falls in the half-open window [fromTick, toTick).
 *
 * The window is expressed in *absolute* ticks — it may run past the end of the
 * loop, and when it does it wraps to the start rather than falling off the end.
 * This is the one function the whole looper leans on: get it wrong and a note
 * near the loop point is dropped once per pass, which is exactly the failure
 * that "feels off" without ever looking broken.
 *
 * Results are ordered by how far into the window each note sits, so a caller
 * that walks the list is walking forward in time. A window at least as long as
 * the pattern yields every note exactly once (never repeated per lap).
 */
export function notesInWindow(p: Pattern, fromTick: number, toTick: number): SeqNote[] {
  const total = patternTicks(p);
  const span = toTick - fromTick;
  if (total <= 0 || span <= 0) return [];
  const width = span >= total ? total : span;
  const from = wrap(fromTick, total);

  const hits: Array<{ rel: number; note: SeqNote }> = [];
  for (const note of p.notes) {
    const rel = wrap(note.startTick - from, total);
    if (rel < width) hits.push({ rel, note });
  }
  hits.sort((a, b) => (a.rel !== b.rel ? a.rel - b.rel : compareNotes(a.note, b.note)));
  return hits.map((h) => h.note);
}

export interface ScheduledNote {
  note: SeqNote;
  /** Absolute tick, on the same timeline as the window — already unwrapped. */
  absTick: number;
}

/**
 * Resolve a lookahead window into absolute positions the transport can turn
 * straight into wall-clock times. This is where the loop boundary is actually
 * handled: a note at tick 3 seen from a window starting at tick 380 comes back
 * as absolute tick 387, i.e. next lap, not "3 ticks ago".
 */
export function scheduleWindow(p: Pattern, fromTick: number, toTick: number): ScheduledNote[] {
  const total = patternTicks(p);
  if (total <= 0 || toTick <= fromTick) return [];
  const from = wrap(fromTick, total);
  return notesInWindow(p, fromTick, toTick).map((note) => ({
    note,
    absTick: fromTick + wrap(note.startTick - from, total),
  }));
}

/** Metronome positions inside the same half-open absolute window. */
export function beatsInWindow(
  p: Pattern,
  fromTick: number,
  toTick: number,
): Array<{ absTick: number; downbeat: boolean }> {
  const out: Array<{ absTick: number; downbeat: boolean }> = [];
  if (p.ppq <= 0 || toTick <= fromTick) return out;
  for (let beat = Math.ceil(fromTick / p.ppq); beat * p.ppq < toTick; beat++) {
    out.push({ absTick: beat * p.ppq, downbeat: wrap(beat, p.beatsPerBar) === 0 });
  }
  return out;
}

/** Milliseconds one tick lasts at `bpm`. At 120bpm/PPQ 96 a beat is 500ms. */
export function msPerTick(bpm: number, ppq: number = PPQ): number {
  if (!(bpm > 0) || !(ppq > 0)) return 0;
  return 60000 / (bpm * ppq);
}

export function ticksToMs(ticks: number, bpm: number, ppq: number = PPQ): number {
  return ticks * msPerTick(bpm, ppq);
}

/** 1-indexed readout, the way a transport display counts. */
export function barBeatOfTick(p: Pattern, tick: number): { bar: number; beat: number } {
  const total = patternTicks(p);
  if (total <= 0) return { bar: 1, beat: 1 };
  const pos = wrap(tick, total);
  const perBar = ticksPerBar(p);
  return {
    bar: Math.floor(pos / perBar) + 1,
    beat: Math.floor((pos % perBar) / p.ppq) + 1,
  };
}
