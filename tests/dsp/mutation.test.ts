import { describe, it, expect } from 'vitest';
import type { EngineDescriptor, ParamDescriptor } from '@/audio/types';
import {
  makeRng, randomPatch, defaultPatch, mutate, breed, variations,
  normalise, denormalise, type Patch,
} from '@/dsp/mutation';

/** Covers every awkward case: log sweep, stepped selector, frozen param, fully mobile param, bipolar range, and an exp range whose minimum is zero. */
const FIXTURE: EngineDescriptor = {
  id: 'fixture',
  name: 'Fixture',
  colour: '#FF6B6B',
  macroNames: ['Body', 'Air', 'Grit', 'Motion'],
  params: [
    {
      id: 'cutoff', name: 'Cutoff', group: 'Filter', unit: 'hz',
      min: 20, max: 18000, default: 1800, curve: 'exp', macro: 0, macroDepth: 0.8, mutability: 1,
      explain: 'The brightness control: everything above this frequency is removed, so lowering it makes the sound darker and further away.',
    },
    {
      id: 'shape', name: 'Shape', group: 'Oscillators', unit: 'none',
      min: 0, max: 3, default: 1, curve: 'stepped', steps: 4, macro: 1, macroDepth: 0.5, mutability: 0.9,
      explain: 'Chooses the waveform the oscillator produces. Each shape has a different harmonic content, which is the coarsest change you can make to a tone.',
    },
    {
      id: 'tuning', name: 'Tuning', group: 'Global', unit: 'semitones',
      min: -12, max: 12, default: 0, curve: 'linear', macro: 2, macroDepth: 0.2, mutability: 0,
      explain: 'Transposes the whole engine in semitones. Frozen during hunts because a patch that is out of tune is useless no matter how good it sounds.',
    },
    {
      id: 'drift', name: 'Drift', group: 'Character', unit: 'pct',
      min: 0, max: 1, default: 0.25, curve: 'linear', macro: 3, macroDepth: 0.5, mutability: 1,
      explain: 'Slow random wandering of pitch, imitating analog circuits that never sit still. It is the cheapest way to stop a digital sound feeling sterile.',
    },
    {
      id: 'attack', name: 'Attack', group: 'Envelope', unit: 'ms',
      min: 0.5, max: 4000, default: 4, curve: 'exp',
      explain: 'How long a note takes to reach full volume. Short is percussive, long turns any sound into a pad that swells in from nothing.',
    },
    {
      id: 'fold', name: 'Fold', group: 'Character', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'exp', mutability: 0.7,
      explain: 'Folds the waveform back on itself to add hard harmonics. Its range starts at zero, so it also exercises the log-space fallback path.',
    },
  ],
};

const P_CUTOFF = 0, P_SHAPE = 1, P_TUNING = 2, P_DRIFT = 3, P_FOLD = 5;

function paramAt(i: number): ParamDescriptor {
  const p = FIXTURE.params[i];
  if (p === undefined) throw new Error(`no param ${i}`);
  return p;
}

function at(patch: Patch, i: number): number {
  const v = patch.values[i];
  if (v === undefined) throw new Error(`no value ${i}`);
  return v;
}

function expectInRange(patch: Patch): void {
  for (let i = 0; i < FIXTURE.params.length; i++) {
    const p = paramAt(i);
    const v = at(patch, i);
    expect(Number.isFinite(v), `${p.id} finite`).toBe(true);
    expect(v, `${p.id} in range`).toBeGreaterThanOrEqual(p.min);
    expect(v, `${p.id} in range`).toBeLessThanOrEqual(p.max);
  }
}

/** Stepped values must land exactly on a step, never between two. */
function expectOnStep(patch: Patch, index: number): void {
  const p = paramAt(index);
  const t = ((at(patch, index) - p.min) / (p.max - p.min)) * ((p.steps ?? 2) - 1);
  expect(Math.abs(t - Math.round(t)), `${p.id} off step`).toBeLessThan(1e-4);
}

function norm(patch: Patch, i: number): number {
  return normalise(at(patch, i), paramAt(i));
}

function key(patch: Patch): string {
  return Array.from(patch.values).join(',');
}

