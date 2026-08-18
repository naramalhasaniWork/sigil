import { describe, it, expect } from 'vitest';
import { LadderFilter } from '@/dsp/ladder';
import {
  createFilter,
  DiodeFilter,
  StateVariableFilter,
  type Filter,
  type FilterModel,
  type SvfMode,
} from '@/dsp/filters';

const SR = 48000;
const MODELS: FilterModel[] = ['ladder', 'svf', 'diode'];

/** Expected lowpass slope per model, in dB per octave, measured 2-3 octaves up. */
const SLOPE_RANGE: Record<FilterModel, readonly [number, number]> = {
  ladder: [18, 30],
  svf: [9, 16],
  diode: [18, 30],
};

/** Steady-state RMS of a sine at `freq` through `model`. */
function rmsAt(model: FilterModel, freq: number, cutoff: number, res: number, amp = 1): number {
  const f = createFilter(model, SR);
  f.setCutoff(cutoff);
  f.setResonance(res);
  return rmsThrough(f, freq, amp);
}

function rmsThrough(f: Filter, freq: number, amp: number): number {
  const n = 24000;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const y = f.process(amp * Math.sin((2 * Math.PI * freq * i) / SR));
    if (i > n / 2) sum += y * y;
  }
  return Math.sqrt(sum / (n / 2));
}

function svf(mode: SvfMode, cutoff: number, res: number): StateVariableFilter {
  const f = new StateVariableFilter(SR);
  f.setMode(mode);
  f.setCutoff(cutoff);
  f.setResonance(res);
  return f;
}

describe('createFilter', () => {
  it('reuses the existing ladder rather than a second implementation', () => {
    expect(createFilter('ladder', SR)).toBeInstanceOf(LadderFilter);
    expect(createFilter('svf', SR)).toBeInstanceOf(StateVariableFilter);
    expect(createFilter('diode', SR)).toBeInstanceOf(DiodeFilter);
  });
});

describe.each(MODELS)('%s model', (model) => {
  it('passes low frequencies and attenuates high ones', () => {
    const low = rmsAt(model, 100, 2000, 0.1);
    const high = rmsAt(model, 12000, 2000, 0.1);
    expect(low).toBeGreaterThan(0.4);
    expect(high).toBeLessThan(low * 0.1);
  });

  it('rolls off at the slope its topology promises', () => {
    const range = SLOPE_RANGE[model];
    // Two and three octaves above cutoff: past the corner, short of Nyquist.
    for (const cutoff of [200, 500, 1000]) {
      const twoOct = rmsAt(model, cutoff * 4, cutoff, 0.1);
      const threeOct = rmsAt(model, cutoff * 8, cutoff, 0.1);
      const dbPerOctave = 20 * Math.log10(twoOct / threeOct);
      expect(dbPerOctave, `${model} @ ${cutoff}Hz`).toBeGreaterThan(range[0]);
      expect(dbPerOctave, `${model} @ ${cutoff}Hz`).toBeLessThan(range[1]);
    }
  });

  it('raises energy at the cutoff as resonance rises', () => {
    // Quiet input: every model saturates, and saturation eats resonance.
    for (const cutoff of [500, 1000, 4000]) {
      const flat = rmsAt(model, cutoff, cutoff, 0.1, 0.25);
      const resonant = rmsAt(model, cutoff, cutoff, 0.95, 0.25);
      expect(resonant, `${model} @ ${cutoff}Hz`).toBeGreaterThan(flat * 1.3);
    }
  });

  it('stays finite and bounded across the full parameter range', () => {
    for (const cutoff of [20, 50, 200, 2000, 20000, SR / 2, SR]) {
      for (const res of [0, 0.25, 0.5, 0.9, 0.99, 1]) {
        const f = createFilter(model, SR);
        f.setCutoff(cutoff);
        f.setResonance(res);
        // Assert on the summary, not per sample: 800k expect() calls take
        // minutes and tell you nothing extra.
        let peak = 0;
        let finite = true;
        for (let i = 0; i < 20000; i++) {
          const y = f.process(2 * Math.sin(i * 0.1) + Math.sin(i * 0.013));
          if (!Number.isFinite(y)) finite = false;
          const a = Math.abs(y);
          if (a > peak) peak = a;
        }
        expect(finite, `${model} c=${cutoff} r=${res}`).toBe(true);
        expect(peak, `${model} c=${cutoff} r=${res}`).toBeLessThan(20);
      }
    }
  });

  it('survives cutoff and resonance sweeping every single sample', () => {
    const f = createFilter(model, SR);
    const n = 96000;
    let peak = 0;
    let finite = true;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      f.setCutoff(20 * Math.pow(SR / 2 / 20, t));
      f.setResonance(0.5 + 0.5 * Math.sin(i * 0.001));
      const y = f.process(2 * Math.sin(i * 0.07));
      if (!Number.isFinite(y)) finite = false;
      const a = Math.abs(y);
      if (a > peak) peak = a;
    }
    expect(finite, `${model} sweep`).toBe(true);
    expect(peak, `${model} sweep`).toBeLessThan(20);
  });

  it('flushes denormal state to exact zero after the signal stops', () => {
    const f = createFilter(model, SR);
    f.setCutoff(1000);
    f.setResonance(0.3);
    for (let i = 0; i < 100; i++) f.process(i === 0 ? 1 : 0);
    let silentAt = -1;
    for (let i = 0; i < 200000; i++) {
      if (f.process(0) === 0) {
        silentAt = i;
        break;
      }
    }
    expect(silentAt, `${model} never flushed`).toBeGreaterThanOrEqual(0);
  });

  it('returns to silence after reset', () => {
    const f = createFilter(model, SR);
    f.setCutoff(800);
    f.setResonance(0.9);
    for (let i = 0; i < 2000; i++) f.process(Math.sin(i * 0.2));
    f.reset();
    expect(f.process(0)).toBe(0);
  });

  it('does not allocate while processing', () => {
    expect(typeof global.gc, 'run vitest with --expose-gc').toBe('function');
    const f = createFilter(model, SR);
    f.setCutoff(1200);
    f.setResonance(0.8);
    for (let i = 0; i < 100000; i++) f.process(Math.sin(i * 0.05));
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    let acc = 0;
    for (let i = 0; i < 1000000; i++) acc += f.process(Math.sin(i * 0.05));
    global.gc?.();
    const after = process.memoryUsage().heapUsed;
    expect(Number.isFinite(acc)).toBe(true);
    expect(after - before).toBeLessThan(64 * 1024);
  });
});

