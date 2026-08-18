import { describe, it, expect } from 'vitest';
import type { ParamDescriptor } from '@/audio/types';
import { FxChain } from '@/dsp/fx';
import { FX_DESCRIPTOR } from '@/dsp/fx-descriptor';
import { MagicChain } from '@/dsp/fx-magic';
import { MAGIC_PARAM as MP } from '@/dsp/fx-magic-descriptor';
import { VoiceManager } from '@/dsp/voice-manager';
import { AnalogEngine } from '@/dsp/analog-voice';

/**
 * The signal path used to be mono end to end: the worklet rendered one channel
 * and copied it to the rest. Reverb and chorus sell "expensive" almost entirely
 * through width, so these tests measure the width rather than assuming it —
 * correlation coefficients, mono-sum energy, and which side each delay repeat
 * lands on.
 */

const SR = 48000;
const BLOCK = 128;
const P: readonly ParamDescriptor[] = FX_DESCRIPTOR.params;

function idx(id: string): number {
  const i = P.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`no such param: ${id}`);
  return i;
}
function set(fx: FxChain, id: string, v: number): void { fx.setParam(idx(id), v); }

/** Everything at its default, then every wet path shut off. */
function neutral(fx: FxChain): void {
  for (let i = 0; i < P.length; i++) fx.setParam(i, (P[i] as ParamDescriptor).default);
  set(fx, 'drive-amount', 0);
  set(fx, 'crush-rate', 0);
  set(fx, 'crush-bits', 16);
  set(fx, 'chorus-mix', 0);
  set(fx, 'delay-mix', 0);
  set(fx, 'reverb-mix', 0);
  set(fx, 'output-trim', 0);
  fx.reset();
}

function renderMono(fx: FxChain, input: Float32Array): Float32Array {
  const out = Float32Array.from(input);
  for (let i = 0; i < out.length; i += BLOCK) {
    const n = Math.min(BLOCK, out.length - i);
    fx.process(out.subarray(i, i + n), n);
  }
  return out;
}

interface Stereo { l: Float32Array; r: Float32Array }

function renderStereo(fx: FxChain | MagicChain, input: Float32Array): Stereo {
  const l = Float32Array.from(input);
  const r = Float32Array.from(input);
  for (let i = 0; i < l.length; i += BLOCK) {
    const n = Math.min(BLOCK, l.length - i);
    fx.processStereo(l.subarray(i, i + n), r.subarray(i, i + n), n);
  }
  return { l, r };
}

/** Pearson correlation over a window, un-centred — audio is already zero-mean
 *  and centring a reverb tail would only add noise. 1 means the two channels
 *  are the same signal; 0 means they share nothing. */
function correlation(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let sa = 0, sb = 0, sab = 0;
  for (let i = from; i < to; i++) {
    const x = a[i] as number, y = b[i] as number;
    sa += x * x; sb += y * y; sab += x * y;
  }
  const d = Math.sqrt(sa * sb);
  return d > 0 ? sab / d : 0;
}

function energy(a: Float32Array, from: number, to: number): number {
  let e = 0;
  for (let i = from; i < to; i++) { const x = a[i] as number; e += x * x; }
  return e;
}

/**
 * How much energy survives folding to mono, normalised so the answer reads as a
 * ratio rather than a level:
 *
 *   2.0  the two channels are identical (nothing was widened)
 *   1.0  the two channels are uncorrelated (an honest widener)
 *   0.0  the two channels are inverted copies (a broken one)
 *
 * Phones, club rigs and Bluetooth speakers all sum, so anything materially
 * under 1.0 means the effect disappears for a large share of listeners.
 */
function monoSumRatio(s: Stereo, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) {
    const m = (s.l[i] as number) + (s.r[i] as number);
    sum += m * m;
  }
  const parts = energy(s.l, from, to) + energy(s.r, from, to);
  return parts > 0 ? sum / parts : 0;
}

function impulse(n: number): Float32Array {
  const b = new Float32Array(n);
  b[0] = 1;
  return b;
}

function noise(n: number, seed: number): Float32Array {
  let a = seed >>> 0;
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    b[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 0.6 - 0.3;
  }
  return b;
}

function bigReverb(fx: FxChain): void {
  neutral(fx);
  set(fx, 'reverb-mix', 1);
  set(fx, 'reverb-predelay', 0);
  set(fx, 'reverb-size', 0.8);
  set(fx, 'reverb-decay', 6000);
  set(fx, 'reverb-damping', 0.3);
  fx.reset();
}

