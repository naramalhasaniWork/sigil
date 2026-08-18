import { describe, it, expect } from 'vitest';
import {
  DIVISIONS, DEFAULT_DIVISION_ID, divisionById,
  divisionMs, divisionHz, nearestDivision, clampSynced,
} from '@/dsp/tempo';

describe('divisions', () => {
  it('has unique ids and positive lengths', () => {
    const ids = DIVISIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of DIVISIONS) expect(d.whole).toBeGreaterThan(0);
  });

  it('is ordered long to short, the way a musician reads a list', () => {
    for (let i = 1; i < DIVISIONS.length; i++) {
      expect((DIVISIONS[i] as { whole: number }).whole)
        .toBeLessThan((DIVISIONS[i - 1] as { whole: number }).whole);
    }
  });

  it('resolves the default', () => {
    expect(divisionById(DEFAULT_DIVISION_ID)).toBeDefined();
    expect(divisionById('nonsense')).toBeUndefined();
  });
});

/*
 * The numbers a DAW would show. If these drift, synced delays stop lining up
 * with the project and the feature is worse than not having it — a delay that
 * is nearly in time is more distracting than one that is obviously free.
 */
describe('agreement with what a DAW shows', () => {
  const q = divisionById('1/4') as { whole: number };
  const e = divisionById('1/8') as { whole: number };
  const ed = divisionById('1/8d') as { whole: number };
  const et = divisionById('1/8t') as { whole: number };

  it('puts 1/4 at 120 BPM on 500 ms', () => {
    expect(divisionMs(120, q.whole)).toBeCloseTo(500, 9);
  });

  it('puts 1/8 at 120 BPM on 250 ms', () => {
    expect(divisionMs(120, e.whole)).toBeCloseTo(250, 9);
  });

  it('makes a dotted eighth half again an eighth', () => {
    expect(divisionMs(120, ed.whole)).toBeCloseTo(375, 9);
  });

  it('fits three eighth triplets in the space of a quarter', () => {
    expect(divisionMs(120, et.whole) * 3).toBeCloseTo(divisionMs(120, q.whole), 9);
  });

  it('halves every time the tempo doubles', () => {
    expect(divisionMs(240, q.whole)).toBeCloseTo(250, 9);
    expect(divisionMs(60, q.whole)).toBeCloseTo(1000, 9);
  });

  /*
   * A whole note is four beats, NOT one bar. In 3/4 a bar is three beats but a
   * 1/4 note is still 500 ms at 120. Conflating the two is the usual bug, and
   * it only shows up in projects that are not in 4/4 — which is exactly when
   * nobody is looking for it.
   */
  it('treats a whole note as four beats regardless of the meter', () => {
    const bar = divisionById('1/1') as { whole: number };
    expect(divisionMs(120, bar.whole)).toBeCloseTo(2000, 9);
  });
});

describe('LFO rate', () => {
  /* One full cycle per division. Getting this reciprocal backwards sounds
   * vaguely rhythmic and is never in time, which is worse than obviously wrong. */
  it('gives one cycle per beat for 1/4', () => {
    const q = divisionById('1/4') as { whole: number };
    expect(divisionHz(120, q.whole)).toBeCloseTo(2, 9);
  });

  it('is the reciprocal of the division time', () => {
    for (const d of DIVISIONS) {
      expect(divisionHz(96, d.whole)).toBeCloseTo(1000 / divisionMs(96, d.whole), 9);
    }
  });
});

describe('bad input', () => {
  it('returns zero rather than Infinity or NaN', () => {
    for (const bpm of [0, -120, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(divisionMs(bpm, 0.25)).toBe(0);
      expect(divisionHz(bpm, 0.25)).toBe(0);
    }
    expect(divisionMs(120, 0)).toBe(0);
    expect(divisionMs(120, Number.NaN)).toBe(0);
  });
});

describe('nearest division', () => {
  it('lands on the exact division when the value already is one', () => {
    expect(nearestDivision(500, 120).id).toBe('1/4');
    expect(nearestDivision(250, 120).id).toBe('1/8');
    expect(nearestDivision(375, 120).id).toBe('1/8d');
  });

  it('picks the closest when the value is between two', () => {
    // 260 ms at 120 is just above a 1/8 (250) and far from a dotted 1/8 (375).
    expect(nearestDivision(260, 120).id).toBe('1/8');
  });

  /*
   * Compared in the log domain: musically 200 against 100 is the same distance
   * as 800 against 400, and a linear comparison biases every choice toward the
   * longest divisions.
   */
  it('does not bias toward long divisions for short values', () => {
    expect(nearestDivision(60, 120).whole).toBeLessThan(0.125);
  });

  it('falls back rather than throwing on nonsense', () => {
    expect(nearestDivision(Number.NaN, 120).id).toBe(DEFAULT_DIVISION_ID);
    expect(nearestDivision(500, 0).id).toBe(DEFAULT_DIVISION_ID);
  });
});

describe('range clamping', () => {
  /* A 1-bar delay at 40 BPM is 6000 ms and delay-time stops at 2000. Silently
   * clamping downstream would look like a sync bug rather than a range limit. */
  it('reports when a division does not fit the parameter', () => {
    const bar = divisionById('1/1') as { whole: number };
    const wanted = divisionMs(40, bar.whole);
    expect(wanted).toBeGreaterThan(2000);
    const r = clampSynced(wanted, 1, 2000);
    expect(r.value).toBe(2000);
    expect(r.outOfRange).toBe(true);
  });

  it('passes an in-range value through untouched and unflagged', () => {
    const r = clampSynced(375, 1, 2000);
    expect(r.value).toBe(375);
    expect(r.outOfRange).toBe(false);
  });

  it('treats non-finite as out of range rather than passing it to the DSP', () => {
    expect(clampSynced(Number.NaN, 1, 2000).outOfRange).toBe(true);
    expect(Number.isFinite(clampSynced(Number.NaN, 1, 2000).value)).toBe(true);
  });
});
