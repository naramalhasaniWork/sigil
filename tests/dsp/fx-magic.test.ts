import { describe, it, expect } from 'vitest';
import { MagicChain } from '@/dsp/fx-magic';
import { FX_MAGIC_DESCRIPTOR, MAGIC_PARAM as P } from '@/dsp/fx-magic-descriptor';
import { magnitudeSpectrum } from '../util/fft';

const SR = 48000;
const BLOCK = 128;
const PARAMS = FX_MAGIC_DESCRIPTOR.params;
const WET = [P.freezeMix, P.shimmerMix, P.shiftMix, P.vowelMix, P.stutterMix];

/** Defaults, then every wet path and the tape turned off — a clean slate. */
function neutral(): MagicChain {
  const fx = new MagicChain(SR);
  for (let i = 0; i < PARAMS.length; i++) fx.setParam(i, PARAMS[i]!.default);
  for (const k of WET) fx.setParam(k, 0);
  fx.setParam(P.tapeWear, 0);
  fx.setParam(P.tapeWow, 0);
  fx.setParam(P.tapeFlutter, 0);
  return fx;
}

function run(fx: MagicChain, input: Float32Array): Float32Array {
  const out = new Float32Array(input.length);
  const block = new Float32Array(BLOCK);
  for (let off = 0; off + BLOCK <= input.length; off += BLOCK) {
    block.set(input.subarray(off, off + BLOCK));
    fx.process(block, BLOCK);
    out.set(block, off);
  }
  return out;
}

/** Let the parameter smoothers reach their targets before measuring anything. */
function settle(fx: MagicChain): void {
  run(fx, new Float32Array(SR >> 2));
}

function sine(n: number, hz: number, amp: number): Float32Array {
  const b = new Float32Array(n);
  const inc = (2 * Math.PI * hz) / SR;
  for (let i = 0; i < n; i++) b[i] = Math.sin(inc * i) * amp;
  return b;
}

/** Seeded noise — tests must not depend on Math.random() either. */
function noise(n: number, seed: number, amp: number): Float32Array {
  const b = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    b[i] = (s / 2147483648 - 1) * amp;
  }
  return b;
}

function rms(b: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += b[i]! * b[i]!;
  return Math.sqrt(s / (to - from));
}

function maxDelta(b: Float32Array, from: number, to: number): number {
  let m = 0;
  for (let i = from + 1; i < to; i++) {
    const d = Math.abs(b[i]! - b[i - 1]!);
    if (d > m) m = d;
  }
  return m;
}

