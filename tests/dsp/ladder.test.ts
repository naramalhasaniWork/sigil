import { describe, it, expect } from 'vitest';
import { LadderFilter } from '@/dsp/ladder';

const SR = 48000;

function rmsAt(freq: number, cutoff: number, res: number): number {
  const f = new LadderFilter(SR);
  f.setCutoff(cutoff);
  f.setResonance(res);
  const n = 24000;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const y = f.process(Math.sin((2 * Math.PI * freq * i) / SR));
    if (i > n / 2) sum += y * y;
  }
  return Math.sqrt(sum / (n / 2));
}

describe('LadderFilter', () => {
  it('passes low frequencies and attenuates high ones', () => {
    const low = rmsAt(100, 2000, 0.1);
    const high = rmsAt(12000, 2000, 0.1);
    expect(low).toBeGreaterThan(0.5);
    expect(high).toBeLessThan(low * 0.2);
  });

  it('attenuates steeply above cutoff', () => {
    const oneOct = rmsAt(4000, 2000, 0.1);
    const twoOct = rmsAt(8000, 2000, 0.1);
    const dbPerOctave = 20 * Math.log10(oneOct / twoOct);
    expect(dbPerOctave).toBeGreaterThan(12);
    expect(dbPerOctave).toBeLessThan(36);
  });

  it('emphasises the cutoff region as resonance rises', () => {
    expect(rmsAt(2000, 2000, 0.9)).toBeGreaterThan(rmsAt(2000, 2000, 0.1));
  });

  it('stays finite and bounded across extreme settings', () => {
    for (const cutoff of [20, 200, 2000, 20000]) {
      for (const res of [0, 0.5, 0.99, 1]) {
        const f = new LadderFilter(SR);
        f.setCutoff(cutoff);
        f.setResonance(res);
        /*
         * Scan first, assert once. Calling expect() 320,000 times across these
         * nested loops was slow enough to blow the default timeout whenever the
         * machine was busy, which made a deterministic stability test look
         * flaky. Recording the first offender keeps the failure message just as
         * useful.
         */
        let bad: { i: number; y: number } | null = null;
        for (let i = 0; i < 20000; i++) {
          const y = f.process(Math.sin(i * 0.1) * 2);
          if (!Number.isFinite(y) || Math.abs(y) >= 50) { bad = { i, y }; break; }
        }
        expect(bad, `cutoff ${cutoff}Hz res ${res} produced ${bad?.y} at sample ${bad?.i}`)
          .toBeNull();
      }
    }
  });
});
