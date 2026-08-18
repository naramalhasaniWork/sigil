import { describe, it, expect } from 'vitest';
import {
  PPQ,
  addNote,
  barBeatOfTick,
  clearPattern,
  createPattern,
  msPerTick,
  notesInWindow,
  patternTicks,
  quantise,
  quantiseTick,
  removePass,
  ticksToMs,
  type Pattern,
  type SeqNote,
} from '@/dsp/sequencer';

function note(id: string, startTick: number, extra: Partial<SeqNote> = {}): SeqNote {
  return {
    id,
    midi: 60,
    velocity: 1,
    startTick,
    durationTicks: 24,
    pass: 0,
    ...extra,
  };
}

function ids(notes: readonly SeqNote[]): string[] {
  return notes.map((n) => n.id);
}

function build(notes: readonly SeqNote[], bars = 1): Pattern {
  return notes.reduce<Pattern>((p, n) => addNote(p, n), createPattern(bars));
}

/** One bar of 4/4 at PPQ 96 = 384 ticks. */
const A = note('a', 0);
const B = note('b', 96);
const C = note('c', 192);
const D = note('d', 288);
const E = note('e', 380);
const ONE_BAR = build([A, B, C, D, E]);

describe('patternTicks', () => {
  it('is bars x beats x ppq', () => {
    expect(patternTicks(createPattern(1))).toBe(1 * 4 * PPQ);
    expect(patternTicks(createPattern(4))).toBe(4 * 4 * PPQ);
    expect(patternTicks(createPattern(2, 3))).toBe(2 * 3 * PPQ);
    expect(patternTicks(createPattern(8, 7))).toBe(8 * 7 * PPQ);
  });

  it('floors and floors to at least one bar and one beat', () => {
    expect(patternTicks(createPattern(0))).toBe(4 * PPQ);
    expect(patternTicks(createPattern(2.9))).toBe(2 * 4 * PPQ);
  });
});

describe('msPerTick / ticksToMs', () => {
  it('makes one beat 500ms at 120bpm, so one tick is 500/96 ms', () => {
    expect(msPerTick(120)).toBeCloseTo(500 / 96, 10);
    expect(ticksToMs(PPQ, 120)).toBeCloseTo(500, 10);
    expect(msPerTick(120) * PPQ).toBeCloseTo(500, 10);
  });

  it('is correct at other known tempos', () => {
    expect(ticksToMs(PPQ, 60)).toBeCloseTo(1000, 10);
    expect(ticksToMs(PPQ, 240)).toBeCloseTo(250, 10);
    expect(ticksToMs(4 * PPQ, 90)).toBeCloseTo(4 * (60000 / 90), 10);
    expect(ticksToMs(48, 120)).toBeCloseTo(250, 10);
  });

  it('honours a non-default ppq', () => {
    expect(msPerTick(120, 480)).toBeCloseTo(500 / 480, 10);
    expect(ticksToMs(480, 120, 480)).toBeCloseTo(500, 10);
  });

  it('refuses to produce Infinity for nonsense tempos', () => {
    expect(msPerTick(0)).toBe(0);
    expect(msPerTick(-120)).toBe(0);
  });
});

