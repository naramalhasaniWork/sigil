import { describe, it, expect } from 'vitest';
import {
  Lfo, addOsc,
  LFO_SINE, LFO_TRIANGLE, LFO_SQUARE, LFO_SAMPLE_HOLD, LFO_RANDOM_WALK, LFO_SHAPE_COUNT,
  WAVE_SAW, WAVE_PULSE, WAVE_TRIANGLE, WAVE_SINE,
} from '@/dsp/lfo';
import { magnitudeSpectrum } from '../util/fft';

const SR = 48000;

function run(lfo: Lfo, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = lfo.next();
  return out;
}

function make(shape: number, rateHz: number): Lfo {
  const lfo = new Lfo(SR);
  lfo.setShape(shape);
  lfo.setRate(rateHz);
  lfo.setDelayMs(0);
  lfo.seed(1);
  lfo.trigger(true);
  return lfo;
}

describe('Lfo', () => {
  it('keeps every shape inside -1..1', () => {
    for (let shape = 0; shape < LFO_SHAPE_COUNT; shape++) {
      const v = run(make(shape, 7), 40000);
      for (const x of v) {
        expect(Number.isFinite(x), `shape ${shape}`).toBe(true);
        expect(Math.abs(x), `shape ${shape}`).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('reaches close to both rails on the deterministic shapes', () => {
    for (const shape of [LFO_SINE, LFO_TRIANGLE, LFO_SQUARE]) {
      const v = run(make(shape, 5), 40000);
      let lo = 1;
      let hi = -1;
      for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; }
      expect(hi, `shape ${shape} top`).toBeGreaterThan(0.99);
      expect(lo, `shape ${shape} bottom`).toBeLessThan(-0.99);
    }
  });

  it('runs at the rate it was asked for', () => {
    for (const shape of [LFO_SINE, LFO_TRIANGLE, LFO_SQUARE]) {
      for (const hz of [2, 5, 11]) {
        const period = SR / hz;
        const v = run(make(shape, hz), Math.round(period * 4));
        // Compare one whole period later: a correct period repeats exactly.
        for (let i = 0; i < period; i += 97) {
          const a = v[i] as number;
          const b = v[i + Math.round(period)] as number;
          expect(Math.abs(a - b), `shape ${shape} at ${hz}Hz`).toBeLessThan(0.02);
        }
      }
    }
  });

  it('measures the sine LFO period from its own spectrum', () => {
    const hz = 6;
    const n = 16384;
    const v = run(make(LFO_SINE, hz), n);
    const spec = magnitudeSpectrum(Float32Array.from(v));
    let peak = 0;
    for (let i = 1; i < spec.length; i++) if ((spec[i] as number) > (spec[peak] as number)) peak = i;
    expect((peak * SR) / n).toBeCloseTo(hz, 0);
  });

  it('holds sample-and-hold flat between steps and steps once per cycle', () => {
    const hz = 20;
    const period = SR / hz;
    const v = run(make(LFO_SAMPLE_HOLD, hz), Math.round(period * 8));
    let steps = 0;
    for (let i = 1; i < v.length; i++) {
      if ((v[i] as number) !== (v[i - 1] as number)) steps++;
    }
    expect(steps).toBeGreaterThanOrEqual(7);
    expect(steps).toBeLessThanOrEqual(8);
    // Everything between two steps must be identical, not merely similar.
    const mid = Math.round(period * 2.5);
    for (let i = mid; i < mid + Math.round(period * 0.4); i++) {
      expect(v[i]).toBe(v[mid]);
    }
  });

  it('keeps the random walk bounded and moving', () => {
    const lfo = make(LFO_RANDOM_WALK, 40);
    const v = run(lfo, SR * 4);
    let lo = 2;
    let hi = -2;
    let moved = 0;
    for (let i = 1; i < v.length; i++) {
      const x = v[i] as number;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
      if (Math.abs(x - (v[i - 1] as number)) > 1e-9) moved++;
    }
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(0.5);
    expect(moved).toBeGreaterThan(v.length * 0.8);
  });

  it('fades in over the delay time instead of arriving at full depth', () => {
    const lfo = new Lfo(SR);
    lfo.setShape(LFO_SINE);
    lfo.setRate(20);
    lfo.setDelayMs(500);
    lfo.seed(3);
    lfo.trigger(true);
    const v = run(lfo, SR);
    const peakIn = (from: number, to: number): number => {
      let peak = 0;
      for (let i = from; i < to; i++) if (Math.abs(v[i] as number) > peak) peak = Math.abs(v[i] as number);
      return peak;
    };
    expect(peakIn(0, 4800)).toBeLessThan(0.25);
    expect(peakIn(9600, 14400)).toBeLessThan(0.75);
    expect(peakIn(30000, SR)).toBeGreaterThan(0.98);
  });

  it('restarts the phase on keysync and leaves it alone without', () => {
    const synced = make(LFO_SINE, 3);
    run(synced, 5000);
    synced.trigger(true);
    expect(synced.next()).toBeCloseTo(Math.sin((2 * Math.PI * 3) / SR), 6);

    const free = make(LFO_SINE, 3);
    const before = run(free, 5000);
    free.trigger(false);
    expect(free.next()).not.toBeCloseTo(before[0] as number, 4);
  });

  it('gives different voices different random streams', () => {
    const a = new Lfo(SR); a.setShape(LFO_SAMPLE_HOLD); a.setRate(50); a.setDelayMs(0);
    a.seed(0); a.trigger(true);
    const b = new Lfo(SR); b.setShape(LFO_SAMPLE_HOLD); b.setRate(50); b.setDelayMs(0);
    b.seed(7); b.trigger(true);
    const va = run(a, 20000);
    const vb = run(b, 20000);
    let same = 0;
    for (let i = 0; i < va.length; i++) if (va[i] === vb[i]) same++;
    expect(same).toBeLessThan(va.length * 0.2);
  });

  it('scales by depth and clamps nonsense settings', () => {
    const lfo = make(LFO_SQUARE, 10);
    lfo.setDepth(0.25);
    const v = run(lfo, 20000);
    let hi = 0;
    for (const x of v) if (Math.abs(x) > hi) hi = Math.abs(x);
    expect(hi).toBeCloseTo(0.25, 6);

    const wild = new Lfo(SR);
    wild.setRate(-5);
    wild.setShape(99);
    wild.setDepth(50);
    wild.setDelayMs(-100);
    for (const x of run(wild, 1000)) expect(Math.abs(x)).toBeLessThanOrEqual(1);
  });
});

describe('addOsc', () => {
  const N = 8192;
  // Deliberately incommensurate with the sample rate: at an even divisor every
  // aliased image folds onto a real harmonic and becomes impossible to measure.
  const FREQ = 3217;

  // The triangle integrator needs a few cycles to settle; measuring across its
  // startup transient would smear energy into every bin and prove nothing.
  function render(shape: number, pw: number): Float32Array {
    const buf = new Float64Array(N);
    const ph = new Float64Array(1);
    const tri = new Float64Array(1);
    for (let k = 0; k < 4; k++) {
      buf.fill(0);
      addOsc(shape, buf, N, ph, tri, 0, FREQ / SR, pw, 1);
    }
    return Float32Array.from(buf);
  }

  function naive(shape: number, pw: number): Float32Array {
    const out = new Float32Array(N);
    const inc = FREQ / SR;
    let p = 0;
    let t = 0;
    for (let i = 0; i < N; i++) {
      p += inc; if (p >= 1) p -= 1;
      if (shape === WAVE_PULSE) out[i] = p < pw ? 1 : -1;
      else { t = p < 0.5 ? 4 * p - 1 : 3 - 4 * p; out[i] = t; }
    }
    return out;
  }

  /**
   * Hann window before the transform. Without it the measurement is dominated
   * by the fundamental's own leakage skirt rather than by aliasing, and both a
   * clean and a filthy oscillator score the same.
   */
  function windowed(buf: Float32Array): Float32Array {
    const w = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) {
      w[i] = (buf[i] as number) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / buf.length));
    }
    return w;
  }

  function inharmonic(spec: Float32Array): number {
    const binHz = SR / N;
    let energy = 0;
    for (let i = 1; i < spec.length; i++) {
      const ratio = (i * binHz) / FREQ;
      if (Math.abs(ratio - Math.round(ratio)) > 0.12) energy += (spec[i] as number) ** 2;
    }
    return energy;
  }

  it('aliases far less than a naive pulse at a high pitch', () => {
    const clean = inharmonic(magnitudeSpectrum(windowed(render(WAVE_PULSE, 0.5))));
    const dirty = inharmonic(magnitudeSpectrum(windowed(naive(WAVE_PULSE, 0.5))));
    expect(clean).toBeLessThan(dirty * 0.5);
  });

  it('aliases far less than a naive triangle at a high pitch', () => {
    const clean = inharmonic(magnitudeSpectrum(windowed(render(WAVE_TRIANGLE, 0.5))));
    const dirty = inharmonic(magnitudeSpectrum(windowed(naive(WAVE_TRIANGLE, 0.5))));
    expect(clean).toBeLessThan(dirty * 0.5);
  });

  it('keeps every shape bounded and finite', () => {
    for (const shape of [WAVE_SAW, WAVE_PULSE, WAVE_TRIANGLE, WAVE_SINE]) {
      for (const pw of [0.06, 0.5, 0.94]) {
        const buf = render(shape, pw);
        for (const x of buf) {
          expect(Number.isFinite(x), `shape ${shape}`).toBe(true);
          expect(Math.abs(x), `shape ${shape} pw ${pw}`).toBeLessThan(2.1);
        }
      }
    }
  });

  it('adds into its buffer rather than overwriting it', () => {
    const buf = new Float64Array(64);
    buf.fill(1);
    addOsc(WAVE_SAW, buf, 64, new Float64Array(1), new Float64Array(1), 0, 0.01, 0.5, 1);
    let changed = 0;
    for (const x of buf) if (x !== 1) changed++;
    expect(changed).toBe(64);
  });
});
