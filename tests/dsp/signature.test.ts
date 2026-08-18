import { describe, it, expect } from 'vitest';
import { ANALOG_DESCRIPTOR } from '@/dsp/analog-descriptor';
import { ENGINES } from '@/dsp/registry';
import {
  patchSignature, patchHash, sigilName, nameOf, uniqueName, sigilOf,
} from '@/dsp/signature';
import type { EngineDescriptor } from '@/audio/types';
import { denormalise } from '@/dsp/mutation';

function defaults(d: EngineDescriptor): Float32Array {
  const v = new Float32Array(d.params.length);
  for (let i = 0; i < d.params.length; i++) v[i] = d.params[i]?.default ?? 0;
  return v;
}

/** Every parameter answering to `macro` driven to a normalised position. */
function macroAt(d: EngineDescriptor, macro: number, position: number): Float32Array {
  const v = defaults(d);
  for (let i = 0; i < d.params.length; i++) {
    const p = d.params[i];
    if (!p || p.macro !== macro) continue;
    v[i] = denormalise(position, p);
  }
  return v;
}

describe('patchSignature', () => {
  it('reports every axis inside 0..1 for every engine at defaults', () => {
    for (const e of ENGINES) {
      const sig = patchSignature(defaults(e.descriptor), e.descriptor);
      for (const [axis, value] of Object.entries(sig)) {
        expect(Number.isFinite(value), `${e.descriptor.id}.${axis}`).toBe(true);
        expect(value, `${e.descriptor.id}.${axis}`).toBeGreaterThanOrEqual(0);
        expect(value, `${e.descriptor.id}.${axis}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('moves the axis whose macro moved, and leaves the others alone', () => {
    const dark = patchSignature(macroAt(ANALOG_DESCRIPTOR, 1, 0), ANALOG_DESCRIPTOR);
    const bright = patchSignature(macroAt(ANALOG_DESCRIPTOR, 1, 1), ANALOG_DESCRIPTOR);
    expect(bright.air).toBeGreaterThan(dark.air);
    expect(bright.body).toBeCloseTo(dark.body, 6);
    expect(bright.grit).toBeCloseTo(dark.grit, 6);
  });

  it('survives NaN and out-of-range values without producing NaN', () => {
    const v = defaults(ANALOG_DESCRIPTOR);
    v[0] = NaN;
    v[1] = 1e9;
    v[2] = -1e9;
    const sig = patchSignature(v, ANALOG_DESCRIPTOR);
    for (const value of Object.values(sig)) expect(Number.isFinite(value)).toBe(true);
  });

  it('treats a short values array as defaults rather than zeros', () => {
    const full = patchSignature(defaults(ANALOG_DESCRIPTOR), ANALOG_DESCRIPTOR);
    const empty = patchSignature(new Float32Array(0), ANALOG_DESCRIPTOR);
    // Float32 storage rounds the defaults, so compare to the precision a
    // parameter value actually carries.
    for (const axis of ['body', 'air', 'grit', 'motion', 'reach'] as const) {
      expect(empty[axis], axis).toBeCloseTo(full[axis], 6);
    }
  });
});

describe('patchHash', () => {
  it('is stable for the same patch', () => {
    const a = patchHash(defaults(ANALOG_DESCRIPTOR), ANALOG_DESCRIPTOR);
    const b = patchHash(defaults(ANALOG_DESCRIPTOR), ANALOG_DESCRIPTOR);
    expect(a).toBe(b);
  });

  it('ignores float noise but notices a real edit', () => {
    const base = defaults(ANALOG_DESCRIPTOR);
    const cutoff = ANALOG_DESCRIPTOR.params.findIndex((p) => p.id === 'filter-cutoff');
    expect(cutoff).toBeGreaterThanOrEqual(0);

    const nudged = Float32Array.from(base);
    nudged[cutoff] = (base[cutoff] ?? 0) * 1.0000001;
    expect(patchHash(nudged, ANALOG_DESCRIPTOR)).toBe(patchHash(base, ANALOG_DESCRIPTOR));

    const edited = Float32Array.from(base);
    edited[cutoff] = 12000;
    expect(patchHash(edited, ANALOG_DESCRIPTOR)).not.toBe(patchHash(base, ANALOG_DESCRIPTOR));
  });

  it('stays inside unsigned 32-bit', () => {
    const h = patchHash(defaults(ANALOG_DESCRIPTOR), ANALOG_DESCRIPTOR);
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('sigilName', () => {
  const neutral = { body: 0.5, air: 0.5, grit: 0.5, motion: 0.5, reach: 0.5 };

  it('always returns two words', () => {
    for (let h = 0; h < 64; h++) {
      const name = sigilName({ ...neutral, air: 0.95, body: 0.05 }, h * 2654435761);
      expect(name.split(' ')).toHaveLength(2);
    }
  });

  it('never describes a dark sound as bright, whatever the hash', () => {
    const dark = { ...neutral, air: 0.02, motion: 0.5 };
    const brightWords = new Set([
      'Bright', 'Silver', 'Keen', 'Pale', 'Open', 'Glazed', 'Lucid', 'Sheer',
    ]);
    for (let h = 0; h < 200; h++) {
      const first = sigilName(dark, h * 2654435761).split(' ')[0] ?? '';
      expect(brightWords.has(first), `hash ${h} gave ${first}`).toBe(false);
    }
  });

  it('reads the adjective off the most extreme axis', () => {
    // Air is furthest from neutral, so the adjective is an air word.
    const name = sigilName({ ...neutral, air: 0.98, grit: 0.7 }, 0);
    expect([
      'Bright', 'Silver', 'Keen', 'Pale', 'Open', 'Glazed', 'Lucid', 'Sheer',
    ]).toContain(name.split(' ')[0]);
  });

  it('takes the noun from a different axis than the adjective', () => {
    // Grit high is second, so the noun must come from grit's high nouns.
    const name = sigilName({ ...neutral, air: 0.98, grit: 0.9 }, 0);
    expect([
      'Ash', 'Cinder', 'Tar', 'Slag', 'Grindstone', 'Flint', 'Gravel', 'Iron',
    ]).toContain(name.split(' ')[1]);
  });

  it('is deterministic in (signature, hash)', () => {
    const sig = { ...neutral, body: 0.9, motion: 0.1 };
    expect(sigilName(sig, 12345)).toBe(sigilName(sig, 12345));
  });
});

describe('nameOf', () => {
  it('names every engine at defaults without blowing up', () => {
    for (const e of ENGINES) {
      const name = nameOf(defaults(e.descriptor), e.descriptor);
      expect(name.length).toBeGreaterThan(3);
      expect(name).not.toContain('undefined');
    }
  });
});

describe('uniqueName', () => {
  it('leaves a free name alone', () => {
    expect(uniqueName('Bright Tide', ['Rusted Bell'])).toBe('Bright Tide');
  });

  it('walks numerals when the name is taken', () => {
    expect(uniqueName('Bright Tide', ['Bright Tide'])).toBe('Bright Tide II');
    expect(uniqueName('Bright Tide', ['Bright Tide', 'Bright Tide II'])).toBe('Bright Tide III');
  });

  it('compares case- and space-insensitively, the way saving does', () => {
    expect(uniqueName('Bright Tide', ['  bright tide '])).toBe('Bright Tide II');
  });
});

describe('sigilOf', () => {
  it('keeps every coordinate inside the 0..100 box for every engine', () => {
    for (const e of ENGINES) {
      const s = sigilOf(defaults(e.descriptor), e.descriptor);
      const xs = [...s.spokes.map((p) => p.x), s.node.x, s.cut.x1, s.cut.x2];
      const ys = [...s.spokes.map((p) => p.y), s.node.y, s.cut.y1, s.cut.y2];
      for (const v of [...xs, ...ys]) {
        expect(Number.isFinite(v), e.descriptor.id).toBe(true);
        expect(v, e.descriptor.id).toBeGreaterThanOrEqual(0);
        expect(v, e.descriptor.id).toBeLessThanOrEqual(100);
      }
    }
  });

  it('uses the box even when every parameter sits low', () => {
    /*
     * The regression this guards: Analog's own defaults put body at 0.15 and
     * motion at 0, so every spoke landed near the minimum radius and the mark
     * drew an unreadable tangle in the middle of the frame. At least one spoke
     * must reach the rim, whatever the patch.
     */
    const radius = (p: { x: number; y: number }): number => Math.hypot(p.x - 50, p.y - 50);
    for (const e of ENGINES) {
      const s = sigilOf(defaults(e.descriptor), e.descriptor);
      const longest = Math.max(...s.spokes.map(radius));
      expect(longest, e.descriptor.id).toBeGreaterThan(40);
    }
    // And a patch that is genuinely near-silent everywhere is not blown up into
    // a starburst — the floor keeps it small.
    const quiet = new Float32Array(ANALOG_DESCRIPTOR.params.length);
    for (let i = 0; i < quiet.length; i++) quiet[i] = ANALOG_DESCRIPTOR.params[i]?.min ?? 0;
    const small = sigilOf(quiet, ANALOG_DESCRIPTOR);
    expect(Math.max(...small.spokes.map(radius))).toBeLessThan(30);
  });

  it('draws nine spokes', () => {
    expect(sigilOf(defaults(ANALOG_DESCRIPTOR), ANALOG_DESCRIPTOR).spokes).toHaveLength(9);
  });

  it('quantises every coordinate, so SSR and the browser agree', () => {
    /*
     * The regression this guards: Math.cos is not bit-identical across engines,
     * so the server rendered x2="62.60974715863566" where the browser computed
     * ...67, and React reported a hydration mismatch on every page load.
     */
    for (const e of ENGINES) {
      const s = sigilOf(defaults(e.descriptor), e.descriptor);
      const coords = [
        ...s.spokes.flatMap((p) => [p.x, p.y]),
        s.node.x, s.node.y, s.cut.x1, s.cut.y1, s.cut.x2, s.cut.y2,
      ];
      for (const v of coords) {
        expect(Math.abs(v * 100 - Math.round(v * 100)), `${e.descriptor.id} ${v}`)
          .toBeLessThan(1e-9);
      }
    }
  });

  it('is deterministic', () => {
    const a = sigilOf(defaults(ANALOG_DESCRIPTOR), ANALOG_DESCRIPTOR);
    const b = sigilOf(defaults(ANALOG_DESCRIPTOR), ANALOG_DESCRIPTOR);
    expect(a).toEqual(b);
  });

  it('changes shape when the sound changes character', () => {
    // The regression this guards: nine evenly sampled parameters skipped the
    // cutoff, so a dark patch and a bright one drew the identical glyph.
    for (const macro of [0, 1, 2, 3]) {
      const a = sigilOf(macroAt(ANALOG_DESCRIPTOR, macro, 0), ANALOG_DESCRIPTOR);
      const b = sigilOf(macroAt(ANALOG_DESCRIPTOR, macro, 1), ANALOG_DESCRIPTOR);
      expect(a.spokes, `macro ${macro}`).not.toEqual(b.spokes);
    }
  });

  it('puts the node on the longest spoke', () => {
    const s = sigilOf(defaults(ANALOG_DESCRIPTOR), ANALOG_DESCRIPTOR);
    const radius = (p: { x: number; y: number }): number =>
      Math.hypot(p.x - 50, p.y - 50);
    const longest = Math.max(...s.spokes.map(radius));
    expect(radius(s.node)).toBeCloseTo(longest, 1);
  });

  it('does not produce NaN geometry from a corrupt patch', () => {
    const v = defaults(ANALOG_DESCRIPTOR);
    v.fill(NaN);
    const s = sigilOf(v, ANALOG_DESCRIPTOR);
    for (const p of s.spokes) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});
