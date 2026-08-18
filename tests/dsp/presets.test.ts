import { describe, it, expect } from 'vitest';
import type { EngineDescriptor, ParamDescriptor } from '@/audio/types';
import { ANALOG_DESCRIPTOR } from '@/dsp/analog-descriptor';
import { FM_DESCRIPTOR } from '@/dsp/fm-descriptor';
import { PHYSICAL_DESCRIPTOR } from '@/dsp/physical-descriptor';
import { GRANULAR_DESCRIPTOR } from '@/dsp/granular-descriptor';
import { WAVETABLE_DESCRIPTOR } from '@/dsp/wavetable-descriptor';
import {
  PRESETS,
  presetToValues,
  presetsForCharacter,
  presetsForEngine,
  analogPresets,
  type Preset,
} from '@/dsp/presets';

const DESCRIPTORS: Readonly<Record<string, EngineDescriptor>> = {
  analog: ANALOG_DESCRIPTOR,
  fm: FM_DESCRIPTOR,
  physical: PHYSICAL_DESCRIPTOR,
  granular: GRANULAR_DESCRIPTOR,
  wavetable: WAVETABLE_DESCRIPTOR,
};

const CHARACTER_VOCABULARY = new Set([
  'glassy', 'broken', 'huge', 'wooden', 'warm',
  'aggressive', 'hollow', 'plucked', 'sweeping', 'dark',
  'metallic', 'bowed',
]);

function descriptorFor(preset: Preset): EngineDescriptor {
  const d = DESCRIPTORS[preset.engineId];
  if (d === undefined) throw new Error(`${preset.id} targets unknown engine "${preset.engineId}"`);
  return d;
}

function paramIn(descriptor: EngineDescriptor, id: string): ParamDescriptor {
  const p = descriptor.params.find((q) => q.id === id);
  if (p === undefined) throw new Error(`${descriptor.id} has no parameter "${id}"`);
  return p;
}

function analogParamIndex(id: string): number {
  const i = ANALOG_DESCRIPTOR.params.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`no such analog parameter: ${id}`);
  return i;
}

/**
 * Whether a stepped parameter's value lands exactly on a valid step. FM
 * operator ratios use the DX7-style grid the voice actually quantises to
 * (0.5 or a whole number); every other stepped parameter uses the uniform
 * grid of `steps` points across [min, max].
 */
function onStep(p: ParamDescriptor, value: number): boolean {
  if (p.unit === 'ratio') {
    return value === 0.5 || (Number.isInteger(value) && value >= 1 && value <= p.max);
  }
  const steps = p.steps ?? 0;
  if (steps < 2) return true;
  const stepSize = (p.max - p.min) / (steps - 1);
  const k = (value - p.min) / stepSize;
  return Math.abs(k - Math.round(k)) < 1e-9;
}

