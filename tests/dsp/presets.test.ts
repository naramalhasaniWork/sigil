import { describe, it, expect } from 'vitest';
import { ANALOG_DESCRIPTOR } from '@/dsp/analog-descriptor';
import {
  PRESETS,
  presetToValues,
  presetsForCharacter,
  analogPresets,
  type Preset,
} from '@/dsp/presets';

const PARAM_IDS = new Set(ANALOG_DESCRIPTOR.params.map((p) => p.id));

const CHARACTER_VOCABULARY = new Set([
  'glassy', 'broken', 'huge', 'wooden', 'warm',
  'aggressive', 'hollow', 'plucked', 'sweeping', 'dark',
]);

function paramById(id: string) {
  const p = ANALOG_DESCRIPTOR.params.find((q) => q.id === id);
  if (p === undefined) throw new Error(`no such parameter: ${id}`);
  return p;
}

describe('PRESETS', () => {
  it('ships a library worth browsing', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(14);
  });

  it('has unique ids', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique, non-empty names', () => {
    const names = PRESETS.map((p) => p.name);
    for (const name of names) expect(name.trim().length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it('references only real parameter ids from the descriptor', () => {
    for (const preset of PRESETS) {
      for (const id of Object.keys(preset.values)) {
        expect(PARAM_IDS.has(id), `${preset.id} sets unknown parameter "${id}"`).toBe(true);
      }
    }
  });

  it('keeps every value inside its parameter range', () => {
    for (const preset of PRESETS) {
      for (const [id, value] of Object.entries(preset.values)) {
        const p = paramById(id);
        expect(Number.isFinite(value), `${preset.id}.${id} must be finite`).toBe(true);
        expect(value, `${preset.id}.${id} below min`).toBeGreaterThanOrEqual(p.min);
        expect(value, `${preset.id}.${id} above max`).toBeLessThanOrEqual(p.max);
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

  it('targets a real engine', () => {
    for (const preset of PRESETS) expect(preset.engineId).toBe(ANALOG_DESCRIPTOR.id);
    expect(analogPresets().length).toBe(PRESETS.length);
  });

  it('makes plucked presets actually pluck', () => {
    for (const preset of presetsForCharacter('plucked')) {
      const values = presetToValues(preset, ANALOG_DESCRIPTOR);
      const sustain = values[ANALOG_DESCRIPTOR.params.findIndex((p) => p.id === 'amp-sustain')];
      const decay = values[ANALOG_DESCRIPTOR.params.findIndex((p) => p.id === 'amp-decay')];
      const attack = values[ANALOG_DESCRIPTOR.params.findIndex((p) => p.id === 'amp-attack')];
      // +epsilon: values round-trip through Float32Array, so 0.1 stores as 0.100000001.
      expect(sustain, `${preset.id} sustain`).toBeLessThanOrEqual(0.1 + 1e-6);
      expect(decay, `${preset.id} decay`).toBeLessThanOrEqual(600);
      expect(attack, `${preset.id} attack`).toBeLessThanOrEqual(10);
    }
  });

  it('makes huge presets actually swell', () => {
    const attackIdx = ANALOG_DESCRIPTOR.params.findIndex((p) => p.id === 'amp-attack');
    const detuneIdx = ANALOG_DESCRIPTOR.params.findIndex((p) => p.id === 'osc-detune');
    for (const preset of presetsForCharacter('huge')) {
      const values = presetToValues(preset, ANALOG_DESCRIPTOR);
      expect(values[attackIdx], `${preset.id} attack`).toBeGreaterThanOrEqual(200);
      expect(values[detuneIdx], `${preset.id} detune`).toBeGreaterThanOrEqual(0.15);
    }
  });

  it('makes aggressive presets bite', () => {
    const driveIdx = ANALOG_DESCRIPTOR.params.findIndex((p) => p.id === 'drive');
    const resIdx = ANALOG_DESCRIPTOR.params.findIndex((p) => p.id === 'filter-resonance');
    for (const preset of presetsForCharacter('aggressive')) {
      const values = presetToValues(preset, ANALOG_DESCRIPTOR);
      expect(values[driveIdx], `${preset.id} drive`).toBeGreaterThanOrEqual(0.5);
      expect(values[resIdx], `${preset.id} resonance`).toBeGreaterThanOrEqual(0.4);
    }
  });
});

describe('presetToValues', () => {
  it('returns one value per descriptor parameter, in descriptor order', () => {
    for (const preset of PRESETS) {
      const values = presetToValues(preset, ANALOG_DESCRIPTOR);
      expect(values).toBeInstanceOf(Float32Array);
      expect(values.length).toBe(ANALOG_DESCRIPTOR.params.length);
      ANALOG_DESCRIPTOR.params.forEach((p, i) => {
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

  it('produces every parameter default for an empty preset', () => {
    const empty: Preset = {
      id: 'test-empty', name: 'Empty', engineId: 'analog', character: ['warm'], values: {},
    };
    const values = presetToValues(empty, ANALOG_DESCRIPTOR);
    ANALOG_DESCRIPTOR.params.forEach((p, i) => expect(values[i]).toBeCloseTo(p.default, 4));
  });

  it('clamps out-of-range values into the parameter range', () => {
    const wild: Preset = {
      id: 'test-wild', name: 'Wild', engineId: 'analog', character: ['broken'],
      values: { 'filter-cutoff': 99000, 'amp-sustain': -3 },
    };
    const values = presetToValues(wild, ANALOG_DESCRIPTOR);
    const cutoff = paramById('filter-cutoff');
    const sustain = paramById('amp-sustain');
    const cutoffIdx = ANALOG_DESCRIPTOR.params.findIndex((p) => p.id === 'filter-cutoff');
    const sustainIdx = ANALOG_DESCRIPTOR.params.findIndex((p) => p.id === 'amp-sustain');
    expect(values[cutoffIdx]).toBeCloseTo(cutoff.max, 4);
    expect(values[sustainIdx]).toBeCloseTo(sustain.min, 4);
  });

  it('ignores parameters the descriptor does not have', () => {
    const stray: Preset = {
      id: 'test-stray', name: 'Stray', engineId: 'analog', character: ['dark'],
      values: { 'not-a-param': 12, 'filter-resonance': 0.9 },
    };
    const values = presetToValues(stray, ANALOG_DESCRIPTOR);
    const resIdx = ANALOG_DESCRIPTOR.params.findIndex((p) => p.id === 'filter-resonance');
    expect(values.length).toBe(ANALOG_DESCRIPTOR.params.length);
    expect(values[resIdx]).toBeCloseTo(0.9, 4);
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

  it('returns nothing for an unknown tag', () => {
    expect(presetsForCharacter('spatchcock')).toHaveLength(0);
    expect(presetsForCharacter('')).toHaveLength(0);
  });
});
