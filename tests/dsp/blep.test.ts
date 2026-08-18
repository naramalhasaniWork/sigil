import { describe, it, expect } from 'vitest';
import { SawOscillator } from '@/dsp/blep';
import { magnitudeSpectrum } from '../util/fft';

const SR = 48000;

describe('SawOscillator', () => {
  it('stays within range', () => {
    const o = new SawOscillator(SR);
    o.setFrequency(220);
    for (let i = 0; i < 10000; i++) {
      const v = o.next();
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(1.2);
    }
  });

  it('has far less aliasing than a naive saw at a high pitch', () => {
    const N = 8192;
    // Deliberately incommensurate with the sample rate. At an even divisor
    // like 3000Hz every aliased image folds exactly onto a real harmonic and
    // becomes impossible to measure.
    const freq = 3217;

    const o = new SawOscillator(SR);
    o.setFrequency(freq);
    const blepBuf = new Float32Array(N);
    for (let i = 0; i < N; i++) blepBuf[i] = o.next();

    const naive = new Float32Array(N);
    let p = 0;
    const inc = freq / SR;
    for (let i = 0; i < N; i++) { p += inc; if (p >= 1) p -= 1; naive[i] = 2 * p - 1; }

    const binHz = SR / N;
    const inharmonic = (spec: Float32Array): number => {
      let energy = 0;
      for (let i = 1; i < spec.length; i++) {
        const ratio = (i * binHz) / freq;
        if (Math.abs(ratio - Math.round(ratio)) > 0.12) energy += (spec[i] as number) ** 2;
      }
      return energy;
    };

    const blepAlias = inharmonic(magnitudeSpectrum(blepBuf));
    const naiveAlias = inharmonic(magnitudeSpectrum(naive));
    expect(blepAlias).toBeLessThan(naiveAlias * 0.5);
  });
});
