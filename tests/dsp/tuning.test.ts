import { describe, it, expect } from 'vitest';
import { TuningTable } from '@/dsp/tuning';

describe('TuningTable', () => {
  it('defaults to 12-TET with A4 = 440', () => {
    const t = new TuningTable();
    expect(t.frequency(69)).toBeCloseTo(440, 6);
    expect(t.frequency(81)).toBeCloseTo(880, 6);
    expect(t.frequency(57)).toBeCloseTo(220, 6);
    expect(t.frequency(60)).toBeCloseTo(261.6255653, 4);
  });

  it('supports 24-TET quarter tones', () => {
    const t = new TuningTable();
    t.setEqualDivisions(24);
    expect(t.frequency(69 + 24)).toBeCloseTo(880, 6);
    expect(t.frequency(69 + 12)).toBeCloseTo(440 * Math.SQRT2, 4);
  });

  it('respects a moved reference pitch', () => {
    const t = new TuningTable();
    t.setReference(69, 432);
    expect(t.frequency(69)).toBeCloseTo(432, 6);
    expect(t.frequency(81)).toBeCloseTo(864, 6);
  });
});