describe('notesInWindow', () => {
  it('returns exactly the notes in a non-wrapping window, half-open', () => {
    // 96 is the start of b, and the window end is exclusive.
    expect(ids(notesInWindow(ONE_BAR, 0, 96))).toEqual(['a']);
    expect(ids(notesInWindow(ONE_BAR, 0, 97))).toEqual(['a', 'b']);
    expect(ids(notesInWindow(ONE_BAR, 96, 300))).toEqual(['b', 'c', 'd']);
    expect(ids(notesInWindow(ONE_BAR, 97, 192))).toEqual([]);
    expect(ids(notesInWindow(ONE_BAR, 192, 193))).toEqual(['c']);
  });

  it('wraps the loop point and orders notes by time from the window start', () => {
    // from 370, 30 ticks wide: e at 380 (rel 10) then a at 0 (rel 14).
    expect(ids(notesInWindow(ONE_BAR, 370, 400))).toEqual(['e', 'a']);
    // Straddling with nothing on the far side of the loop point.
    expect(ids(notesInWindow(ONE_BAR, 300, 384))).toEqual(['e']);
    // The boundary itself: a at tick 0 belongs to the new lap.
    expect(ids(notesInWindow(ONE_BAR, 383, 385))).toEqual(['a']);
  });

  it('normalises a window that starts beyond the end of the pattern', () => {
    const total = patternTicks(ONE_BAR);
    expect(ids(notesInWindow(ONE_BAR, total + 370, total + 400))).toEqual(['e', 'a']);
    expect(ids(notesInWindow(ONE_BAR, 3 * total, 3 * total + 97))).toEqual(['a', 'b']);
    // A negative start is still a real 15-tick window: e at 380 (rel 10), a at 0 (rel 14).
    expect(ids(notesInWindow(ONE_BAR, -14, 1))).toEqual(['e', 'a']);
    expect(ids(notesInWindow(ONE_BAR, -14, 0))).toEqual(['e']);
  });

  it('returns every note exactly once for a window longer than the pattern', () => {
    // 500 ticks from 200: order is by distance forward from tick 200.
    expect(ids(notesInWindow(ONE_BAR, 200, 700))).toEqual(['d', 'e', 'a', 'b', 'c']);
    expect(ids(notesInWindow(ONE_BAR, 0, 10_000))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('is empty for an empty or inverted window', () => {
    expect(notesInWindow(ONE_BAR, 100, 100)).toEqual([]);
    expect(notesInWindow(ONE_BAR, 100, 50)).toEqual([]);
    expect(notesInWindow(createPattern(1), 0, 384)).toEqual([]);
  });

  it('keeps simultaneous notes together and in a stable order', () => {
    const chord = build([
      note('hi', 48, { midi: 67 }),
      note('lo', 48, { midi: 60 }),
      note('mid', 48, { midi: 64 }),
    ]);
    expect(ids(notesInWindow(chord, 0, 384))).toEqual(['lo', 'mid', 'hi']);
  });
});

describe('quantise', () => {
  const SIXTEENTH = PPQ / 4; // 24 ticks
  const off = build([note('off', 30), note('on', 96)]);

  it('lands exactly on the grid at strength 1', () => {
    const q = quantise(off, SIXTEENTH, 1);
    expect(q.notes.find((n) => n.id === 'off')?.startTick).toBe(24);
    for (const n of q.notes) expect(n.startTick % SIXTEENTH).toBe(0);
  });

  it('changes nothing at strength 0', () => {
    expect(quantise(off, SIXTEENTH, 0)).toBe(off);
    expect(quantise(off, SIXTEENTH, -1)).toBe(off);
    expect(quantise(off, 0, 1)).toBe(off);
  });

  it('moves halfway at strength 0.5', () => {
    const q = quantise(off, SIXTEENTH, 0.5);
    // 30 is 6 ticks late; half of that is 3, so it lands on 27.
    expect(q.notes.find((n) => n.id === 'off')?.startTick).toBe(27);
  });

  it('never moves a note that is already on the grid, at any strength', () => {
    for (const strength of [0, 0.25, 0.5, 0.75, 1]) {
      const q = quantise(off, SIXTEENTH, strength);
      expect(q.notes.find((n) => n.id === 'on')?.startTick).toBe(96);
    }
  });

  it('wraps a note that quantises onto the loop end back to the start', () => {
    const late = build([note('late', 380)]);
    // Nearest quarter to 380 is 384, which is the loop end == the loop start.
    expect(quantise(late, PPQ, 1).notes[0]?.startTick).toBe(0);
    expect(quantiseTick(380, PPQ, 1, 384)).toBe(0);
  });

  it('leaves everything except startTick alone', () => {
    const q = quantise(off, SIXTEENTH, 1);
    const moved = q.notes.find((n) => n.id === 'off');
    expect(moved).toMatchObject({ id: 'off', midi: 60, velocity: 1, durationTicks: 24, pass: 0 });
  });
});

describe('removePass', () => {
  const layered = build([
    note('p0-a', 0, { pass: 0 }),
    note('p1-a', 48, { pass: 1 }),
    note('p2-a', 96, { pass: 2 }),
    note('p1-b', 144, { pass: 1 }),
    note('p0-b', 192, { pass: 0 }),
  ]);

  it('strips only the targeted pass', () => {
    expect(ids(removePass(layered, 1).notes)).toEqual(['p0-a', 'p2-a', 'p0-b']);
    expect(ids(removePass(layered, 0).notes)).toEqual(['p1-a', 'p2-a', 'p1-b']);
  });

  it('leaves the surviving notes byte-for-byte identical', () => {
    const after = removePass(layered, 1);
    for (const n of after.notes) {
      expect(n).toBe(layered.notes.find((o) => o.id === n.id));
    }
  });

  it('is a no-op for a pass that is not there', () => {
    expect(removePass(layered, 7)).toBe(layered);
  });
});

describe('immutability', () => {
  const base = build([note('a', 0, { pass: 0 }), note('b', 96, { pass: 1 })]);
  const snapshot = JSON.stringify(base);

  it('addNote does not touch its input', () => {
    const next = addNote(base, note('c', 48));
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(base.notes).toHaveLength(2);
    expect(next.notes).toHaveLength(3);
    expect(next.notes).not.toBe(base.notes);
  });

  it('removePass does not touch its input', () => {
    const next = removePass(base, 1);
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(base.notes).toHaveLength(2);
    expect(next.notes).toHaveLength(1);
  });

  it('clearPattern does not touch its input', () => {
    const next = clearPattern(base);
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(base.notes).toHaveLength(2);
    expect(next.notes).toHaveLength(0);
    expect(next.lengthBars).toBe(base.lengthBars);
    expect(clearPattern(next)).toBe(next);
  });

  it('quantise does not touch its input or its surviving notes', () => {
    const messy = build([note('x', 30), note('y', 100)]);
    const before = JSON.stringify(messy);
    const next = quantise(messy, PPQ / 4, 1);
    expect(JSON.stringify(messy)).toBe(before);
    expect(messy.notes[0]?.startTick).toBe(30);
    expect(next.notes[0]?.startTick).toBe(24);
  });

  it('notesInWindow returns a fresh array of the original notes', () => {
    const found = notesInWindow(base, 0, 384);
    expect(found).not.toBe(base.notes);
    expect(found[0]).toBe(base.notes[0]);
    found.length = 0;
    expect(base.notes).toHaveLength(2);
  });
});

describe('barBeatOfTick', () => {
  const two = createPattern(2);

  it('counts from one and wraps the loop', () => {
    expect(barBeatOfTick(two, 0)).toEqual({ bar: 1, beat: 1 });
    expect(barBeatOfTick(two, PPQ)).toEqual({ bar: 1, beat: 2 });
    expect(barBeatOfTick(two, 4 * PPQ)).toEqual({ bar: 2, beat: 1 });
    expect(barBeatOfTick(two, 7 * PPQ + 95)).toEqual({ bar: 2, beat: 4 });
    expect(barBeatOfTick(two, 8 * PPQ)).toEqual({ bar: 1, beat: 1 });
    expect(barBeatOfTick(two, -1)).toEqual({ bar: 2, beat: 4 });
  });
});