/**
 * size, decay ms, damping, and the correlation this setting must stay under —
 * the corners of the reverb's range, so the width claim is not resting on one
 * flattering preset, and each corner is held to what it can actually achieve
 * rather than to one slack number that proves nothing about the good cases.
 *
 * A mono chain scores exactly 1.0. Good concert halls measure an interaural
 * cross-correlation of roughly 0.2-0.4, so most of these are comfortably inside
 * "enveloping". Full damping is the exception and unavoidably so: the coefficient
 * drops to 0.015, every line is lowpassed towards the same narrow band, and the
 * two channels converge — which is also what a heavily furnished real room does
 * to a real tail.
 */
const SETTINGS: readonly [string, number, number, number, number][] = [
  ['big', 0.8, 6000, 0.3, 0.15],
  ['small', 0.2, 600, 0.7, 0.3],
  ['hall', 1.0, 12000, 0.5, 0.15],
  ['dark', 0.55, 2200, 1.0, 0.6],
  ['bright', 0.55, 2200, 0.0, 0.15],
];

describe('reverb width', () => {
  it('produces two decorrelated channels from one tank', () => {
    const from = Math.round(SR * 0.1), to = SR * 2;
    for (const [name, size, decay, damp, ceiling] of SETTINGS) {
      const fx = new FxChain(SR);
      neutral(fx);
      set(fx, 'reverb-mix', 1);
      set(fx, 'reverb-predelay', 0);
      set(fx, 'reverb-size', size);
      set(fx, 'reverb-decay', decay);
      set(fx, 'reverb-damping', damp);
      fx.reset();
      // Skip the first 100ms: the dry impulse and the earliest diffusion are
      // common to both channels by construction and say nothing about the tail.
      const out = renderStereo(fx, impulse(SR * 2));
      const c = correlation(out.l, out.r, from, to);
      console.log(`  reverb L/R correlation, ${name}: ${c.toFixed(3)}`);

      expect(energy(out.l, from, to), `${name} produced no tail`).toBeGreaterThan(1e-6);
      expect(Math.abs(c), `${name} channels are too alike`).toBeLessThan(ceiling);
    }
  });

  it('keeps the early reflections centred', () => {
    const fx = new FxChain(SR);
    bigReverb(fx);
    const out = renderStereo(fx, impulse(SR));
    /*
     * First 50 ms, with the dry impulse at sample 0 excluded — it is identical
     * on both channels and would flatter any imbalance into invisibility.
     *
     * This is the assertion that rules out the obvious tap split. Sending lines
     * 0-3 one way and 4-7 the other puts every SHORT delay line on one side, and
     * this figure measured 6.97 dB on a large room and 13.57 dB on a hall: the
     * attack arrives off centre, which reads as a mispanned instrument rather
     * than as width. The alternating split stays inside 1.24 dB everywhere.
     */
    const to = Math.round(SR * 0.05);
    const db = 10 * Math.log10(energy(out.l, 1, to) / energy(out.r, 1, to));
    console.log(`  early reflection balance ${db.toFixed(2)} dB`);
    expect(Math.abs(db)).toBeLessThan(1.5);
  });

  it('survives a mono fold instead of cancelling', () => {
    const fx = new FxChain(SR);
    bigReverb(fx);
    const out = renderStereo(fx, impulse(SR * 2));
    const from = Math.round(SR * 0.1), to = SR * 2;
    const ratio = monoSumRatio(out, from, to);
    console.log(`  reverb mono-sum ratio ${ratio.toFixed(3)} (1.0 = uncorrelated, 0 = cancels)`);

    /*
     * Left + right is 2·(sum of taps) by construction, whatever the spread
     * factor does to the individual channels, so the fold cannot subtract
     * anything. Uncorrelated content scores exactly 1.0 and identical channels
     * score 2.0; 0.9 allows for the residual common-mode content near the onset
     * without allowing anything that actually cancels.
     */
    expect(ratio).toBeGreaterThan(0.9);
  });

  it('does not change the per-channel level the mono chain produced', () => {
    const mono = new FxChain(SR); bigReverb(mono);
    const stereo = new FxChain(SR); bigReverb(stereo);
    const from = Math.round(SR * 0.1), to = SR * 2;

    const m = renderMono(mono, impulse(SR * 2));
    const s = renderStereo(stereo, impulse(SR * 2));

    const eMono = energy(m, from, to);
    const eSide = (energy(s.l, from, to) + energy(s.r, from, to)) * 0.5;
    const db = 10 * Math.log10(eSide / eMono);
    console.log(`  stereo per-channel tail vs mono tail: ${db.toFixed(2)} dB`);

    /*
     * Widening a reverb must not quietly turn it down or up. Each side is
     * normalised back to the mono level, so this is a level match rather than a
     * power match. The √2 that does it assumes the taps are uncorrelated, and
     * they are not quite, so the match is good to about 1.3 dB across the range
     * rather than exact.
     */
    expect(Math.abs(db)).toBeLessThan(1.5);
  });

  it('leaves the mono entry point mono', () => {
    const fx = new FxChain(SR);
    bigReverb(fx);
    const out = renderMono(fx, impulse(SR));
    // The mono path is still the reference: one buffer in, one buffer out, no
    // second channel anywhere in it, and a tail that decays and stays finite.
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i] as number)).toBe(true);
    const early = energy(out, Math.round(SR * 0.1), Math.round(SR * 0.3));
    const late = energy(out, Math.round(SR * 0.7), Math.round(SR * 0.9));
    expect(early).toBeGreaterThan(0);
    expect(late).toBeLessThan(early);
  });
});

