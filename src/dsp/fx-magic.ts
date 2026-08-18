import { Smoother } from '@/dsp/smoothing';
import { StateVariableFilter } from '@/dsp/filters';
import {
  DelayLine, Diffuser, FreqShifter, PitchShifter, Tape, blend, copyTail,
  FORMANT_LOG, FX_MAGIC_DESCRIPTOR, MAGIC_PARAM as P,
  flush, saturate, softLimit,
} from '@/dsp/fx-magic-descriptor';

/**
 * SIGIL — the character effects. The conventional chain makes a sound sit
 * properly in a mix; this one makes a listener stop and ask what that was.
 * Zero allocation inside `process`, denormal-guarded on every recursive path,
 * and bounded by construction: nothing can push the output past ±1.2.
 */
export interface MagicFx {
  setParam(index: number, value: number): void;
  /** In place, zero allocation. */
  process(buffer: Float32Array, count: number): void;
  reset(): void;
}

/**
 * FREEZE. Captures the last N ms and loops it forever while you keep playing
 * over the top — a sound suspended in mid-air. The loop point is a raised
 * cosine splice a quarter of the buffer long, so the join is continuous in
 * value and in slope, and the read pointer is an integer, so it cannot drift.
 */
class Freezer {
  private readonly ring: Float32Array; private readonly loop: Float32Array;
  private readonly max: number; private readonly gain: Smoother;
  private w = 0; private len = 0; private xf = 1; private p = 0; private held = false;
  constructor(sr: number) {
    this.max = Math.round(sr * 2);
    this.ring = new Float32Array(this.max);
    this.loop = new Float32Array(this.max);
    this.gain = new Smoother(sr, 15);
  }
  release(): void { this.held = false; }
  reset(): void {
    this.ring.fill(0); this.loop.fill(0); this.gain.snap(0);
    this.w = 0; this.len = 0; this.p = 0; this.held = false;
  }
  capture(lenSamples: number): void {
    const L = Math.max(128, Math.min(this.max, Math.round(lenSamples)));
    copyTail(this.ring, this.w, this.loop, L);
    // Crossfade scales with the capture: long holds get a long, invisible
    // splice; short ones stay short enough not to smear into mush.
    this.xf = Math.max(1, Math.floor(L * 0.25));
    this.len = L - this.xf;
    this.p = 0;
    this.held = true;
  }
  process(x: number): number {
    this.ring[this.w] = x;
    this.w++; if (this.w >= this.max) this.w = 0;
    this.gain.setTarget(this.held ? 1 : 0);
    const g = this.gain.next();
    if (g === 0 || this.len <= 0) return 0;
    const p = this.p;
    let y = this.loop[p] as number;
    if (p < this.xf) {
      const t = 0.5 - 0.5 * Math.cos((Math.PI * p) / this.xf);
      y = y * t + (this.loop[p + this.len] as number) * (1 - t);
    }
    this.p = p + 1 >= this.len ? 0 : p + 1;
    return y * g;
  }
}

/**
 * SHIMMER. A diffused delay tank with a pitch shifter inside the feedback path,
 * so every pass arrives an octave above the last and the tail blooms upward
 * into a cathedral. Feedback is clamped below unity and the loop soft-saturated,
 * so it always decays however hard you push it.
 */
class Shimmer {
  private readonly line: DelayLine; private readonly shifter: PitchShifter;
  private readonly d1: Diffuser; private readonly d2: Diffuser;
  private z = 0;
  constructor(sr: number) {
    this.line = new DelayLine(Math.round(sr * 0.55));
    this.shifter = new PitchShifter(sr, 60);
    this.d1 = new Diffuser(sr * 0.00723, 0.62);
    this.d2 = new Diffuser(sr * 0.01043, 0.55);
  }
  reset(): void {
    this.line.reset(); this.shifter.reset(); this.d1.reset(); this.d2.reset(); this.z = 0;
  }
  process(x: number, delay: number, fb: number, ratio: number, damp: number): number {
    const tail = this.line.read(delay);
    this.z = flush(this.z + (1 - damp * 0.92) * (tail - this.z));
    let w = this.d2.process(this.d1.process(x + saturate(this.shifter.process(this.z, ratio) * fb)));
    if (w > 4) w = 4; else if (w < -4) w = -4;
    this.line.write(flush(w));
    return tail;
  }
}