describe('makeRng', () => {
  it('is deterministic and stays inside [0, 1)', () => {
    const a = makeRng(12345), b = makeRng(12345);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('produces a different stream for a different seed', () => {
    const a = makeRng(1);
    const b = makeRng(2);
    let differences = 0;
    for (let i = 0; i < 50; i++) if (a() !== b()) differences++;
    expect(differences).toBeGreaterThan(40);
  });
  it('does not collapse when seeded with zero', () => {
    const rng = makeRng(0);
    const seen = new Set<number>();
    for (let i = 0; i < 100; i++) seen.add(rng());
    expect(seen.size).toBeGreaterThan(90);
  });
});

describe('normalise / denormalise', () => {
  it('round-trips every continuous parameter exactly', () => {
    for (let i = 0; i < FIXTURE.params.length; i++) {
      const p = paramAt(i);
      if (p.curve === 'stepped') continue;
      for (const n of [0, 0.25, 0.5, 0.75, 1]) {
        const v = denormalise(n, p);
        expect(v).toBeGreaterThanOrEqual(p.min);
        expect(v).toBeLessThanOrEqual(p.max);
        expect(normalise(v, p)).toBeCloseTo(n, 9);
      }
    }
  });

  it('snaps a stepped parameter to the nearest step, never between', () => {
    const shape = paramAt(P_SHAPE);
    expect(denormalise(0, shape)).toBe(0);
    expect(denormalise(0.32, shape)).toBe(1);
    expect(denormalise(0.5, shape)).toBe(2);
    expect(denormalise(1, shape)).toBe(3);
  });

  it('walks exponential parameters in log space, not linear space', () => {
    const cutoff = paramAt(P_CUTOFF);
    // Linear mapping would put the midpoint near 9 kHz; log space puts it at
    // the geometric mean, which is what makes low cutoffs reachable at all.
    expect(denormalise(0.5, cutoff)).toBeCloseTo(Math.sqrt(20 * 18000), 2);
    expect(denormalise(0, cutoff)).toBeCloseTo(20, 6);
    expect(denormalise(1, cutoff)).toBeCloseTo(18000, 2);
  });
});

describe('randomPatch', () => {
  it('is deterministic for a given seed', () => {
    const a = randomPatch(FIXTURE, makeRng(7));
    const b = randomPatch(FIXTURE, makeRng(7));
    expect(key(a)).toBe(key(b));
    expect(a.engineId).toBe('fixture');
    expect(a.values.length).toBe(FIXTURE.params.length);
  });

  it('stays in range, lands on steps, and reaches the bottom decade', () => {
    const rng = makeRng(99);
    let low = 0;
    for (let i = 0; i < 400; i++) {
      const patch = randomPatch(FIXTURE, rng);
      expectInRange(patch);
      expectOnStep(patch, P_SHAPE);
      if (at(patch, P_CUTOFF) < 200) low++;
    }
    // Log-space sampling is the only way a 20 Hz..18 kHz range ever goes dark.
    expect(low).toBeGreaterThan(40);
  });
});

describe('mutate', () => {
  it('is deterministic for a given seed', () => {
    const seed = defaultPatch(FIXTURE);
    const a = mutate(seed, FIXTURE, 0.4, makeRng(31));
    const b = mutate(seed, FIXTURE, 0.4, makeRng(31));
    expect(key(a)).toBe(key(b));
  });

  it('never leaves a parameter out of range, however hard it is driven', () => {
    const rng = makeRng(5);
    let patch = randomPatch(FIXTURE, rng);
    for (let i = 0; i < 2000; i++) {
      patch = mutate(patch, FIXTURE, 1, rng);
      expectInRange(patch);
      expectOnStep(patch, P_SHAPE);
    }
  });

  it('leaves a mutability-0 parameter completely untouched', () => {
    const rng = makeRng(17);
    const start = randomPatch(FIXTURE, rng);
    const frozen = at(start, P_TUNING);
    let patch = start;
    for (let i = 0; i < 500; i++) {
      patch = mutate(patch, FIXTURE, 1, rng);
      expect(at(patch, P_TUNING)).toBe(frozen);
    }
    // Zero amount freezes everything, for the same reason.
    expect(key(mutate(start, FIXTURE, 0, rng))).toBe(key(start));
  });

  it('moves a mutability-1 parameter a lot more than a low-mutability one', () => {
    const rng = makeRng(23);
    const seed = defaultPatch(FIXTURE);
    let drift = 0;
    let fold = 0;
    for (let i = 0; i < 200; i++) {
      const child = mutate(seed, FIXTURE, 0.5, rng);
      drift += Math.abs(norm(child, P_DRIFT) - norm(seed, P_DRIFT));
      fold += Math.abs(norm(child, P_FOLD) - norm(seed, P_FOLD));
    }
    expect(drift).toBeGreaterThan(0);
    expect(drift).toBeGreaterThan(fold * 1.2);
  });
});

describe('breed', () => {
  it('is deterministic, in range, on steps, and keeps the engine id', () => {
    const a = randomPatch(FIXTURE, makeRng(11));
    const b = randomPatch(FIXTURE, makeRng(12));
    expect(key(breed(a, b, FIXTURE, makeRng(9)))).toBe(key(breed(a, b, FIXTURE, makeRng(9))));
    const rng = makeRng(64);
    for (let i = 0; i < 300; i++) {
      const child = breed(randomPatch(FIXTURE, rng), randomPatch(FIXTURE, rng), FIXTURE, rng);
      expectInRange(child);
      expectOnStep(child, P_SHAPE);
      expect(child.engineId).toBe('fixture');
    }
  });

  it('takes a frozen parameter verbatim from one parent or the other', () => {
    const rng = makeRng(88);
    let fromA = 0;
    let fromB = 0;
    for (let i = 0; i < 200; i++) {
      const a = randomPatch(FIXTURE, rng);
      const b = randomPatch(FIXTURE, rng);
      const child = breed(a, b, FIXTURE, rng);
      const v = at(child, P_TUNING);
      expect(v === at(a, P_TUNING) || v === at(b, P_TUNING)).toBe(true);
      if (v === at(a, P_TUNING)) fromA++;
      if (v === at(b, P_TUNING)) fromB++;
    }
    expect(fromA).toBeGreaterThan(40);
    expect(fromB).toBeGreaterThan(40);
  });

  it('stays near its parents rather than re-randomising', () => {
    const rng = makeRng(101);
    const a = defaultPatch(FIXTURE);
    const p = paramAt(P_CUTOFF);
    for (let i = 0; i < 50; i++) {
      const child = breed(a, a, FIXTURE, rng);
      expect(Math.abs(normalise(at(child, P_CUTOFF), p) - normalise(at(a, P_CUTOFF), p))).toBeLessThan(0.1);
    }
  });
});

describe('variations', () => {
  it('returns exactly the requested count', () => {
    const rng = makeRng(55);
    const seed = defaultPatch(FIXTURE);
    expect(variations(seed, FIXTURE, 6, 0.5, rng).length).toBe(6);
    expect(variations(seed, FIXTURE, 1, 0.5, rng).length).toBe(1);
    expect(variations(seed, FIXTURE, 0, 0.5, rng).length).toBe(0);
  });

  it('returns children that are all distinct from each other', () => {
    const rng = makeRng(1234);
    for (let round = 0; round < 50; round++) {
      const kids = variations(randomPatch(FIXTURE, rng), FIXTURE, 6, 0.5, rng);
      expect(new Set(kids.map(key)).size).toBe(6);
      for (const kid of kids) {
        expectInRange(kid);
        expectOnStep(kid, P_SHAPE);
      }
    }
  });

  it('is deterministic for a given seed', () => {
    const seed = defaultPatch(FIXTURE);
    const a = variations(seed, FIXTURE, 6, 0.6, makeRng(2026));
    const b = variations(seed, FIXTURE, 6, 0.6, makeRng(2026));
    expect(a.map(key)).toEqual(b.map(key));
  });

  it('spreads from near neighbours to wilder children', () => {
    const rng = makeRng(808);
    const seed = defaultPatch(FIXTURE);
    let near = 0;
    let far = 0;
    for (let round = 0; round < 200; round++) {
      const kids = variations(seed, FIXTURE, 6, 0.8, rng);
      const first = kids[0];
      const last = kids[5];
      if (first === undefined || last === undefined) throw new Error('missing child');
      near += Math.abs(norm(first, P_CUTOFF) - norm(seed, P_CUTOFF));
      far += Math.abs(norm(last, P_CUTOFF) - norm(seed, P_CUTOFF));
    }
    expect(far).toBeGreaterThan(near * 1.5);
  });
});
