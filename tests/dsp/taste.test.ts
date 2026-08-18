import { describe, it, expect } from 'vitest';
import { ANALOG_DESCRIPTOR } from '@/dsp/analog-descriptor';
import { FM_DESCRIPTOR } from '@/dsp/fm-descriptor';
import { normalise, denormalise } from '@/dsp/mutation';
import { tasteFrom, blendTaste, decayTaste, applyTaste, tasteStrength } from '@/dsp/taste';
import type { EngineDescriptor } from '@/audio/types';

const D = ANALOG_DESCRIPTOR;

function defaults(d: EngineDescriptor): Float32Array {
  const v = new Float32Array(d.params.length);
  for (let i = 0; i < d.params.length; i++) v[i] = d.params[i]?.default ?? 0;
  return v;
}

function indexOf(d: EngineDescriptor, id: string): number {
  const i = d.params.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`no param ${id}`);
  return i;
}

/** A copy of `base` with one parameter set to a normalised position. */
function withParam(base: Float32Array, d: EngineDescriptor, id: string, n: number): Float32Array {
  const i = indexOf(d, id);
  const p = d.params[i];
  if (!p) throw new Error(id);
  const out = Float32Array.from(base);
  out[i] = denormalise(n, p);
  return out;
}

const CUTOFF = indexOf(D, 'filter-cutoff');

