import { describe, it, expect } from 'vitest';
import type { ParamDescriptor } from '@/audio/types';
import { FxChain } from '@/dsp/fx';
import { FX_DESCRIPTOR } from '@/dsp/fx-descriptor';
import { magnitudeSpectrum } from '../util/fft';

const SR = 48000;
const P: readonly ParamDescriptor[] = FX_DESCRIPTOR.params;

function idx(id: string): number {
  const i = P.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`no such param: ${id}`);
  return i;
}

function set(fx: FxChain, id: string, v: number): void {
  fx.setParam(idx(id), v);
}

/** Everything at its default, then every wet path shut off, so a test can look
 *  at one stage in isolation. Mixes at zero must be bit-exact bypass. */
function neutral(fx: FxChain): void {
  for (let i = 0; i < P.length; i++) fx.setParam(i, (P[i] as ParamDescriptor).default);
  set(fx, 'drive-amount', 0);
  set(fx, 'drive-tone', 0.5);
  set(fx, 'crush-rate', 0);
  set(fx, 'crush-bits', 16);
  set(fx, 'chorus-mix', 0);
  set(fx, 'delay-mix', 0);
  set(fx, 'reverb-mix', 0);
  set(fx, 'output-trim', 0);
  fx.reset();
}

function render(fx: FxChain, input: Float32Array): Float32Array {
  const out = Float32Array.from(input);
  for (let i = 0; i < out.length; i += 128) {
    const n = Math.min(128, out.length - i);
    fx.process(out.subarray(i, i + n), n);
  }
  return out;
}

function sine(n: number, hz: number, amp: number): Float32Array {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return b;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('FX_DESCRIPTOR', () => {
  it('explains every parameter in plain language', () => {
    for (const p of P) {
      expect(p.explain.length, `${p.id} needs an explanation`).toBeGreaterThan(20);
    }
  });

  it('has unique ids and in-range defaults', () => {
    const ids = P.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of P) {
      expect(p.default).toBeGreaterThanOrEqual(p.min);
      expect(p.default).toBeLessThanOrEqual(p.max);
    }
  });

  it('assigns exactly four macros, one each', () => {
    const macros = P.filter((p) => p.macro !== undefined).map((p) => p.macro);
    expect(macros.length).toBe(4);
    expect(new Set(macros)).toEqual(new Set([0, 1, 2, 3]));
  });

  it('keeps the parameter order that fx.ts addresses by index', () => {
    expect(P.map((p) => p.id)).toEqual([
      'drive-amount', 'drive-tone', 'crush-rate', 'crush-bits',
      'chorus-rate', 'chorus-depth', 'chorus-width', 'chorus-mix',
      'delay-time', 'delay-feedback', 'delay-tone', 'delay-width', 'delay-mix',
      'reverb-predelay', 'reverb-size', 'reverb-decay', 'reverb-damping', 'reverb-mix',
      'output-trim',
    ]);
  });
});

describe('reverb', () => {
  it('decays monotonically to silence and never grows', () => {
    const fx = new FxChain(SR);
    neutral(fx);
    set(fx, 'reverb-mix', 1);
    set(fx, 'reverb-decay', 2000);
    set(fx, 'reverb-size', 0.7);
    set(fx, 'reverb-damping', 0.4);
    set(fx, 'reverb-predelay', 0);
    fx.reset();

    const n = SR * 6;
    const buf = new Float32Array(n);
    buf[0] = 1;
    const out = render(fx, buf);

    // Skip the first half second: an FDN builds up before it decays.
    const win = SR >> 2;
    const rms: number[] = [];
    for (let s = win * 2; s + win <= n; s += win) {
      let acc = 0;
      for (let i = s; i < s + win; i++) acc += (out[i] as number) ** 2;
      rms.push(Math.sqrt(acc / win));
    }

    expect(rms.length).toBeGreaterThan(15);
    expect(rms[0] as number).toBeGreaterThan(1e-5);
    for (let i = 1; i < rms.length; i++) {
      // Falling by at least 5% per window is both "never grows" and "decays".
      expect(rms[i] as number, `window ${i} grew`).toBeLessThanOrEqual(
        (rms[i - 1] as number) * 0.95,
      );
    }
    expect(rms[rms.length - 1] as number).toBeLessThan(1e-8);
  });

  it('reaches near-silence even at maximum decay and feedback', () => {
    const fx = new FxChain(SR);
    neutral(fx);
    set(fx, 'reverb-mix', 1);
    set(fx, 'reverb-decay', 12000);
    set(fx, 'reverb-size', 1);
    set(fx, 'reverb-damping', 0);
    fx.reset();
    const n = SR * 90;
    const buf = new Float32Array(128);
    buf[0] = 1;
    let peakLate = 0;
    for (let b = 0; b < n / 128; b++) {
      fx.process(buf, 128);
      if (b > n / 128 - 100) {
        for (let i = 0; i < 128; i++) {
          const a = Math.abs(buf[i] as number);
          if (a > peakLate) peakLate = a;
        }
      }
      buf.fill(0);
    }
    expect(peakLate).toBeLessThan(1e-6);
  });
});

