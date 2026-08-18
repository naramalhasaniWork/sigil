import { describe, it, expect } from 'vitest';
import { ANALOG_DESCRIPTOR } from '@/dsp/analog-descriptor';
import { FX_DESCRIPTOR } from '@/dsp/fx-descriptor';
import { ENGINES } from '@/dsp/registry';
import {
  moveLabel, rankedMoves, topLabels, appendStep, renderTrail, describeAcross,
} from '@/dsp/lineage';
import type { EngineDescriptor, ParamDescriptor } from '@/audio/types';

function defaults(d: EngineDescriptor): Float32Array {
  const v = new Float32Array(d.params.length);
  for (let i = 0; i < d.params.length; i++) v[i] = d.params[i]?.default ?? 0;
  return v;
}

function paramOf(d: EngineDescriptor, id: string): { index: number; p: ParamDescriptor } {
  const index = d.params.findIndex((x) => x.id === id);
  const p = d.params[index];
  if (p === undefined) throw new Error(`no param ${id} in ${d.id}`);
  return { index, p };
}

describe('moveLabel', () => {
  it('describes cutoff as brightness, in both directions', () => {
    const { p } = paramOf(ANALOG_DESCRIPTOR, 'filter-cutoff');
    expect(moveLabel(p, 0.3)).toBe('Brighter');
    expect(moveLabel(p, -0.3)).toBe('Darker');
  });

  it('describes release as tail length, not as a parameter name', () => {
    const { p } = paramOf(ANALOG_DESCRIPTOR, 'amp-release');
    expect(moveLabel(p, 0.3)).toBe('Longer tail');
    expect(moveLabel(p, -0.3)).toBe('Shorter tail');
  });

  it('reaches the delay entry before the generic feedback entry', () => {
    // delay-feedback must read as echo, never as "metallic".
    const { p } = paramOf(FX_DESCRIPTOR, 'delay-feedback');
    expect(moveLabel(p, 0.3)).toBe('More echo');
  });

  it('calls a stepped shape switch a reshape in either direction', () => {
    const { p } = paramOf(ANALOG_DESCRIPTOR, 'osc1-wave');
    expect(moveLabel(p, 1)).toBe('Reshaped');
    expect(moveLabel(p, -1)).toBe('Reshaped');
  });

  it('falls back to the parameter\'s own plain-language name', () => {
    const { p } = paramOf(FX_DESCRIPTOR, 'output-trim');
    expect(moveLabel(p, 0.3)).toBe('More Output');
    expect(moveLabel(p, -0.3)).toBe('Less Output');
  });

  it('never emits an empty or undefined phrase for any parameter', () => {
    for (const d of [...ENGINES.map((e) => e.descriptor), FX_DESCRIPTOR]) {
      for (const p of d.params) {
        for (const delta of [0.4, -0.4]) {
          const label = moveLabel(p, delta);
          expect(label.trim().length, `${d.id}/${p.id}`).toBeGreaterThan(2);
          expect(label, `${d.id}/${p.id}`).not.toContain('undefined');
        }
      }
    }
  });
});

describe('rankedMoves', () => {
  it('finds nothing between a patch and itself', () => {
    const v = defaults(ANALOG_DESCRIPTOR);
    expect(rankedMoves(v, v, ANALOG_DESCRIPTOR)).toEqual([]);
  });

  it('ignores movement below the floor', () => {
    const from = defaults(ANALOG_DESCRIPTOR);
    const { index, p } = paramOf(ANALOG_DESCRIPTOR, 'filter-resonance');
    const to = Float32Array.from(from);
    to[index] = (from[index] ?? 0) + (p.max - p.min) * 0.01;
    expect(rankedMoves(from, to, ANALOG_DESCRIPTOR)).toEqual([]);
  });

  it('ranks the bigger normalised move first, across different units', () => {
    const from = defaults(ANALOG_DESCRIPTOR);
    const to = Float32Array.from(from);
    // Cutoff to the top of its exponential range: a full-range move.
    to[paramOf(ANALOG_DESCRIPTOR, 'filter-cutoff').index] = 18000;
    // Resonance up by a fifth of its range.
    const res = paramOf(ANALOG_DESCRIPTOR, 'filter-resonance');
    to[res.index] = (from[res.index] ?? 0) + (res.p.max - res.p.min) * 0.2;

    const moves = rankedMoves(from, to, ANALOG_DESCRIPTOR);
    expect(moves[0]?.label).toBe('Brighter');
    expect(moves.map((m) => m.label)).toContain('Sharper');
    expect(moves[0]?.magnitude).toBeGreaterThan(moves[1]?.magnitude ?? 1);
  });

  it('reports magnitudes inside 0..1', () => {
    const from = defaults(ANALOG_DESCRIPTOR);
    const to = Float32Array.from(from);
    for (let i = 0; i < to.length; i++) {
      const p = ANALOG_DESCRIPTOR.params[i];
      if (p) to[i] = p.max;
    }
    for (const m of rankedMoves(from, to, ANALOG_DESCRIPTOR)) {
      expect(m.magnitude).toBeGreaterThan(0);
      expect(m.magnitude).toBeLessThanOrEqual(1);
    }
  });

  it('treats a NaN value as no move rather than as an infinite one', () => {
    const from = defaults(ANALOG_DESCRIPTOR);
    const to = Float32Array.from(from);
    to[0] = NaN;
    for (const m of rankedMoves(from, to, ANALOG_DESCRIPTOR)) {
      expect(Number.isFinite(m.magnitude)).toBe(true);
    }
  });
});

