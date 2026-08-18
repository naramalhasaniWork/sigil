import { describe, it, expect } from 'vitest';
import { ANALOG_DESCRIPTOR } from '@/dsp/analog-descriptor';

describe('ANALOG_DESCRIPTOR', () => {
  it('gives every parameter a non-empty explanation', () => {
    for (const p of ANALOG_DESCRIPTOR.params) {
      expect(p.explain.length, `${p.id} needs an explanation`).toBeGreaterThan(20);
    }
  });

  it('has unique parameter ids', () => {
    const ids = ANALOG_DESCRIPTOR.params.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every default inside its own range', () => {
    for (const p of ANALOG_DESCRIPTOR.params) {
      expect(p.default).toBeGreaterThanOrEqual(p.min);
      expect(p.default).toBeLessThanOrEqual(p.max);
    }
  });

  it('assigns exactly four macros', () => {
    const macros = new Set(
      ANALOG_DESCRIPTOR.params.filter((p) => p.macro !== undefined).map((p) => p.macro),
    );
    expect(macros).toEqual(new Set([0, 1, 2, 3]));
  });
});
