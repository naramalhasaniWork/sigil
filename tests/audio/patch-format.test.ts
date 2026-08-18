import { describe, it, expect } from 'vitest';
import type { EngineDescriptor, ParamDescriptor } from '@/audio/types';
import {
  PATCH_FORMAT_VERSION,
  serialisePatch,
  loadPatch,
  toKeyed,
  fromKeyed,
} from '@/audio/patch-format';

/**
 * Float32Array cannot hold 0.7 exactly — it stores 0.699999988079071 — so every
 * comparison here is approximate. Exact equality on stored floats is a test bug,
 * not a format guarantee.
 */
function expectValues(actual: Float32Array | undefined, expected: readonly number[]): void {
  expect(actual).toBeDefined();
  expect(actual?.length).toBe(expected.length);
  expected.forEach((want, i) => {
    expect(actual?.[i] ?? Number.NaN).toBeCloseTo(want, 5);
  });
}

function param(id: string, min: number, max: number, def: number): ParamDescriptor {
  return {
    id, name: id, group: 'Test', unit: 'none',
    min, max, default: def, curve: 'linear',
    explain: 'A test parameter that exists purely to be saved and loaded again.',
  };
}

const ENGINE: EngineDescriptor = {
  id: 'test', name: 'Test', colour: '#FF6B6B',
  macroNames: ['A', 'B', 'C', 'D'],
  params: [
    param('cutoff', 20, 18000, 1800),
    param('resonance', 0, 1, 0.15),
    param('drive', 0, 1, 0.2),
  ],
};

/** The same engine after a parameter was inserted in the middle. */
const ENGINE_GREW: EngineDescriptor = {
  ...ENGINE,
  params: [
    param('cutoff', 20, 18000, 1800),
    param('keytrack', 0, 1, 0.5),      // inserted
    param('resonance', 0, 1, 0.15),
    param('drive', 0, 1, 0.2),
  ],
};

const FX: EngineDescriptor = {
  id: 'fx', name: 'FX', colour: '#7C9CFF',
  macroNames: ['A', 'B', 'C', 'D'],
  params: [param('reverb-mix', 0, 1, 0.25)],
};

describe('patch format', () => {
  it('round-trips a patch exactly', () => {
    const values = Float32Array.from([4200, 0.7, 0.33]);
    const patch = serialisePatch({ engine: ENGINE, values });
    const loaded = loadPatch(patch, ENGINE);

    expect(loaded).not.toBeNull();
    expect(loaded?.warnings).toEqual([]);
    expectValues(loaded?.values, [4200, 0.7, 0.33]);
    expect(patch.version).toBe(PATCH_FORMAT_VERSION);
  });

  it('keys values by id rather than position', () => {
    const patch = serialisePatch({ engine: ENGINE, values: [4200, 0.7, 0.33] });
    expect(Object.keys(patch.values).sort()).toEqual(['cutoff', 'drive', 'resonance']);
    expect(patch.values['cutoff']).toBeCloseTo(4200, 5);
    expect(patch.values['resonance']).toBeCloseTo(0.7, 5);
    expect(patch.values['drive']).toBeCloseTo(0.33, 5);
  });

  /*
   * The whole reason this format exists. Under the old positional array, inserting
   * `keytrack` at index 1 would load resonance into keytrack and drive into
   * resonance — every saved patch silently becomes a different sound.
   */
  it('survives a parameter being inserted into the middle of the engine', () => {
    const patch = serialisePatch({ engine: ENGINE, values: [4200, 0.7, 0.33] });
    const loaded = loadPatch(patch, ENGINE_GREW);

    expect(loaded).not.toBeNull();
    const byId = toKeyed(ENGINE_GREW, loaded?.values ?? new Float32Array());
    expect(byId['cutoff']).toBeCloseTo(4200, 5);
    expect(byId['resonance']).toBeCloseTo(0.7, 5);
    expect(byId['drive']).toBeCloseTo(0.33, 5);
    // The new parameter takes its default and says so.
    expect(byId['keytrack']).toBeCloseTo(0.5, 6);
    expect(loaded?.warnings.join(' ')).toMatch(/not in the patch, using defaults/);
  });

  it('ignores parameters a newer build added, and says so', () => {
    const patch = serialisePatch({ engine: ENGINE_GREW, values: [4200, 0.9, 0.7, 0.33] });
    const loaded = loadPatch(patch, ENGINE);   // older engine, no keytrack

    expect(loaded).not.toBeNull();
    expectValues(loaded?.values, [4200, 0.7, 0.33]);
    expect(loaded?.warnings.join(' ')).toMatch(/ignored 1 unknown parameter/);
  });

  it('warns when the format is newer than this build understands', () => {
    const patch = { ...serialisePatch({ engine: ENGINE, values: [1, 0.1, 0.1] }), version: 99 };
    const loaded = loadPatch(patch, ENGINE);
    expect(loaded?.warnings.join(' ')).toMatch(/newer build/);
  });

  it('clamps values that would drive the DSP out of range', () => {
    const patch = serialisePatch({ engine: ENGINE, values: [1, 0.1, 0.1] });
    patch.values['cutoff'] = 999_999;
    patch.values['resonance'] = -5;
    const loaded = loadPatch(patch, ENGINE);

    expect(loaded?.values[0]).toBe(18000);
    expect(loaded?.values[1]).toBe(0);
    expect(loaded?.warnings.join(' ')).toMatch(/clamped/);
  });

  it('replaces non-finite values rather than passing NaN to the DSP', () => {
    const patch = serialisePatch({ engine: ENGINE, values: [1, 0.1, 0.1] });
    patch.values['cutoff'] = Number.NaN;
    const loaded = loadPatch(patch, ENGINE);
    expect(Number.isFinite(loaded?.values[0])).toBe(true);
  });

  it('reads the old positional format and flags the risk', () => {
    const legacy = { engineId: 'test', values: [4200, 0.7, 0.33] };
    const loaded = loadPatch(legacy, ENGINE);

    expectValues(loaded?.values, [4200, 0.7, 0.33]);
    expect(loaded?.warnings.join(' ')).toMatch(/old positional format/);
  });

  it('carries FX and character chains when given their descriptors', () => {
    const patch = serialisePatch({
      engine: ENGINE, values: [1000, 0.2, 0.3],
      fxDescriptor: FX, fx: [0.8],
    });
    expect(patch.fx).toEqual({ 'reverb-mix': 0.8 });

    const loaded = loadPatch(patch, ENGINE, FX);
    expect(loaded?.fx).not.toBeNull();
    expect(loaded?.fx?.[0]).toBeCloseTo(0.8, 6);
  });

  it('returns null for things that are not patches at all', () => {
    expect(loadPatch(null, ENGINE)).toBeNull();
    expect(loadPatch('a string', ENGINE)).toBeNull();
    expect(loadPatch(42, ENGINE)).toBeNull();
    expect(loadPatch({ version: 2, engineId: 'test' }, ENGINE)).toBeNull();
  });

  it('fills every parameter from defaults when values are absent', () => {
    const { values, warnings } = fromKeyed(ENGINE, undefined, 'Test');
    expectValues(values, [1800, 0.15, 0.2]);
    expect(warnings).toEqual([]);
  });

  it('stamps a timestamp so a patch knows when it was made', () => {
    const patch = serialisePatch({ engine: ENGINE, values: [1, 0.1, 0.1] });
    expect(patch.savedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(patch.savedAt ?? ''))).toBe(false);
  });
});