/**
 * VOWEL. Three resonant bandpasses parked on real formant centres, morphing
 * continuously through A-E-I-O-U. Coefficients only move when the morph moves,
 * which keeps three tan() calls out of most samples.
 */
class VowelFilter {
  private readonly f: StateVariableFilter[] = [];
  private lastPos = -1; private lastSharp = -1;
  constructor(sr: number) {
    for (let k = 0; k < 3; k++) {
      const s = new StateVariableFilter(sr);
      s.setMode('bp');
      this.f.push(s);
    }
  }
  reset(): void {
    for (let k = 0; k < 3; k++) (this.f[k] as StateVariableFilter).reset();
    this.lastPos = -1; this.lastSharp = -1;
  }
  process(x: number, pos: number, sharp: number): number {
    if (Math.abs(pos - this.lastPos) > 0.002 || Math.abs(sharp - this.lastSharp) > 0.005) {
      this.lastPos = pos; this.lastSharp = sharp;
      const t = (pos < 0 ? 0 : pos > 1 ? 1 : pos) * 4;
      let i = Math.floor(t); if (i > 3) i = 3;
      const frac = t - i;
      const a = i * 3;
      for (let k = 0; k < 3; k++) {
        const lo = FORMANT_LOG[a + k] as number;
        const hi = FORMANT_LOG[a + 3 + k] as number;
        const flt = this.f[k] as StateVariableFilter;
        flt.setCutoff(Math.exp(lo + (hi - lo) * frac));
        flt.setResonance(0.55 + 0.42 * sharp);
      }
    }
    const b0 = (this.f[0] as StateVariableFilter).process(x);
    const b1 = (this.f[1] as StateVariableFilter).process(x);
    const b2 = (this.f[2] as StateVariableFilter).process(x);
    return (b0 + b1 * 0.55 + b2 * 0.3) * 0.45;
  }
}

/**
 * STUTTER. Catches a slice and repeats it. Whether it catches is a coin toss
 * from a seeded PRNG — never Math.random(), so a take is reproducible and a
 * test can assert on it — which is the difference between an effect that
 * glitches and one that merely chops on the grid.
 */
class Stutter {
  private readonly ring: Float32Array; private readonly slice: Float32Array;
  private readonly max: number; private readonly fade: number;
  private w = 0; private counter = 0; private active = false;
  private phase = 0; private rate = 1; private repeats = 0; private len = 0;
  private s = 1337 >>> 0;
  constructor(sr: number) {
    this.max = Math.round(sr * 0.5);
    this.ring = new Float32Array(this.max);
    this.slice = new Float32Array(this.max);
    this.fade = Math.max(4, Math.round(sr * 0.002));
  }
  setSeed(seed: number): void {
    this.s = (Math.round(seed) >>> 0) || 1;
    this.active = false; this.counter = 0;
  }
  reset(): void {
    this.ring.fill(0); this.slice.fill(0);
    this.w = 0; this.counter = 0; this.active = false; this.phase = 0; this.rate = 1;
  }
  /** mulberry32: small, fast, seeded, identical every run. */
  private rand(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  private latch(n: number): void {
    const L = Math.max(32, Math.min(this.max, Math.round(n)));
    copyTail(this.ring, this.w, this.slice, L);
    this.len = L; this.phase = 0; this.rate = 1;
    this.repeats = 2 + Math.floor(this.rand() * 4);
    this.active = true;
  }
  process(x: number, sliceSamples: number, chance: number, pitchRatio: number): number {
    this.ring[this.w] = x;
    this.w++; if (this.w >= this.max) this.w = 0;
    if (!this.active) {
      this.counter++;
      if (this.counter >= sliceSamples) {
        this.counter = 0;
        if (this.rand() < chance) this.latch(sliceSamples);
      }
      if (!this.active) return x;
    }
    const n = this.len;
    let ph = this.phase;
    const i0 = Math.floor(ph);
    const a = this.slice[i0 % n] as number;
    const b = this.slice[(i0 + 1) % n] as number;
    let y = a + (b - a) * (ph - i0);
    const fd = this.fade;
    if (ph < fd) y *= ph / fd; else if (ph > n - fd) y *= (n - ph) / fd;
    ph += this.rate;
    if (ph >= n) {
      ph -= n;
      this.repeats--;
      this.rate *= pitchRatio;
      if (this.rate < 0.25) this.rate = 0.25; else if (this.rate > 4) this.rate = 4;
      if (this.repeats <= 0) { this.active = false; this.counter = 0; }
    }
    this.phase = ph;
    return y;
  }
}

/** The six character effects in series, every parameter smoothed. */
/** Below this a mix is inaudible, so the unit is skipped outright. */
const SILENT = 1e-4;

export class MagicChain implements MagicFx {
  /** Smoother targets, so gating opens a unit the instant a mix starts rising
   *  rather than waiting for the smoothed value to clear the threshold. */
  private readonly tgt = new Float32Array(FX_MAGIC_DESCRIPTOR.params.length);
  private wasVowel = false;
  private wasShift = false;
  private wasStutter = false;
  private wasShimmer = false;
  private wasTape = false;