describe('chorus width', () => {
  const run = (w: number): Stereo => {
    const fx = new FxChain(SR);
    neutral(fx);
    set(fx, 'chorus-mix', 1);
    set(fx, 'chorus-depth', 0.8);
    set(fx, 'chorus-rate', 1.2);
    set(fx, 'chorus-width', w);
    fx.reset();
    return renderStereo(fx, noise(SR, 7));
  };

  it('collapses to a single channel at width 0', () => {
    const out = run(0);
    let worst = 0;
    for (let i = 0; i < out.l.length; i++) {
      worst = Math.max(worst, Math.abs((out.l[i] as number) - (out.r[i] as number)));
    }
    // Both sides read the same delays at width 0, so this is exact, not close.
    expect(worst).toBe(0);
  });

  it('drives the channels apart at width 1', () => {
    const from = Math.round(SR * 0.1), to = SR;
    const wide = run(1);
    const c = correlation(wide.l, wide.r, from, to);
    console.log(`  chorus L/R correlation at width 1: ${c.toFixed(3)}`);
    expect(c).toBeLessThan(0.95);
    expect(monoSumRatio(wide, from, to)).toBeGreaterThan(1.2);
  });
});

describe('delay width', () => {
  const run = (w: number): Stereo => {
    const fx = new FxChain(SR);
    neutral(fx);
    set(fx, 'delay-mix', 1);
    set(fx, 'delay-feedback', 0.6);
    set(fx, 'delay-tone', 16000);
    set(fx, 'delay-time', 120);
    set(fx, 'delay-width', w);
    fx.reset();
    return renderStereo(fx, noise(SR, 11));
  };

  it('collapses to a single channel at width 0', () => {
    const out = run(0);
    let worst = 0;
    for (let i = 0; i < out.l.length; i++) {
      worst = Math.max(worst, Math.abs((out.l[i] as number) - (out.r[i] as number)));
    }
    // Both lines take the same input and the same feedback, so they stay
    // sample-identical for as long as the chain runs.
    expect(worst).toBe(0);
  });

  it('drives the channels apart at width 1', () => {
    const from = Math.round(SR * 0.3), to = SR;
    const wide = run(1);
    const c = correlation(wide.l, wide.r, from, to);
    console.log(`  delay L/R correlation at width 1: ${c.toFixed(3)}`);
    expect(c).toBeLessThan(0.8);
    expect(monoSumRatio(wide, from, to)).toBeGreaterThan(0.9);
  });

  it('bounces successive repeats between the sides', () => {
    const fx = new FxChain(SR);
    neutral(fx);
    set(fx, 'delay-mix', 1);
    set(fx, 'delay-feedback', 0.7);
    set(fx, 'delay-tone', 16000);
    set(fx, 'delay-time', 100);
    set(fx, 'delay-width', 1);
    fx.reset();

    const step = Math.round(0.1 * SR);
    const out = renderStereo(fx, impulse(step * 5));

    // Peak on each side inside a window around each repeat.
    const peak = (a: Float32Array, at: number): number => {
      let p = 0;
      for (let i = at - 64; i < at + 64; i++) p = Math.max(p, Math.abs(a[i] as number));
      return p;
    };
    const sides: string[] = [];
    for (let k = 1; k <= 4; k++) {
      const pl = peak(out.l, step * k), pr = peak(out.r, step * k);
      sides.push(`${k}:${pl > pr ? 'L' : 'R'} (${pl.toFixed(3)}/${pr.toFixed(3)})`);
      const loud = Math.max(pl, pr), quiet = Math.min(pl, pr);
      expect(loud, `repeat ${k} is missing`).toBeGreaterThan(0.02);
      // A real ping-pong puts each repeat on ONE side. Ten to one is not a pan,
      // it is a hard alternation.
      expect(quiet, `repeat ${k} leaked across`).toBeLessThan(loud * 0.1);
    }
    console.log(`  ping-pong repeats ${sides.join('  ')}`);
    // Odd repeats on one side, even on the other.
    const first = peak(out.l, step) > peak(out.r, step);
    expect(peak(out.l, step * 2) > peak(out.r, step * 2)).toBe(!first);
    expect(peak(out.l, step * 3) > peak(out.r, step * 3)).toBe(first);
    expect(peak(out.l, step * 4) > peak(out.r, step * 4)).toBe(!first);
  });
});