/** Hann-windowed magnitude spectrum of `n` samples starting at `from`. */
function spectrum(b: Float32Array, from: number, n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = b[from + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  return magnitudeSpectrum(w);
}

function band(sp: Float32Array, lo: number, hi: number): number {
  const bw = SR / (sp.length * 2);
  let s = 0;
  for (let i = Math.max(1, Math.floor(lo / bw)); i <= Math.min(sp.length - 1, Math.ceil(hi / bw)); i++) {
    s += sp[i]! * sp[i]!;
  }
  return s;
}

function peakHz(sp: Float32Array, lo: number, hi: number): number {
  const bw = SR / (sp.length * 2);
  let best = 0;
  let bestI = 0;
  for (let i = Math.max(1, Math.floor(lo / bw)); i <= Math.min(sp.length - 1, Math.ceil(hi / bw)); i++) {
    if (sp[i]! > best) { best = sp[i]!; bestI = i; }
  }
  return bestI * bw;
}

describe('FREEZE', () => {
  it('keeps sounding through four seconds of silence after a capture', () => {
    const fx = neutral();
    settle(fx);
    const tone = sine(SR, 137, 0.5);
    const played = run(fx, tone);
    const playedRms = rms(played, SR >> 1, SR);

    fx.setParam(P.freezeLength, 500);
    fx.setParam(P.freezeMix, 1);
    fx.setParam(P.freezeCapture, 1);
    const held = run(fx, new Float32Array(SR * 4));

    // Silence in. Anything coming out is the loop, still running seconds later.
    const early = rms(held, SR >> 1, SR);
    const late = rms(held, SR * 3, SR * 4);
    expect(early).toBeGreaterThan(playedRms * 0.5);
    expect(late).toBeGreaterThan(playedRms * 0.5);
    expect(late).toBeLessThan(playedRms * 1.5);
    expect(Math.abs(late / early - 1)).toBeLessThan(0.15);
  });

  it('splices the loop without a click', () => {
    const fx = neutral();
    settle(fx);
    run(fx, sine(SR, 137, 0.5));
    fx.setParam(P.freezeLength, 500);
    fx.setParam(P.freezeMix, 1);
    fx.setParam(P.freezeCapture, 1);
    const held = run(fx, new Float32Array(SR * 3));

    // 137 Hz at 0.5 moves at most 0.009 per sample, and 500 ms of it is 68.5
    // cycles — so the loop wraps anti-phase and a splice with no crossfade
    // would show up here as a jump two orders of magnitude larger.
    const slew = maxDelta(held, SR, SR * 3);
    expect(slew).toBeLessThan(0.02);
  });

  it('releases the hold when the capture trigger goes off', () => {
    const fx = neutral();
    settle(fx);
    run(fx, sine(SR >> 1, 137, 0.5));
    fx.setParam(P.freezeMix, 1);
    fx.setParam(P.freezeCapture, 1);
    run(fx, new Float32Array(SR >> 1));
    fx.setParam(P.freezeCapture, 0);
    const after = run(fx, new Float32Array(SR >> 1));
    expect(rms(after, SR >> 2, SR >> 1)).toBeLessThan(1e-5);
  });
});

describe('SHIMMER', () => {
  it('grows an octave in the tail that was never in the input', () => {
    const fx = neutral();
    fx.setParam(P.shimmerMix, 1);
    fx.setParam(P.shimmerFeedback, 0.8);
    fx.setParam(P.shimmerPitch, 12);
    fx.setParam(P.shimmerDamp, 0.15);
    fx.setParam(P.shimmerSize, 120);
    settle(fx);

    const input = sine(SR * 2, 220, 0.5);
    run(fx, input);
    const tail = run(fx, new Float32Array(SR));

    const inSp = spectrum(input, SR, 16384);
    const tailSp = spectrum(tail, 4096, 16384);
    const inOct = band(inSp, 425, 455);
    const tailOct = band(tailSp, 425, 455);
    const tailFund = band(tailSp, 210, 230);

    expect(tailOct).toBeGreaterThan(inOct * 50);
    expect(tailOct).toBeGreaterThan(tailFund * 0.1);
  });

  it('always decays, even with feedback and size at maximum', () => {
    const fx = neutral();
    fx.setParam(P.shimmerMix, 1);
    fx.setParam(P.shimmerFeedback, 1);
    fx.setParam(P.shimmerDamp, 0);
    fx.setParam(P.shimmerSize, 500);
    settle(fx);
    run(fx, sine(SR, 220, 0.9));
    const tail = run(fx, new Float32Array(SR * 12));
    expect(rms(tail, 0, SR)).toBeGreaterThan(rms(tail, SR * 11, SR * 12));
    expect(rms(tail, SR * 11, SR * 12)).toBeLessThan(rms(tail, 0, SR) * 0.5);
  });
});

describe('FREQUENCY SHIFTER', () => {
  it('moves a 500 Hz tone to 800 Hz for a +300 Hz shift, not to a harmonic', () => {
    const fx = neutral();
    fx.setParam(P.shiftMix, 1);
    fx.setParam(P.shiftRing, 0);
    fx.setParam(P.shiftHz, 300);
    settle(fx);
    const out = run(fx, sine(SR, 500, 0.5));
    const sp = spectrum(out, SR >> 1, 16384);

    expect(peakHz(sp, 100, 4000)).toBeCloseTo(800, -1);
    // A pitch shifter would have landed on a multiple of 500. This did not.
    expect(band(sp, 780, 820)).toBeGreaterThan(band(sp, 980, 1020) * 100);
    expect(band(sp, 780, 820)).toBeGreaterThan(band(sp, 480, 520) * 100);
  });

  it('shifts downward for a negative amount', () => {
    const fx = neutral();
    fx.setParam(P.shiftMix, 1);
    fx.setParam(P.shiftHz, -300);
    settle(fx);
    const out = run(fx, sine(SR, 500, 0.5));
    expect(peakHz(spectrum(out, SR >> 1, 16384), 50, 4000)).toBeCloseTo(200, -1);
  });

  it('makes both sidebands in ring mode', () => {
    const fx = neutral();
    fx.setParam(P.shiftMix, 1);
    fx.setParam(P.shiftRing, 1);
    fx.setParam(P.shiftHz, 300);
    settle(fx);
    const sp = spectrum(run(fx, sine(SR, 500, 0.5)), SR >> 1, 16384);
    const sum = band(sp, 780, 820);
    const diff = band(sp, 180, 220);
    expect(diff).toBeGreaterThan(sum * 0.25);
    expect(sum).toBeGreaterThan(diff * 0.25);
  });
});

describe('VOWEL', () => {
  function vowelSpectrum(pos: number): Float32Array {
    const fx = neutral();
    fx.setParam(P.vowelMix, 1);
    fx.setParam(P.vowelPos, pos);
    fx.setParam(P.vowelSharp, 0.85);
    settle(fx);
    return spectrum(run(fx, noise(SR, 7, 0.3)), SR >> 1, 16384);
  }

  it('parks its resonances on A when the morph is at the bottom', () => {
    const sp = vowelSpectrum(0);
    expect(peakHz(sp, 100, 5000)).toBeGreaterThan(600);
    expect(peakHz(sp, 100, 5000)).toBeLessThan(900);
    expect(band(sp, 650, 820)).toBeGreaterThan(band(sp, 1900, 2100) * 2);
    expect(band(sp, 950, 1250)).toBeGreaterThan(band(sp, 1500, 1700) * 2);
  });

  it('parks them somewhere else entirely on I', () => {
    const sp = vowelSpectrum(0.5);
    expect(peakHz(sp, 100, 5000)).toBeLessThan(340);
    expect(band(sp, 240, 320)).toBeGreaterThan(band(sp, 700, 900) * 3);
    expect(band(sp, 2150, 2450)).toBeGreaterThan(band(sp, 1200, 1600) * 2);
  });
});

describe('STUTTER', () => {
  function stuttered(seed: number): Float32Array {
    const fx = neutral();
    fx.setParam(P.stutterMix, 1);
    fx.setParam(P.stutterChance, 1);
    fx.setParam(P.stutterSlice, 100);
    fx.setParam(P.stutterPitch, 0);
    fx.setParam(P.stutterSeed, seed);
    settle(fx);
    return run(fx, noise(SR * 2, 11, 0.4));
  }

  it('is bit-identical from the same seed and different from another', () => {
    const a = stuttered(1337);
    const b = stuttered(1337);
    const c = stuttered(4242);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(c[i]! - a[i]!) > 1e-6) diff++;
    expect(diff).toBeGreaterThan(a.length * 0.1);
  });

  it('actually repeats slices that the input never repeated', () => {
    const lag = 4800;
    const out = stuttered(1337);
    const src = noise(SR * 2, 11, 0.4);
    let same = 0;
    for (let i = lag; i < out.length; i++) if (Math.abs(out[i]! - out[i - lag]!) < 1e-4) same++;
    let srcSame = 0;
    for (let i = lag; i < src.length; i++) if (Math.abs(src[i]! - src[i - lag]!) < 1e-4) srcSame++;
    expect(same).toBeGreaterThan(lag);
    expect(srcSame).toBeLessThan(lag * 0.1);
  });
});