describe('tasteFrom', () => {
  it('is neutral when nothing was kept', () => {
    const t = tasteFrom(defaults(D), [], D);
    expect(t.length).toBe(D.params.length);
    expect(tasteStrength(t)).toBe(0);
  });

  it('leans toward the direction the kept patches sit in', () => {
    const seed = withParam(defaults(D), D, 'filter-cutoff', 0.5);
    const kept = [
      withParam(seed, D, 'filter-cutoff', 0.8),
      withParam(seed, D, 'filter-cutoff', 0.9),
    ];
    const t = tasteFrom(seed, kept, D);
    expect(t[CUTOFF]).toBeGreaterThan(0.2);
  });

  it('leans the other way when the kept patches are darker', () => {
    const seed = withParam(defaults(D), D, 'filter-cutoff', 0.5);
    const kept = [withParam(seed, D, 'filter-cutoff', 0.1)];
    expect(tasteFrom(seed, kept, D)[CUTOFF]).toBeLessThan(-0.2);
  });

  it('cancels out when the kept patches disagree', () => {
    const seed = withParam(defaults(D), D, 'filter-cutoff', 0.5);
    const kept = [
      withParam(seed, D, 'filter-cutoff', 0.9),
      withParam(seed, D, 'filter-cutoff', 0.1),
    ];
    expect(tasteFrom(seed, kept, D)[CUTOFF] ?? 1).toBeCloseTo(0, 3);
  });

  it('never exceeds the clamp, even from the most extreme keep possible', () => {
    const seed = withParam(defaults(D), D, 'filter-cutoff', 0);
    const kept = [withParam(seed, D, 'filter-cutoff', 1)];
    const t = tasteFrom(seed, kept, D);
    for (let i = 0; i < t.length; i++) {
      expect(Math.abs(t[i] ?? 0)).toBeLessThanOrEqual(0.5);
    }
  });

  it('does not produce NaN from a corrupt kept patch', () => {
    const seed = defaults(D);
    const bad = Float32Array.from(seed);
    bad.fill(NaN);
    for (const v of tasteFrom(seed, [bad], D)) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('blendTaste', () => {
  it('takes the new observation when there is no history', () => {
    const next = new Float32Array([0.3, -0.2]);
    const out = blendTaste(null, next, 0.5);
    expect(out[0]).toBeCloseTo(0.3, 6);
    expect(out[1]).toBeCloseTo(-0.2, 6);
  });

  it('mixes history and observation by alpha', () => {
    const prev = new Float32Array([0.4]);
    const next = new Float32Array([0]);
    expect(blendTaste(prev, next, 0.5)[0]).toBeCloseTo(0.2, 6);
  });

  it('discards a vector from a different engine rather than misapplying it', () => {
    // Parameter 7 means something else in FM than in Analog.
    const prev = new Float32Array(D.params.length).fill(0.4);
    const next = new Float32Array(FM_DESCRIPTOR.params.length).fill(0.1);
    const out = blendTaste(prev, next, 0.5);
    expect(out.length).toBe(FM_DESCRIPTOR.params.length);
    expect(out[0]).toBeCloseTo(0.1, 6);
  });

  it('cannot be walked past the clamp by repeated agreement', () => {
    let t: Float32Array | null = null;
    const next = new Float32Array([0.5]);
    for (let i = 0; i < 200; i++) t = blendTaste(t, next, 0.5);
    expect(Math.abs(t?.[0] ?? 1)).toBeLessThanOrEqual(0.5);
  });

  it('does not mutate its inputs', () => {
    const prev = new Float32Array([0.4]);
    const next = new Float32Array([0]);
    blendTaste(prev, next, 0.5);
    expect(prev[0]).toBeCloseTo(0.4, 6);
    expect(next[0]).toBe(0);
  });
});

describe('decayTaste', () => {
  it('fades toward neutral', () => {
    const t = decayTaste(new Float32Array([0.4, -0.4]), 0.5);
    expect(t[0]).toBeCloseTo(0.2, 6);
    expect(t[1]).toBeCloseTo(-0.2, 6);
  });

  it('reaches neutral if taste is never re-expressed', () => {
    let t: Float32Array = new Float32Array([0.5]);
    for (let i = 0; i < 200; i++) t = decayTaste(t, 0.85);
    expect(tasteStrength(t)).toBeCloseTo(0, 4);
  });
});

describe('applyTaste', () => {
  it('returns the seed unchanged when there is no taste', () => {
    const seed = defaults(D);
    const out = applyTaste(seed, new Float32Array(D.params.length), D, 0.6);
    for (let i = 0; i < seed.length; i++) {
      expect(out[i] ?? 0).toBeCloseTo(seed[i] ?? 0, 3);
    }
  });

  it('moves the seed along the taste direction', () => {
    const seed = withParam(defaults(D), D, 'filter-cutoff', 0.4);
    const taste = new Float32Array(D.params.length);
    taste[CUTOFF] = 0.4;
    const out = applyTaste(seed, taste, D, 1);
    const p = D.params[CUTOFF];
    if (!p) throw new Error('cutoff');
    expect(normalise(out[CUTOFF] ?? 0, p)).toBeCloseTo(0.8, 3);
  });

  it('nudges rather than teleports at partial strength', () => {
    const seed = withParam(defaults(D), D, 'filter-cutoff', 0.4);
    const taste = new Float32Array(D.params.length);
    taste[CUTOFF] = 0.4;
    const p = D.params[CUTOFF];
    if (!p) throw new Error('cutoff');
    const out = applyTaste(seed, taste, D, 0.5);
    expect(normalise(out[CUTOFF] ?? 0, p)).toBeCloseTo(0.6, 3);
  });

  it('keeps every value legal for its parameter, however hard it is pushed', () => {
    const seed = defaults(D);
    const taste = new Float32Array(D.params.length).fill(0.5);
    const out = applyTaste(seed, taste, D, 1);
    for (let i = 0; i < D.params.length; i++) {
      const p = D.params[i];
      if (!p) continue;
      expect(out[i] ?? 0, p.id).toBeGreaterThanOrEqual(p.min);
      expect(out[i] ?? 0, p.id).toBeLessThanOrEqual(p.max);
      expect(Number.isFinite(out[i] ?? NaN), p.id).toBe(true);
    }
  });

  it('ignores a taste vector sized for another engine', () => {
    const seed = defaults(D);
    const foreign = new Float32Array(FM_DESCRIPTOR.params.length).fill(0.5);
    const out = applyTaste(seed, foreign, D, 1);
    for (let i = 0; i < seed.length; i++) {
      expect(out[i] ?? 0).toBeCloseTo(seed[i] ?? 0, 3);
    }
  });

  it('cannot move a parameter more than half its range in one generation', () => {
    // The guardrail that keeps a hunt steerable: however saturated taste gets,
    // one generation is a nudge. Runaway would mean the seed teleports to a
    // wall and every child comes back identical.
    const p = D.params[CUTOFF];
    if (!p) throw new Error('cutoff');
    const seed = withParam(defaults(D), D, 'filter-cutoff', 0.5);
    const saturated = new Float32Array(D.params.length).fill(0.5);
    const out = applyTaste(seed, saturated, D, 0.6);
    const moved = normalise(out[CUTOFF] ?? 0, p) - 0.5;
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(0.5);
  });

  it('converges on what is kept, generation after generation, staying legal', () => {
    const p = D.params[CUTOFF];
    if (!p) throw new Error('cutoff');
    let seed = withParam(defaults(D), D, 'filter-cutoff', 0.5);
    let taste: Float32Array | null = null;
    const path: number[] = [];
    for (let gen = 0; gen < 8; gen++) {
      // The player keeps children a little brighter than whatever is offered.
      const kept = [withParam(seed, D, 'filter-cutoff',
        Math.min(1, normalise(seed[CUTOFF] ?? 0, p) + 0.1))];
      taste = decayTaste(blendTaste(taste, tasteFrom(seed, kept, D), 0.5), 0.85);
      seed = applyTaste(seed, taste, D, 0.6);
      path.push(normalise(seed[CUTOFF] ?? 0, p));
      for (let i = 0; i < D.params.length; i++) {
        const q = D.params[i];
        if (!q) continue;
        expect(seed[i] ?? 0, `${q.id} gen ${gen}`).toBeGreaterThanOrEqual(q.min);
        expect(seed[i] ?? 0, `${q.id} gen ${gen}`).toBeLessThanOrEqual(q.max);
      }
    }
    // Monotonic in the direction the player kept choosing, and it got somewhere.
    expect(path[0] ?? 0).toBeGreaterThan(0.5);
    expect(path[path.length - 1] ?? 0).toBeGreaterThan(0.7);
    for (let i = 1; i < path.length; i++) {
      expect(path[i] ?? 0, `generation ${i}`).toBeGreaterThanOrEqual(path[i - 1] ?? 0);
    }
  });

  it('leaves parameters the player never expressed a view on alone', () => {
    const res = indexOf(D, 'filter-resonance');
    const seed = withParam(defaults(D), D, 'filter-cutoff', 0.4);
    const kept = [withParam(seed, D, 'filter-cutoff', 0.9)];
    const out = applyTaste(seed, tasteFrom(seed, kept, D), D, 0.6);
    expect(out[res] ?? 0).toBeCloseTo(seed[res] ?? 0, 4);
  });
});

describe('tasteStrength', () => {
  it('is zero for neutral taste and one for saturated taste', () => {
    expect(tasteStrength(new Float32Array(8))).toBe(0);
    expect(tasteStrength(new Float32Array(8).fill(0.5))).toBeCloseTo(1, 6);
  });

  it('is zero for an empty vector', () => {
    expect(tasteStrength(new Float32Array(0))).toBe(0);
  });
});