describe('delay', () => {
  it('puts the first repeat at the requested sample offset', () => {
    for (const ms of [100, 500]) {
      const fx = new FxChain(SR);
      neutral(fx);
      set(fx, 'delay-mix', 1);
      set(fx, 'delay-feedback', 0);
      set(fx, 'delay-width', 0);
      set(fx, 'delay-time', ms);
      fx.reset();

      const want = Math.round((ms / 1000) * SR);
      const buf = new Float32Array(want + 4096);
      buf[0] = 1;
      const out = render(fx, buf);

      let peak = 0;
      let at = -1;
      for (let i = 64; i < out.length; i++) {
        const a = Math.abs(out[i] as number);
        if (a > peak) { peak = a; at = i; }
      }
      expect(peak, `${ms}ms produced no repeat`).toBeGreaterThan(0.1);
      expect(Math.abs(at - want), `${ms}ms landed at ${at}, wanted ${want}`)
        .toBeLessThanOrEqual(3);
    }
  });

  it('darkens successive repeats through the feedback lowpass', () => {
    const fx = new FxChain(SR);
    neutral(fx);
    set(fx, 'delay-mix', 1);
    set(fx, 'delay-feedback', 0.7);
    set(fx, 'delay-width', 0);
    set(fx, 'delay-time', 100);
    set(fx, 'delay-tone', 1000);
    fx.reset();

    const step = Math.round(0.1 * SR);
    const buf = new Float32Array(step * 4);
    buf[0] = 1;
    const out = render(fx, buf);

    // Level alone always falls with feedback under unity, so compare the tilt
    // of each repeat instead: darkening means less treble per unit of bass.
    const tilt = (from: number): number => {
      const frame = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) frame[i] = out[from + i] as number;
      const mag = magnitudeSpectrum(frame);
      let lo = 0;
      let hi = 0;
      for (let i = 1; i < mag.length; i++) {
        const e = (mag[i] as number) ** 2;
        if (i < 21) lo += e;
        else if (i > 85) hi += e;
      }
      return hi / lo;
    };

    const first = tilt(step);
    const second = tilt(step * 2);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeLessThan(first * 0.5);
  });
});

describe('chorus', () => {
  it('modulates the comb over time, and holds still at zero depth', () => {
    const spread = (depth: number): number => {
      const fx = new FxChain(SR);
      neutral(fx);
      set(fx, 'chorus-mix', 1);
      set(fx, 'chorus-rate', 2);
      set(fx, 'chorus-depth', depth);
      fx.reset();
      const out = render(fx, sine(SR * 2, 330, 0.35));
      const win = SR / 20;
      let lo = Infinity;
      let hi = 0;
      let sum = 0;
      let count = 0;
      for (let s = SR / 2; s + win <= out.length; s += win) {
        let acc = 0;
        for (let i = s; i < s + win; i++) acc += (out[i] as number) ** 2;
        const r = Math.sqrt(acc / win);
        if (r < lo) lo = r;
        if (r > hi) hi = r;
        sum += r;
        count++;
      }
      return (hi - lo) / (sum / count);
    };
    expect(spread(1)).toBeGreaterThan(0.1);
    expect(spread(0)).toBeLessThan(0.02);
  });

  it('is an exact bypass at zero mix', () => {
    const input = sine(4096, 330, 0.35);
    const still = new FxChain(SR);
    neutral(still);
    set(still, 'chorus-depth', 0);
    still.reset();
    const moving = new FxChain(SR);
    neutral(moving);
    set(moving, 'chorus-depth', 1);
    moving.reset();
    const a = render(still, input);
    const b = render(moving, input);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]);
  });
});