describe('stability', () => {
  function assertSane(out: Float32Array, label: string): void {
    for (let i = 0; i < out.length; i++) {
      const v = out[i]!;
      if (!Number.isFinite(v) || v > 1.2001 || v < -1.2001) {
        throw new Error(`${label} produced ${v} at sample ${i}`);
      }
    }
  }

  it('survives every parameter at both extremes', () => {
    for (let p = 0; p < PARAMS.length; p++) {
      const d = PARAMS[p]!;
      for (const extreme of [d.min, d.max]) {
        const fx = new MagicChain(SR);
        fx.setParam(p, extreme);
        const hot = noise(SR, 3, 0.95);
        assertSane(run(fx, hot), `${d.id}=${extreme}`);
        assertSane(run(fx, new Float32Array(SR)), `${d.id}=${extreme} tail`);
      }
    }
  });

  it('survives every parameter at maximum at once, for a long time', () => {
    const fx = new MagicChain(SR);
    for (let p = 0; p < PARAMS.length; p++) fx.setParam(p, PARAMS[p]!.max);
    for (let s = 0; s < 10; s++) assertSane(run(fx, noise(SR, s + 1, 0.99)), 'all-max');
    assertSane(run(fx, new Float32Array(SR * 4)), 'all-max tail');
  });

  it('survives randomised parameter combinations', () => {
    let seed = 20260817 >>> 0;
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 24; trial++) {
      const fx = new MagicChain(SR);
      for (let p = 0; p < PARAMS.length; p++) {
        const d = PARAMS[p]!;
        fx.setParam(p, d.min + (d.max - d.min) * rand());
      }
      assertSane(run(fx, noise(SR, trial + 100, 0.9)), `trial ${trial}`);
      for (let p = 0; p < PARAMS.length; p++) {
        const d = PARAMS[p]!;
        fx.setParam(p, d.min + (d.max - d.min) * rand());
      }
      assertSane(run(fx, noise(SR, trial + 200, 0.9)), `trial ${trial} moved`);
    }
  });

  it('recovers rather than poisoning the bus if fed rubbish', () => {
    const fx = neutral();
    const bad = new Float32Array(BLOCK);
    bad.fill(Number.NaN);
    fx.process(bad, BLOCK);
    const out = run(fx, sine(SR, 220, 0.5));
    for (let i = SR >> 1; i < SR; i++) expect(Number.isFinite(out[i]!)).toBe(true);
    expect(rms(out, SR >> 1, SR)).toBeGreaterThan(0.1);
  });
});

