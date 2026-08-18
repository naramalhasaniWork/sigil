import { Smoother } from '@/dsp/smoothing';
import { StateVariableFilter } from '@/dsp/filters';
import {
  DelayLine, Diffuser, PitchShifter, copyTail, FORMANT_LOG, flush, saturate,
} from '@/dsp/fx-magic-descriptor';

/**
 * The character effects themselves. Split out of fx-magic.ts so that file and
 * this one both stay under the 300-line ceiling once the stereo taps landed.
 *
 * Zero allocation inside every `process`, denormals flushed on every recursive
 * path. Units that widen expose `oL` / `oR` as plain number fields rather than
 * returning a pair, because returning a pair means allocating one.
 */

/**
 * FREEZE. Captures the last N ms and loops it forever while you keep playing
 * over the top — a sound suspended in mid-air. The loop point is a raised
 * cosine splice a quarter of the buffer long, so the join is continuous in
 * value and in slope, and the read pointer is an integer, so it cannot drift.
 *
 * MONO ONLY. A frozen loop is one recording of one moment; there is no second
 * channel to capture and no honest way to invent one. In stereo it runs on the
 * mid and the side goes round it untouched.
 */
export class Freezer {
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

/** How far the right-hand tail tap sits from the left one, as a fraction of the
 *  tank length. Deliberately not a simple ratio: 0.79 keeps the two taps from
 *  ever landing on the same circulating grain. */
const SHIM_TAP_R = 0.79;

/**
 * SHIMMER. A diffused delay tank with a pitch shifter inside the feedback path,
 * so every pass arrives an octave above the last and the tail blooms upward
 * into a cathedral. Feedback is clamped below unity and the loop soft-saturated,
 * so it always decays however hard you push it.
 */
export class Shimmer {
  private readonly line: DelayLine; private readonly shifter: PitchShifter;
  private readonly d1: Diffuser; private readonly d2: Diffuser;
  private z = 0;
  oL = 0; oR = 0;
  constructor(sr: number) {
    this.line = new DelayLine(Math.round(sr * 0.55));
    this.shifter = new PitchShifter(sr, 60);
    this.d1 = new Diffuser(sr * 0.00723, 0.62);
    this.d2 = new Diffuser(sr * 0.01043, 0.55);
  }
  reset(): void {
    this.line.reset(); this.shifter.reset(); this.d1.reset(); this.d2.reset(); this.z = 0;
    this.oL = 0; this.oR = 0;
  }
  /** Advances the tank by one sample and returns the left tail. The tank is the
   *  expensive part — a pitch shifter and two diffusers — so both entry points
   *  share it and stereo only pays for one extra interpolated read. */
  private tank(x: number, delay: number, fb: number, ratio: number, damp: number): number {
    const tail = this.line.read(delay);
    this.z = flush(this.z + (1 - damp * 0.92) * (tail - this.z));
    let w = this.d2.process(this.d1.process(x + saturate(this.shifter.process(this.z, ratio) * fb)));
    if (w > 4) w = 4; else if (w < -4) w = -4;
    this.line.write(flush(w));
    return tail;
  }
  process(x: number, delay: number, fb: number, ratio: number, damp: number): number {
    return this.tank(x, delay, fb, ratio, damp);
  }
  /**
   * Two taps off one tank at unrelated distances. The rising octaves reach the
   * two ears at genuinely different points in their climb, which is the whole
   * illusion, and it costs one delay-line read rather than a second shifter.
   * Feedback stays on the left tap so the tank behaves exactly as it does in
   * mono; only the extra output tap is new.
   */
  processStereo(l: number, r: number, delay: number, fb: number, ratio: number, damp: number): void {
    this.oR = this.line.read(delay * SHIM_TAP_R);
    this.oL = this.tank((l + r) * 0.5, delay, fb, ratio, damp);
  }
}

/**
 * How far the two channels pull the formant balance apart. The first formant
 * leans one way and the third the other, by equal and opposite amounts, so the
 * average of the two channels is the mono response to the last decimal whatever
 * this number is — it trades width against how differently the two ears are
 * voiced, and nothing else. Measured on noise: 0.6 gives an L/R correlation of
 * 0.73, 0.75 gives 0.60, 0.9 gives 0.48. Past about 0.75 the left channel is
 * almost pure F1 and the right almost pure F2 plus F3, which is wide but starts
 * to sound like two different filters rather than one wide mouth.
 */
const VOWEL_SPREAD = 0.75;

/**
 * VOWEL. Three resonant bandpasses parked on real formant centres, morphing
 * continuously through A-E-I-O-U. Coefficients only move when the morph moves,
 * which keeps three tan() calls out of most samples.
 */
export class VowelFilter {
  private readonly f: StateVariableFilter[] = [];
  private lastPos = -1; private lastSharp = -1;
  private b0 = 0; private b1 = 0; private b2 = 0;
  oL = 0; oR = 0;
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
    this.b0 = 0; this.b1 = 0; this.b2 = 0; this.oL = 0; this.oR = 0;
  }
  private bands(x: number, pos: number, sharp: number): void {
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
    this.b0 = (this.f[0] as StateVariableFilter).process(x);
    this.b1 = (this.f[1] as StateVariableFilter).process(x);
    this.b2 = (this.f[2] as StateVariableFilter).process(x);
  }
  process(x: number, pos: number, sharp: number): number {
    this.bands(x, pos, sharp);
    return (this.b0 + this.b1 * 0.55 + this.b2 * 0.3) * 0.45;
  }
  /**
   * A second mix vector over the same three bandpasses. The low formant sits to
   * one side and the high formant to the other — a mouth with width — and
   * because the two weightings are mirror images about the mono one, (L+R)/2
   * reproduces `process` exactly. Nothing can cancel in a mono fold, because
   * every term is added on both sides, only in different proportions.
   */
  processStereo(x: number, pos: number, sharp: number): void {
    this.bands(x, pos, sharp);
    const lo = this.b0, mid = this.b1 * 0.55, hi = this.b2 * 0.3;
    this.oL = (lo * (1 + VOWEL_SPREAD) + mid + hi * (1 - VOWEL_SPREAD)) * 0.45;
    this.oR = (lo * (1 - VOWEL_SPREAD) + mid + hi * (1 + VOWEL_SPREAD)) * 0.45;
  }
}

/**
 * STUTTER. Catches a slice and repeats it. Whether it catches is a coin toss
 * from a seeded PRNG — never Math.random(), so a take is reproducible and a
 * test can assert on it — which is the difference between an effect that
 * glitches and one that merely chops on the grid.
 *
 * MONO ONLY. It plays back one captured slice; a second channel would need a
 * second capture, which is a second effect, not a wider one. In stereo it runs
 * on the mid with the side passed around it.
 */
export class Stutter {
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