describe('bitcrush', () => {
  it('collapses to a handful of levels at low bit depth', () => {
    const buf = sine(4096, 220, 0.8);

    const crushed = new FxChain(SR);
    neutral(crushed);
    set(crushed, 'crush-bits', 3);
    crushed.reset();
    const low = render(crushed, buf);

    const clean = new FxChain(SR);
    neutral(clean);
    const high = render(clean, buf);

    const distinct = (a: Float32Array): number => {
      const seen = new Set<number>();
      for (let i = 0; i < a.length; i++) seen.add(Math.round((a[i] as number) * 1e6));
      return seen.size;
    };

    expect(distinct(low)).toBeGreaterThan(1);
    expect(distinct(low)).toBeLessThanOrEqual(12);
    expect(distinct(high)).toBeGreaterThan(200);
  });

  it('holds samples when the rate is reduced', () => {
    const fx = new FxChain(SR);
    neutral(fx);
    set(fx, 'crush-rate', 1);
    fx.reset();
    const out = render(fx, sine(2048, 220, 0.8));
    let repeats = 0;
    for (let i = 1; i < out.length; i++) if (out[i] === out[i - 1]) repeats++;
    expect(repeats).toBeGreaterThan(out.length * 0.9);
  });
});

describe('drive', () => {
  it('grows harmonic energy above the fundamental as drive rises', () => {
    const N = 8192;
    const bin = 38;
    const hz = (SR * bin) / N;
    const ratios: number[] = [];

    for (const drive of [0, 0.2, 0.5, 0.9]) {
      const fx = new FxChain(SR);
      neutral(fx);
      set(fx, 'drive-amount', drive);
      fx.reset();
      const out = render(fx, sine(N * 2, hz, 0.3));

      const frame = new Float32Array(N);
      for (let i = 0; i < N; i++) frame[i] = out[N + i] as number;
      const mag = magnitudeSpectrum(frame);

      let fund = 0;
      let rest = 0;
      for (let i = 2; i < mag.length; i++) {
        const e = (mag[i] as number) ** 2;
        if (Math.abs(i - bin) <= 1) fund += e;
        else rest += e;
      }
      ratios.push(rest / fund);
    }

    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i] as number, `drive step ${i} added no harmonics`)
        .toBeGreaterThan(ratios[i - 1] as number);
    }
  });

  it('does not simply turn drive into a volume control', () => {
    const rms = (a: Float32Array): number => {
      let acc = 0;
      for (let i = 0; i < a.length; i++) acc += (a[i] as number) ** 2;
      return Math.sqrt(acc / a.length);
    };
    const input = sine(8192, 220, 0.35);
    const levels: number[] = [];
    for (const drive of [0, 0.5, 1]) {
      const fx = new FxChain(SR);
      neutral(fx);
      set(fx, 'drive-amount', drive);
      fx.reset();
      levels.push(rms(render(fx, input)));
    }
    const quiet = Math.min(...levels);
    const loud = Math.max(...levels);
    expect(loud / quiet).toBeLessThan(2);
  });
});

describe('stability', () => {
  const BLOCKS = 200;

  function sweep(fx: FxChain): { bad: number; peak: number } {
    const buf = new Float32Array(128);
    let ph = 0;
    let bad = 0;
    let peak = 0;
    for (let b = 0; b < BLOCKS; b++) {
      for (let i = 0; i < 128; i++) {
        ph += 220 / SR;
        if (ph >= 1) ph -= 1;
        buf[i] = 0.9 * Math.sin(2 * Math.PI * ph);
      }
      fx.process(buf, 128);
      for (let i = 0; i < 128; i++) {
        const y = buf[i] as number;
        if (!Number.isFinite(y)) bad++;
        const a = Math.abs(y);
        if (a > peak) peak = a;
      }
    }
    return { bad, peak };
  }

  it('survives every parameter at both extremes', () => {
    for (let p = 0; p < P.length; p++) {
      const d = P[p] as ParamDescriptor;
      for (const v of [d.min, d.max]) {
        const fx = new FxChain(SR);
        for (let i = 0; i < P.length; i++) fx.setParam(i, (P[i] as ParamDescriptor).default);
        fx.setParam(p, v);
        fx.reset();
        const r = sweep(fx);
        expect(r.bad, `${d.id}=${v} produced non-finite output`).toBe(0);
        expect(r.peak, `${d.id}=${v} exceeded the limiter`).toBeLessThanOrEqual(1.5001);
      }
    }
  });

  it('survives randomised parameter combinations', () => {
    const rand = mulberry32(0x51617);
    for (let trial = 0; trial < 40; trial++) {
      const fx = new FxChain(SR);
      for (let i = 0; i < P.length; i++) {
        const d = P[i] as ParamDescriptor;
        fx.setParam(i, d.min + rand() * (d.max - d.min));
      }
      fx.reset();
      const r = sweep(fx);
      expect(r.bad, `trial ${trial} produced non-finite output`).toBe(0);
      expect(r.peak, `trial ${trial} exceeded the limiter`).toBeLessThanOrEqual(1.5001);
    }
  });
});