describe('PRESETS', () => {
  it('ships a library worth browsing on every engine', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(52);
    expect(presetsForEngine('analog').length).toBeGreaterThanOrEqual(16);
    expect(presetsForEngine('fm').length).toBeGreaterThanOrEqual(12);
    expect(presetsForEngine('physical').length).toBeGreaterThanOrEqual(12);
    expect(presetsForEngine('granular').length).toBeGreaterThanOrEqual(12);
  });

  it('has unique ids across the whole library', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique, non-empty names across the whole library', () => {
    const names = PRESETS.map((p) => p.name);
    for (const name of names) expect(name.trim().length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it('targets a registered engine', () => {
    for (const preset of PRESETS) {
      expect(DESCRIPTORS[preset.engineId], `${preset.id} engine`).toBeDefined();
    }
  });

  it('references only real parameter ids from its own engine descriptor', () => {
    for (const preset of PRESETS) {
      const known = new Set(descriptorFor(preset).params.map((p) => p.id));
      for (const id of Object.keys(preset.values)) {
        expect(known.has(id), `${preset.id} sets unknown parameter "${id}"`).toBe(true);
      }
    }
  });

  it('keeps every value inside its parameter range', () => {
    for (const preset of PRESETS) {
      const descriptor = descriptorFor(preset);
      for (const [id, value] of Object.entries(preset.values)) {
        const p = paramIn(descriptor, id);
        expect(Number.isFinite(value), `${preset.id}.${id} must be finite`).toBe(true);
        expect(value, `${preset.id}.${id} below min`).toBeGreaterThanOrEqual(p.min);
        expect(value, `${preset.id}.${id} above max`).toBeLessThanOrEqual(p.max);
      }
    }
  });

  it('lands stepped parameters exactly on steps', () => {
    for (const preset of PRESETS) {
      const descriptor = descriptorFor(preset);
      for (const [id, value] of Object.entries(preset.values)) {
        const p = paramIn(descriptor, id);
        if (p.curve !== 'stepped') continue;
        expect(onStep(p, value), `${preset.id}.${id} = ${value} is off-step`).toBe(true);
      }
    }
  });

  it('gives every preset at least one character tag', () => {
    for (const preset of PRESETS) {
      expect(preset.character.length, `${preset.id} has no character`).toBeGreaterThan(0);
    }
  });

  it('draws character tags from the shared vocabulary', () => {
    for (const preset of PRESETS) {
      for (const tag of preset.character) {
        expect(CHARACTER_VOCABULARY.has(tag), `${preset.id} uses unknown tag "${tag}"`).toBe(true);
      }
    }
  });

  it('covers every character in the vocabulary', () => {
    const covered = new Set<string>();
    for (const preset of PRESETS) for (const tag of preset.character) covered.add(tag);
    for (const tag of CHARACTER_VOCABULARY) {
      expect(covered.has(tag), `nothing sounds "${tag}" yet`).toBe(true);
    }
  });

  it('makes plucked analog presets actually pluck', () => {
    for (const preset of presetsForCharacter('plucked')) {
      if (preset.engineId !== 'analog') continue;
      const values = presetToValues(preset, ANALOG_DESCRIPTOR);
      const sustain = values[analogParamIndex('amp-sustain')];
      const decay = values[analogParamIndex('amp-decay')];
      const attack = values[analogParamIndex('amp-attack')];
      // +epsilon: values round-trip through Float32Array, so 0.1 stores as 0.100000001.
      expect(sustain, `${preset.id} sustain`).toBeLessThanOrEqual(0.1 + 1e-6);
      expect(decay, `${preset.id} decay`).toBeLessThanOrEqual(600);
      expect(attack, `${preset.id} attack`).toBeLessThanOrEqual(10);
    }
  });

  it('makes huge analog presets actually swell', () => {
    const attackIdx = analogParamIndex('amp-attack');
    const detuneIdx = analogParamIndex('osc-detune');
    for (const preset of presetsForCharacter('huge')) {
      if (preset.engineId !== 'analog') continue;
      const values = presetToValues(preset, ANALOG_DESCRIPTOR);
      expect(values[attackIdx], `${preset.id} attack`).toBeGreaterThanOrEqual(200);
      expect(values[detuneIdx], `${preset.id} detune`).toBeGreaterThanOrEqual(0.15);
    }
  });

  it('makes aggressive analog presets bite', () => {
    const driveIdx = analogParamIndex('drive');
    const resIdx = analogParamIndex('filter-resonance');
    for (const preset of presetsForCharacter('aggressive')) {
      if (preset.engineId !== 'analog') continue;
      const values = presetToValues(preset, ANALOG_DESCRIPTOR);
      expect(values[driveIdx], `${preset.id} drive`).toBeGreaterThanOrEqual(0.5);
      expect(values[resIdx], `${preset.id} resonance`).toBeGreaterThanOrEqual(0.4);
    }
  });

  it('spreads FM presets across multiple algorithms', () => {
    const algos = new Set(
      presetsForEngine('fm').map((p) => p.values['algorithm']).filter((v) => v !== undefined),
    );
    expect(algos.size).toBeGreaterThanOrEqual(4);
  });

  it('exploits granular extremes rather than clustering', () => {
    const densities = presetsForEngine('granular')
      .map((p) => p.values['grain-density'])
      .filter((v): v is number => v !== undefined);
    expect(Math.min(...densities)).toBeLessThanOrEqual(10);
    expect(Math.max(...densities)).toBeGreaterThanOrEqual(150);
  });
});

describe('presetToValues', () => {
  it('returns one value per descriptor parameter, in descriptor order', () => {
    for (const preset of PRESETS) {
      const descriptor = descriptorFor(preset);
      const values = presetToValues(preset, descriptor);
      expect(values).toBeInstanceOf(Float32Array);
      expect(values.length).toBe(descriptor.params.length);
      descriptor.params.forEach((p, i) => {
        const expected = preset.values[p.id];
        if (expected !== undefined) {
          expect(values[i], `${preset.id}.${p.id}`).toBeCloseTo(expected, 4);
        }
      });
    }
  });

  it('fills unspecified parameters with their defaults', () => {
    const sparse: Preset = {
      id: 'test-sparse', name: 'Sparse', engineId: 'analog',
      character: ['warm'],
      values: { 'filter-cutoff': 640 },
    };
    const values = presetToValues(sparse, ANALOG_DESCRIPTOR);
    ANALOG_DESCRIPTOR.params.forEach((p, i) => {
      const expected = p.id === 'filter-cutoff' ? 640 : p.default;
      expect(values[i], p.id).toBeCloseTo(expected, 4);
    });
  });

  it('produces every parameter default for an empty preset on any engine', () => {
    for (const descriptor of Object.values(DESCRIPTORS)) {
      const empty: Preset = {
        id: 'test-empty', name: 'Empty', engineId: descriptor.id, character: ['warm'], values: {},
      };
      const values = presetToValues(empty, descriptor);
      descriptor.params.forEach((p, i) => {
        expect(values[i], `${descriptor.id}.${p.id}`).toBeCloseTo(p.default, 4);
      });
    }
  });

  it('clamps out-of-range values into the parameter range', () => {
    const wild: Preset = {
      id: 'test-wild', name: 'Wild', engineId: 'analog', character: ['broken'],
      values: { 'filter-cutoff': 99000, 'amp-sustain': -3 },
    };
    const values = presetToValues(wild, ANALOG_DESCRIPTOR);
    const cutoff = paramIn(ANALOG_DESCRIPTOR, 'filter-cutoff');
    const sustain = paramIn(ANALOG_DESCRIPTOR, 'amp-sustain');
    expect(values[analogParamIndex('filter-cutoff')]).toBeCloseTo(cutoff.max, 4);
    expect(values[analogParamIndex('amp-sustain')]).toBeCloseTo(sustain.min, 4);
  });

  it('ignores parameters the descriptor does not have', () => {
    const stray: Preset = {
      id: 'test-stray', name: 'Stray', engineId: 'analog', character: ['dark'],
      values: { 'not-a-param': 12, 'filter-resonance': 0.9 },
    };
    const values = presetToValues(stray, ANALOG_DESCRIPTOR);
    expect(values.length).toBe(ANALOG_DESCRIPTOR.params.length);
    expect(values[analogParamIndex('filter-resonance')]).toBeCloseTo(0.9, 4);
  });
});

describe('presetsForCharacter', () => {
  it('returns only presets carrying the tag', () => {
    for (const tag of CHARACTER_VOCABULARY) {
      const matches = presetsForCharacter(tag);
      expect(matches.length).toBeGreaterThan(0);
      for (const preset of matches) expect(preset.character).toContain(tag);
    }
  });

  it('returns every preset carrying the tag', () => {
    for (const tag of CHARACTER_VOCABULARY) {
      const expected = PRESETS.filter((p) => p.character.includes(tag)).map((p) => p.id);
      expect(presetsForCharacter(tag).map((p) => p.id)).toEqual(expected);
    }
  });

  it('crosses engine borders where tags overlap', () => {
    for (const tag of ['glassy', 'broken', 'warm', 'dark', 'plucked', 'wooden'] as const) {
      const engines = new Set(presetsForCharacter(tag).map((p) => p.engineId));
      expect(engines.size, `"${tag}" spans engines`).toBeGreaterThanOrEqual(2);
    }
    expect(new Set(presetsForCharacter('glassy').map((p) => p.engineId)).size)
      .toBeGreaterThanOrEqual(4);
  });

  it('returns nothing for an unknown tag', () => {
    expect(presetsForCharacter('spatchcock')).toHaveLength(0);
    expect(presetsForCharacter('')).toHaveLength(0);
  });
});

describe('presetsForEngine', () => {
  it('partitions the library exactly', () => {
    const total = Object.keys(DESCRIPTORS)
      .reduce((n, id) => n + presetsForEngine(id).length, 0);
    expect(total).toBe(PRESETS.length);
    for (const [id, descriptor] of Object.entries(DESCRIPTORS)) {
      for (const preset of presetsForEngine(id)) {
        expect(preset.engineId).toBe(descriptor.id);
      }
    }
  });

  it('keeps analogPresets as the analog partition', () => {
    expect(analogPresets().map((p) => p.id))
      .toEqual(presetsForEngine(ANALOG_DESCRIPTOR.id).map((p) => p.id));
    expect(analogPresets().length).toBeGreaterThanOrEqual(16);
  });
});