describe('magic chain width', () => {
  it('widens the vowel filter without losing it in a mono fold', () => {
    const magic = new MagicChain(SR);
    magic.setParam(MP.vowelMix, 1);
    magic.setParam(MP.vowelPos, 0.25);
    magic.setParam(MP.vowelSharp, 0.7);
    const out = renderStereo(magic, noise(SR, 23));
    const from = Math.round(SR * 0.1), to = SR;
    const c = correlation(out.l, out.r, from, to);
    const ratio = monoSumRatio(out, from, to);
    console.log(`  vowel L/R correlation ${c.toFixed(3)}, mono-sum ${ratio.toFixed(3)}`);
    expect(c).toBeLessThan(0.95);
    // Mirror-image formant weightings: the fold reproduces the mono response
    // exactly, so this stays well above the uncorrelated 1.0.
    expect(ratio).toBeGreaterThan(1.2);
  });

  it('widens the shimmer tail', () => {
    const magic = new MagicChain(SR);
    magic.setParam(MP.shimmerMix, 1);
    magic.setParam(MP.shimmerFeedback, 0.7);
    magic.setParam(MP.shimmerSize, 220);
    const out = renderStereo(magic, impulse(SR * 2));
    const from = Math.round(SR * 0.3), to = SR * 2;
    const c = correlation(out.l, out.r, from, to);
    const ratio = monoSumRatio(out, from, to);
    const eL = energy(out.l, from, to), eR = energy(out.r, from, to);
    console.log(
      `  shimmer L/R correlation ${c.toFixed(3)}, mono-sum ${ratio.toFixed(3)}, ` +
      `balance ${(10 * Math.log10(eL / eR)).toFixed(2)} dB`,
    );
    expect(eL).toBeGreaterThan(1e-6);
    // Both taps must actually carry the tail. A decorrelation of exactly zero
    // would otherwise be satisfied by a silent right channel.
    expect(Math.abs(10 * Math.log10(eL / eR)), 'shimmer tail is lopsided').toBeLessThan(3);
    expect(Math.abs(c)).toBeLessThan(0.6);
    expect(ratio).toBeGreaterThan(0.9);
  });

  it('passes a stereo image through the mono-only units untouched', () => {
    // Stutter, freeze, shifter and tape run on the mid. They must let the side
    // through rather than collapsing whatever the vowel filter built upstream.
    const magic = new MagicChain(SR);
    magic.setParam(MP.vowelMix, 1);
    magic.setParam(MP.vowelPos, 0.25);
    magic.setParam(MP.tapeWear, 0.5);
    magic.setParam(MP.tapeWow, 0.4);
    magic.setParam(MP.stutterMix, 1);
    magic.setParam(MP.stutterChance, 0.8);
    const out = renderStereo(magic, noise(SR, 31));
    const from = Math.round(SR * 0.2), to = SR;
    const c = correlation(out.l, out.r, from, to);
    console.log(`  vowel through mono-only units: correlation ${c.toFixed(3)}`);
    expect(c).toBeLessThan(0.99);
    for (let i = 0; i < out.l.length; i++) {
      expect(Number.isFinite(out.l[i] as number)).toBe(true);
      expect(Number.isFinite(out.r[i] as number)).toBe(true);
    }
  });
});