describe('StateVariableFilter modes', () => {
  it('defaults to lowpass', () => {
    const f = new StateVariableFilter(SR);
    f.setCutoff(1000);
    f.setResonance(0.1);
    expect(rmsThrough(f, 100, 1)).toBeGreaterThan(0.5);
  });

  it('highpass rejects lows and passes highs', () => {
    expect(rmsThrough(svf('hp', 1000, 0.1), 50, 1)).toBeLessThan(0.02);
    expect(rmsThrough(svf('hp', 1000, 0.1), 16000, 1)).toBeGreaterThan(0.5);
  });

  it('bandpass rejects both sides and keeps the middle', () => {
    const mid = rmsThrough(svf('bp', 1000, 0.1), 1000, 1);
    expect(rmsThrough(svf('bp', 1000, 0.1), 50, 1)).toBeLessThan(mid * 0.5);
    expect(rmsThrough(svf('bp', 1000, 0.1), 16000, 1)).toBeLessThan(mid * 0.5);
  });

  it('every mode stays bounded at maximum resonance', () => {
    for (const mode of ['lp', 'bp', 'hp'] as SvfMode[]) {
      for (const cutoff of [20, 1000, 20000, SR]) {
        const f = svf(mode, cutoff, 1);
        let peak = 0;
        let finite = true;
        for (let i = 0; i < 20000; i++) {
          const y = f.process(2 * Math.sin(i * 0.1) + Math.sin(i * 0.013));
          if (!Number.isFinite(y)) finite = false;
          const a = Math.abs(y);
          if (a > peak) peak = a;
        }
        expect(finite, `${mode} @ ${cutoff}Hz`).toBe(true);
        expect(peak, `${mode} @ ${cutoff}Hz`).toBeLessThan(20);
      }
    }
  });
});

describe('DiodeFilter character', () => {
  it('saturates asymmetrically, unlike the symmetric ladder', () => {
    // Asymmetric clipping in the feedback path skews the waveform: the two
    // half-cycles no longer mirror each other. That skew is the squelch.
    const f = new DiodeFilter(SR);
    f.setCutoff(300);
    f.setResonance(1);
    let pos = 0;
    let neg = 0;
    for (let i = 0; i < 48000; i++) {
      const y = f.process(3 * Math.sin((2 * Math.PI * 300 * i) / SR));
      if (i > 24000) {
        if (y > pos) pos = y;
        if (y < neg) neg = y;
      }
    }
    expect(pos).toBeGreaterThan(0);
    expect(neg).toBeLessThan(0);
    expect(Math.abs(pos / neg)).not.toBeCloseTo(1, 2);
  });
});