describe('topLabels', () => {
  it('takes the largest moves, largest first', () => {
    const moves = [
      { label: 'Darker', magnitude: 0.2 },
      { label: 'Brighter', magnitude: 0.9 },
      { label: 'Dirtier', magnitude: 0.5 },
    ];
    expect(topLabels(moves, 2)).toEqual(['Brighter', 'Dirtier']);
  });

  it('never repeats a phrase, keeping the largest instance', () => {
    const moves = [
      { label: 'Longer tail', magnitude: 0.3 },
      { label: 'Longer tail', magnitude: 0.8 },
      { label: 'Brighter', magnitude: 0.5 },
    ];
    expect(topLabels(moves, 2)).toEqual(['Longer tail', 'Brighter']);
  });

  it('returns nothing when nothing moved', () => {
    expect(topLabels([], 2)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const moves = [
      { label: 'Darker', magnitude: 0.2 },
      { label: 'Brighter', magnitude: 0.9 },
    ];
    topLabels(moves, 1);
    expect(moves[0]?.label).toBe('Darker');
  });
});

describe('describeAcross', () => {
  it('finds nothing when no chain moved', () => {
    const engine = defaults(ANALOG_DESCRIPTOR);
    const fx = defaults(FX_DESCRIPTOR);
    expect(describeAcross([
      { from: engine, to: engine, descriptor: ANALOG_DESCRIPTOR },
      { from: fx, to: fx, descriptor: FX_DESCRIPTOR },
    ])).toEqual([]);
  });

  it('ranks a big FX move above a small engine move', () => {
    const engine = defaults(ANALOG_DESCRIPTOR);
    const engineTo = Float32Array.from(engine);
    const res = paramOf(ANALOG_DESCRIPTOR, 'filter-resonance');
    engineTo[res.index] = (engine[res.index] ?? 0) + (res.p.max - res.p.min) * 0.1;

    const fx = defaults(FX_DESCRIPTOR);
    const fxTo = Float32Array.from(fx);
    const mix = paramOf(FX_DESCRIPTOR, 'reverb-mix');
    fxTo[mix.index] = mix.p.max;

    const labels = describeAcross([
      { from: engine, to: engineTo, descriptor: ANALOG_DESCRIPTOR },
      { from: fx, to: fxTo, descriptor: FX_DESCRIPTOR },
    ]);
    expect(labels[0]).toBe('Bigger space');
    expect(labels).toContain('Sharper');
  });

  it('respects the limit across all chains together', () => {
    const engine = defaults(ANALOG_DESCRIPTOR);
    const engineTo = Float32Array.from(engine);
    for (let i = 0; i < engineTo.length; i++) {
      const p = ANALOG_DESCRIPTOR.params[i];
      if (p) engineTo[i] = p.max;
    }
    const fx = defaults(FX_DESCRIPTOR);
    const fxTo = Float32Array.from(fx);
    for (let i = 0; i < fxTo.length; i++) {
      const p = FX_DESCRIPTOR.params[i];
      if (p) fxTo[i] = p.max;
    }
    expect(describeAcross([
      { from: engine, to: engineTo, descriptor: ANALOG_DESCRIPTOR },
      { from: fx, to: fxTo, descriptor: FX_DESCRIPTOR },
    ], 2)).toHaveLength(2);
  });
});

describe('appendStep', () => {
  it('adds a step', () => {
    expect(appendStep(['Glass Bell'], 'brighter')).toEqual(['Glass Bell', 'brighter']);
  });

  it('ignores blank labels', () => {
    expect(appendStep(['Glass Bell'], '   ')).toEqual(['Glass Bell']);
  });

  it('drops the oldest once the trail would become a log', () => {
    expect(appendStep(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
  });

  it('does not mutate its input', () => {
    const steps = ['a'];
    appendStep(steps, 'b');
    expect(steps).toEqual(['a']);
  });
});

describe('renderTrail', () => {
  it('joins the steps with arrows', () => {
    expect(renderTrail(['Glass Bell', 'brighter'])).toBe('Glass Bell → brighter');
  });

  it('is empty when there is no story yet', () => {
    expect(renderTrail([])).toBe('');
    expect(renderTrail([], null)).toBe('');
  });

  it('shows the tentative step as part of the trail', () => {
    expect(renderTrail(['Glass Bell'], 'darker')).toBe('Glass Bell → darker');
  });

  it('swaps the tentative step rather than stacking siblings', () => {
    const steps = ['Glass Bell'];
    expect(renderTrail(steps, 'darker')).toBe('Glass Bell → darker');
    expect(renderTrail(steps, 'brighter')).toBe('Glass Bell → brighter');
  });

  it('elides the oldest steps once the line is too long to read', () => {
    expect(renderTrail(['a', 'b', 'c', 'd', 'e'], null, 3)).toBe('… → c → d → e');
  });

  it('counts the tentative step toward the visible limit', () => {
    expect(renderTrail(['a', 'b', 'c'], 'd', 3)).toBe('… → b → c → d');
  });

  it('treats a blank tentative step as none', () => {
    expect(renderTrail(['a'], '  ')).toBe('a');
  });
});
