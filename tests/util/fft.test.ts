import { describe, it, expect } from 'vitest';
import { magnitudeSpectrum } from './fft';

describe('magnitudeSpectrum', () => {
  it('puts a pure sine in exactly one bin', () => {
    const N = 1024;
    const buf = new Float32Array(N);
    const bin = 64;
    for (let i = 0; i < N; i++) buf[i] = Math.sin((2 * Math.PI * bin * i) / N);
    const spec = magnitudeSpectrum(buf);

    let peak = 0;
    let peakIdx = -1;
    for (let i = 0; i < spec.length; i++) {
      const v = spec[i] ?? 0;
      if (v > peak) { peak = v; peakIdx = i; }
    }
    expect(peakIdx).toBe(bin);
    expect((spec[bin - 4] ?? 0) + (spec[bin + 4] ?? 0)).toBeLessThan(peak * 0.01);
  });
});
