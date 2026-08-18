import { describe, it, expect } from 'vitest';
import { Smoother } from '@/dsp/smoothing';

describe('Smoother', () => {
  it('converges toward the target without overshooting', () => {
    const s = new Smoother(48000, 10);
    s.snap(0);
    s.setTarget(1);
    let v = 0;
    for (let i = 0; i < 48000; i++) v = s.next();
    expect(v).toBeGreaterThan(0.999);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('reaches ~63% of the way after one time constant', () => {
    const s = new Smoother(48000, 10);
    s.snap(0);
    s.setTarget(1);
    let v = 0;
    for (let i = 0; i < 480; i++) v = s.next();
    expect(v).toBeGreaterThan(0.55);
    expect(v).toBeLessThan(0.70);
  });

  it('snap jumps immediately with no ramp', () => {
    const s = new Smoother(48000, 10);
    s.snap(0.25);
    expect(s.next()).toBeCloseTo(0.25, 10);
  });
});