  private readonly sr: number;
  private readonly sm: Smoother[] = [];
  private readonly val: Float32Array;
  private readonly freezer: Freezer; private readonly shimmer: Shimmer;
  private readonly shifter: FreqShifter; private readonly vowel: VowelFilter;
  private readonly stutter: Stutter; private readonly tape: Tape;
  private held = false; private wantCapture = false; private wantRelease = false;
  private freezeLenMs: number;
  constructor(sampleRate: number) {
    this.sr = sampleRate;
    const params = FX_MAGIC_DESCRIPTOR.params;
    this.val = new Float32Array(params.length);
    for (let i = 0; i < params.length; i++) {
      const d = params[i];
      const s = new Smoother(sampleRate, 20);
      s.snap(d ? d.default : 0);
      this.sm.push(s);
      this.val[i] = d ? d.default : 0;
    }
    this.freezeLenMs = this.val[P.freezeLength] as number;
    this.freezer = new Freezer(sampleRate);
    this.shimmer = new Shimmer(sampleRate);
    this.shifter = new FreqShifter(sampleRate);
    this.vowel = new VowelFilter(sampleRate);
    this.stutter = new Stutter(sampleRate);
    this.tape = new Tape(sampleRate);
  }
  setParam(index: number, value: number): void {
    const d = FX_MAGIC_DESCRIPTOR.params[index];
    if (!d) return;
    const v = value < d.min ? d.min : value > d.max ? d.max : value;
    if (index === P.freezeCapture) {
      const on = v >= 0.5;
      if (on && !this.held) this.wantCapture = true;
      else if (!on && this.held) this.wantRelease = true;
      this.held = on;
      return;
    }
    if (index === P.stutterSeed) { this.stutter.setSeed(v); return; }
    if (index === P.freezeLength) this.freezeLenMs = v;
    (this.sm[index] as Smoother).setTarget(v);
    this.tgt[index] = v;
  }
  reset(): void {
    this.freezer.reset(); this.shimmer.reset(); this.shifter.reset();
    this.vowel.reset(); this.stutter.reset(); this.tape.reset();
    this.held = false; this.wantCapture = false; this.wantRelease = false;
  }
  /**
   * PERFORMANCE: each unit is skipped entirely when its mix is silent.
   *
   * `blend(x, unit.process(...), mix)` reads as a bypass, but JavaScript
   * evaluates arguments eagerly — so the vowel filter, frequency shifter,
   * stutter, shimmer's pitch-shifting feedback delay, freezer and tape model all
   * ran in full and had their output thrown away. Measured: this chain cost
   * 2.49% of a core with every mix at zero, against 3.27% for the entire
   * 16-voice synth. Two chains burned more CPU doing nothing than the instrument
   * spent making sound.
   *
   * Re-enabling a unit resets it. Its delay lines hold audio from before the
   * bypass, and fading that back in would burst stale sound — nothing was
   * audible at mix zero, so there is no continuity worth preserving.
   */
  process(buffer: Float32Array, count: number): void {
    if (this.wantCapture) {
      this.freezer.capture((this.freezeLenMs / 1000) * this.sr);
      this.wantCapture = false;
    }
    if (this.wantRelease) { this.freezer.release(); this.wantRelease = false; }

    const v = this.val;
    const np = v.length;
    const sr = this.sr;

    /*
     * Gate on the TARGET as well as the current value. Hoisting the smoother
     * stepping out of the sample loop made parameter smoothing 128x slower — a
     * knob move would have taken about a third of a second to arrive — so the
     * per-sample stepping stays and the decision looks at where each mix is
     * heading. `live` is true while a unit is on, still ramping up, or ramping
     * down and not yet silent.
     */
    const t = this.tgt;
    const live = (idx: number): boolean =>
      (v[idx] as number) > SILENT || (t[idx] as number) > SILENT;

    const onVowel = live(P.vowelMix);
    const onShift = live(P.shiftMix);
    const onStutter = live(P.stutterMix);
    const onShimmer = live(P.shimmerMix);
    const onFreeze = live(P.freezeMix);
    const onTape = live(P.tapeWear) || live(P.tapeWow) || live(P.tapeFlutter);

    if (onVowel && !this.wasVowel) this.vowel.reset();
    if (onShift && !this.wasShift) this.shifter.reset();
    if (onStutter && !this.wasStutter) this.stutter.reset();
    if (onShimmer && !this.wasShimmer) this.shimmer.reset();
    if (onTape && !this.wasTape) this.tape.reset();
    this.wasVowel = onVowel; this.wasShift = onShift; this.wasStutter = onStutter;
    this.wasShimmer = onShimmer; this.wasTape = onTape;

    /*
     * Fully bypassed. The freezer still needs feeding so a later capture has
     * material, but that is a ring-buffer write per sample rather than the six
     * effects, and the samples pass through untouched.
     */
    if (!onVowel && !onShift && !onStutter && !onShimmer && !onFreeze && !onTape) {
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < np; k++) v[k] = (this.sm[k] as Smoother).next();
        this.freezer.process(buffer[i] as number);
      }
      return;
    }