describe('allocation', () => {
  it('does not grow the heap across a sustained process loop', () => {
    // Without a real gc() this would measure framework garbage and mean nothing.
    expect(typeof global.gc, 'run vitest with --expose-gc').toBe('function');
    const fx = new FxChain(SR);
    const buf = new Float32Array(128);
    let ph = 0;
    const fill = (): void => {
      for (let i = 0; i < 128; i++) {
        ph += 220 / SR;
        if (ph >= 1) ph -= 1;
        buf[i] = 0.3 * Math.sin(2 * Math.PI * ph);
      }
    };

    for (let b = 0; b < 500; b++) { fill(); fx.process(buf, 128); }
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let b = 0; b < 4000; b++) { fill(); fx.process(buf, 128); }
    global.gc?.();
    const after = process.memoryUsage().heapUsed;
    // Catches anything the chain retains: a growing array, a cached object, a
    // closure parked in a field. Every buffer here is built in a constructor.
    expect(after - before).toBeLessThan(64 * 1024);
  });
});

/*
 * The default chain must not touch the signal.
 *
 * These exist because it did. Two always-on stages — a quantiser that rounded
 * every sample to 1/32768 even at the 16-bit default, and an output stage of
 * `sat(x / 1.5) * 1.5` with no linear region — put measurable distortion on
 * every sample with every control at zero. Measured: -48 dB THD+N at -20 dBFS
 * rising to -30 dB and -0.8 dB of level loss at full scale. Nobody had asked
 * for any of it, and it is the mechanism behind a long-running complaint that
 * the instrument sounded slightly veiled.
 *
 * "Bit-exact" is the assertion on purpose. "Close enough" is how the original
 * survived this long.
 */
describe('transparency at defaults', () => {
  /** Peak-normalised sine, the signal a voice actually presents. */
  function sine(n: number, hz: number, amp: number): Float32Array {
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) b[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
    return b;
  }

  function throughNeutral(input: Float32Array): Float32Array {
    const fx = new FxChain(SR);
    neutral(fx);
    const out = Float32Array.from(input);
    // Long enough for every smoother to have settled onto its target.
    fx.process(out, out.length);
    return out;
  }

  it('passes a quiet signal through bit-exactly', () => {
    const input = sine(2048, 220, 0.1);
    const out = throughNeutral(input);
    for (let i = 0; i < input.length; i++) {
      expect(out[i]).toBe(input[i]);
    }
  });

  /*
   * The level that mattered most: physical percussion peaks around -1.6 dBFS
   * per voice, so hot material sat permanently in the worst of the distortion.
   */
  it('passes a hot signal through bit-exactly', () => {
    const input = sine(2048, 220, 0.95);
    const out = throughNeutral(input);
    for (let i = 0; i < input.length; i++) {
      expect(out[i]).toBe(input[i]);
    }
  });

  it('loses no level at full scale', () => {
    const input = sine(4096, 110, 1);
    const out = throughNeutral(input);
    let peakIn = 0, peakOut = 0;
    for (let i = 0; i < input.length; i++) {
      const a = Math.abs(input[i] as number), b = Math.abs(out[i] as number);
      if (a > peakIn) peakIn = a;
      if (b > peakOut) peakOut = b;
    }
    expect(peakOut).toBeCloseTo(peakIn, 6);
  });

  /*
   * Transparency must not have been bought by removing the safety net. An
   * over still has to be caught, and caught smoothly — a hard clip here would
   * trade a veil for a crackle.
   */
  it('still limits signals that exceed full scale', () => {
    const input = sine(2048, 220, 2.5);
    const out = throughNeutral(input);
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      const a = Math.abs(out[i] as number);
      if (a > peak) peak = a;
    }
    expect(peak).toBeLessThanOrEqual(1.5);
    expect(peak).toBeGreaterThan(1.0);
  });

  it('limits without a discontinuity at the knee', () => {
    const fx = new FxChain(SR);
    neutral(fx);
    // A slow ramp straight through the knee: adjacent outputs must not jump.
    const ramp = new Float32Array(4096);
    for (let i = 0; i < ramp.length; i++) ramp[i] = (i / ramp.length) * 2;
    fx.process(ramp, ramp.length);
    let maxStep = 0;
    for (let i = 1; i < ramp.length; i++) {
      const step = Math.abs((ramp[i] as number) - (ramp[i - 1] as number));
      if (step > maxStep) maxStep = step;
    }
    // The input steps by 2/4096 ≈ 0.00049 per sample; a kink would exceed it.
    expect(maxStep).toBeLessThan(0.001);
  });
});