describe('discipline', () => {
  it('allocates nothing while processing', () => {
    // Without a real gc() this test would measure framework garbage rather
    // than the audio loop, and silently mean nothing.
    expect(typeof global.gc, 'run vitest with --expose-gc').toBe('function');
    const fx = new MagicChain(SR);
    for (let p = 0; p < PARAMS.length; p++) fx.setParam(p, PARAMS[p]!.max * 0.6);
    fx.setParam(P.freezeCapture, 1);
    const block = new Float32Array(BLOCK);
    for (let i = 0; i < 500; i++) {
      for (let k = 0; k < BLOCK; k++) block[k] = Math.sin(k * 0.1) * 0.5;
      fx.process(block, BLOCK);
    }
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 4000; i++) {
      for (let k = 0; k < BLOCK; k++) block[k] = Math.sin(k * 0.1) * 0.5;
      fx.process(block, BLOCK);
    }
    global.gc?.();
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024);
  });

  it('explains every parameter and assigns exactly four macros', () => {
    for (const p of PARAMS) {
      expect(p.explain.length, `${p.id} needs a real explanation`).toBeGreaterThan(20);
      expect(p.default).toBeGreaterThanOrEqual(p.min);
      expect(p.default).toBeLessThanOrEqual(p.max);
    }
    const ids = PARAMS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const macros = PARAMS.filter((p) => p.macro !== undefined).map((p) => p.macro);
    expect(macros.length).toBe(4);
    expect(new Set(macros)).toEqual(new Set([0, 1, 2, 3]));
  });

  it('indexes the parameter table exactly as the chain expects', () => {
    expect(PARAMS[P.freezeCapture]!.id).toBe('freeze-capture');
    expect(PARAMS[P.shimmerMix]!.id).toBe('shimmer-mix');
    expect(PARAMS[P.shiftHz]!.id).toBe('shift-hz');
    expect(PARAMS[P.vowelPos]!.id).toBe('vowel-pos');
    expect(PARAMS[P.stutterSeed]!.id).toBe('stutter-seed');
    expect(PARAMS[P.tapeFlutter]!.id).toBe('tape-flutter');
    expect(PARAMS.length).toBe(Object.keys(P).length);
  });
});