describe('stereo allocation', () => {
  it('does not grow the heap across a sustained stereo render', () => {
    // Without a real gc() this would measure framework garbage and mean nothing.
    expect(typeof global.gc, 'run vitest with --expose-gc').toBe('function');
    const fx = new FxChain(SR);
    neutral(fx);
    set(fx, 'chorus-mix', 0.5);
    set(fx, 'delay-mix', 0.5);
    set(fx, 'reverb-mix', 0.5);
    set(fx, 'drive-amount', 0.4);
    fx.reset();
    const magic = new MagicChain(SR);
    magic.setParam(MP.vowelMix, 0.5);
    magic.setParam(MP.shimmerMix, 0.5);
    magic.setParam(MP.tapeWear, 0.3);

    const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
    let ph = 0;
    const fill = (): void => {
      for (let i = 0; i < BLOCK; i++) {
        ph += 220 / SR;
        if (ph >= 1) ph -= 1;
        const s = 0.3 * Math.sin(2 * Math.PI * ph);
        l[i] = s; r[i] = s;
      }
    };
    const pass = (): void => {
      fill();
      fx.processStereo(l, r, BLOCK);
      magic.processStereo(l, r, BLOCK);
    };

    for (let b = 0; b < 500; b++) pass();
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let b = 0; b < 4000; b++) pass();
    global.gc?.();
    const after = process.memoryUsage().heapUsed;
    expect(after - before).toBeLessThan(64 * 1024);
  });
});

describe('stereo cost', () => {
  it('stays nearly free when everything is bypassed', () => {
    const blocks = Math.floor((SR * 4) / BLOCK);
    const cost = (run: () => void): number => {
      for (let i = 0; i < 400; i++) run();
      let best = Infinity;
      for (let p = 0; p < 3; p++) {
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < blocks; i++) run();
        best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e9);
      }
      return best / 4;
    };

    const fx = new FxChain(SR); neutral(fx);
    const magic = new MagicChain(SR);
    const a = new Float32Array(BLOCK), b = new Float32Array(BLOCK);
    const idleFx = cost(() => { a.fill(0.2); b.fill(0.2); fx.processStereo(a, b, BLOCK); });
    const idleMagic = cost(() => { a.fill(0.2); b.fill(0.2); magic.processStereo(a, b, BLOCK); });

    const vm = new VoiceManager(AnalogEngine, SR, 8);
    for (let n = 55; n < 63; n++) vm.noteOn(n, 1);
    const out = new Float32Array(BLOCK);
    const synth = cost(() => { out.fill(0); vm.render(out, BLOCK); });

    console.log(
      `  idle stereo FxChain ${(idleFx * 100).toFixed(2)}%, MagicChain ` +
      `${(idleMagic * 100).toFixed(2)}%, vs 8-voice synth ${(synth * 100).toFixed(2)}%`,
    );
    /*
     * Same bar the mono bypass tests hold: the gating works off the mix values,
     * not off which entry point was called, so going stereo must not have
     * reintroduced the cost that work removed. Only the always-on front of the
     * FxChain — drive, bitcrush, trim, limiter — pays for the second channel.
     */
    expect(idleFx).toBeLessThan(synth * 0.5);
    expect(idleMagic).toBeLessThan(synth * 0.5);
  });


  it('costs meaningfully less than twice the mono chain', () => {
    const blocks = Math.floor((SR * 4) / BLOCK);
    const cost = (run: () => void): number => {
      for (let i = 0; i < 400; i++) run();
      let best = Infinity;
      for (let p = 0; p < 3; p++) {
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < blocks; i++) run();
        best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e9);
      }
      return best / 4;
    };

    const busy = (fx: FxChain): void => {
      neutral(fx);
      set(fx, 'chorus-mix', 0.5); set(fx, 'delay-mix', 0.5); set(fx, 'reverb-mix', 0.5);
      fx.reset();
    };
    const mFx = new FxChain(SR); busy(mFx);
    const sFx = new FxChain(SR); busy(sFx);
    const a = new Float32Array(BLOCK), b = new Float32Array(BLOCK);

    const mono = cost(() => { a.fill(0.2); mFx.process(a, BLOCK); });
    const stereo = cost(() => { a.fill(0.2); b.fill(0.2); sFx.processStereo(a, b, BLOCK); });
    console.log(
      `  FxChain mono ${(mono * 100).toFixed(2)}% vs stereo ${(stereo * 100).toFixed(2)}% ` +
      `of a core (${(stereo / mono).toFixed(2)}x)`,
    );
    // The whole premise of widening in the effects rather than the oscillators
    // is that the second channel is nearly free. Two independent chains would
    // be 2.0x; anything near that means the shared tanks are not being shared.
    expect(stereo / mono).toBeLessThan(1.6);
  });
});