    // Transcendentals hoisted to block rate. Two `2 ** x` per SAMPLE violated
    // the project's own hot-loop rule and bought nothing: both derive from
    // smoothed parameters that barely move within a 128-sample block.
    const stutterRatio = 2 ** ((t[P.stutterPitch] as number) / 12);
    const shimmerRatio = 2 ** ((t[P.shimmerPitch] as number) / 12);
    const stutterSlice = ((t[P.stutterSlice] as number) / 1000) * sr;
    const shimmerSize = ((t[P.shimmerSize] as number) / 1000) * sr;
    const shimmerFb = (t[P.shimmerFeedback] as number) * 0.85;

    for (let i = 0; i < count; i++) {
      for (let k = 0; k < np; k++) v[k] = (this.sm[k] as Smoother).next();
      let x = buffer[i] as number;

      if (onVowel) {
        x = blend(x, this.vowel.process(x, v[P.vowelPos] as number, v[P.vowelSharp] as number),
          v[P.vowelMix] as number);
      }
      if (onShift) {
        x = blend(x, this.shifter.process(x, v[P.shiftHz] as number, v[P.shiftRing] as number),
          v[P.shiftMix] as number);
      }
      if (onStutter) {
        x = blend(x, this.stutter.process(x, stutterSlice,
          v[P.stutterChance] as number, stutterRatio), v[P.stutterMix] as number);
      }
      if (onShimmer) {
        x = blend(x, this.shimmer.process(x, shimmerSize, shimmerFb, shimmerRatio,
          v[P.shimmerDamp] as number), v[P.shimmerMix] as number);
      }
      /*
       * The freezer ALWAYS runs, even at mix zero. It is a recorder as well as a
       * player: skipping it would leave nothing in the buffer to capture, so
       * pressing capture and then raising the mix would freeze silence. Only the
       * blend is conditional.
       */
      const frozen = this.freezer.process(x);
      if (onFreeze) {
        // The frozen layer sits under the live signal rather than replacing it —
        // the whole point is playing against a sound nobody is holding any more.
        const fm = v[P.freezeMix] as number;
        x = x * (1 - 0.5 * fm) + frozen * fm;
      }
      if (onTape) {
        x = this.tape.process(x, v[P.tapeWear] as number, v[P.tapeWow] as number,
          v[P.tapeFlutter] as number);
      }

      if (!(x > -1e9 && x < 1e9)) { this.reset(); x = 0; }
      const y = softLimit(x, 0.9, 0.6);
      buffer[i] = y > 1.2 ? 1.2 : y < -1.2 ? -1.2 : y;
    }
  }
}
