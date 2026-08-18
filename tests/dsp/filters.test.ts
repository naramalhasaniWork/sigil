import { describe, it } from 'vitest';
import { createFilter, StateVariableFilter, type FilterModel } from '@/dsp/filters';

const SR = 48000;
const MODELS: FilterModel[] = ['ladder', 'svf', 'diode'];

function rmsAt(model: FilterModel, freq: number, cutoff: number, res: number, amp = 1): number {
  const f = createFilter(model, SR);
  f.setCutoff(cutoff);
  f.setResonance(res);
  const n = 24000;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const y = f.process(amp * Math.sin((2 * Math.PI * freq * i) / SR));
    if (i > n / 2) sum += y * y;
  }
  return Math.sqrt(sum / (n / 2));
}

describe('probe', () => {
  it('slopes', () => {
    for (const m of MODELS) {
      const a = rmsAt(m, 2000, 500, 0.1);
      const b = rmsAt(m, 4000, 500, 0.1);
      console.log(m, 'slope/oct', (20 * Math.log10(a / b)).toFixed(2));
      console.log(m, 'lowpass low', rmsAt(m, 100, 2000, 0.1).toFixed(4), 'high', rmsAt(m, 12000, 2000, 0.1).toFixed(6));
      console.log(m, 'res lo', rmsAt(m, 500, 500, 0.1).toFixed(4), 'hi', rmsAt(m, 500, 500, 0.95).toFixed(4), 'max', rmsAt(m, 500, 500, 1).toFixed(4));
    }
  });
  it('bounds', () => {
    for (const m of MODELS) {
      let peak = 0;
      for (const cutoff of [20, 200, 2000, 20000, 24000, 48000]) {
        for (const res of [0, 0.5, 0.99, 1]) {
          const f = createFilter(m, SR);
          f.setCutoff(cutoff);
          f.setResonance(res);
          for (let i = 0; i < 20000; i++) {
            const y = f.process(Math.sin(i * 0.1) * 2);
            if (!Number.isFinite(y)) throw new Error(`${m} nan c=${cutoff} r=${res}`);
            if (Math.abs(y) > peak) peak = Math.abs(y);
          }
        }
      }
      console.log(m, 'peak', peak.toFixed(3));
    }
  });
  it('svf modes', () => {
    const mk = (mode: 'lp' | 'bp' | 'hp', freq: number) => {
      const f = new StateVariableFilter(SR);
      f.setMode(mode); f.setCutoff(1000); f.setResonance(0.1);
      let sum = 0; const n = 24000;
      for (let i = 0; i < n; i++) { const y = f.process(Math.sin(2 * Math.PI * freq * i / SR)); if (i > n / 2) sum += y * y; }
      return Math.sqrt(sum / (n / 2));
    };
    for (const mode of ['lp', 'bp', 'hp'] as const) {
      console.log(mode, '50Hz', mk(mode, 50).toFixed(4), '1k', mk(mode, 1000).toFixed(4), '16k', mk(mode, 16000).toFixed(4));
    }
  });
  it('denormal flush', () => {
    for (const m of MODELS) {
      const f = createFilter(m, SR);
      f.setCutoff(1000); f.setResonance(0.3);
      for (let i = 0; i < 100; i++) f.process(i === 0 ? 1 : 0);
      let zeroAt = -1;
      for (let i = 0; i < 4000000; i++) { if (f.process(0) === 0) { zeroAt = i; break; } }
      console.log(m, 'flush after', zeroAt);
    }
  });
});
