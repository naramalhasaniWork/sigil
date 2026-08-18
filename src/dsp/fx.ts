import { Smoother } from '@/dsp/smoothing';
import {
  Line, def, flush, lfo, onePole, sat,
  N_PARAMS, P_DRIVE, P_DRIVE_TONE, P_CRUSH_RATE, P_CRUSH_BITS,
  P_CH_RATE, P_CH_DEPTH, P_CH_WIDTH, P_CH_MIX,
  P_DL_TIME, P_DL_FB, P_DL_TONE, P_DL_WIDTH, P_DL_MIX,
  P_RV_PREDELAY, P_RV_SIZE, P_RV_DECAY, P_RV_DAMP, P_RV_MIX, P_TRIM,
  limitOut,
} from './fx-core';
import { Reverb } from './fx-reverb';

export interface FxUnit {
  setParam(index: number, value: number): void;
  /** Rewrites `buffer` in place. Allocates nothing. */
  process(buffer: Float32Array, count: number): void;
  /** Rewrites both channels in place. Allocates nothing. The voices are mono,
   *  so this chain is where the signal becomes stereo. */
  processStereo(left: Float32Array, right: Float32Array, count: number): void;
  reset(): void;
}

/** Per-parameter smoothing. Delay time and reverb size move a read pointer so
 *  they glide; mixes and gains only need de-zippering. */
const SMOOTH_MS = [25, 25, 25, 25, 30, 30, 30, 30, 80, 30, 30, 60, 30, 120, 120, 30, 40, 30, 25];

const CH_MID_MS = 12, CH_SPREAD_MS = 7, CH_DEPTH_MS = 3.5, CH_DRY_CUT = 0.4, CH_WET_G = 0.55;
/** Three taps off one modulated line, each with its own LFO phase and (once
 *  width opens up) its own rate, so the copies never line up and cancel. */
class Chorus {
  private readonly line: Line;
  private readonly phase = new Float32Array(3);
  private readonly mid: number; private readonly spread: number; private readonly depth: number;
  oL = 0; oR = 0;
  constructor(sr: number) {
    this.line = new Line(Math.ceil(sr * 0.05));
    this.mid = (CH_MID_MS * sr) / 1000; this.spread = (CH_SPREAD_MS * sr) / 1000;
    this.depth = (CH_DEPTH_MS * sr) / 1000;
    this.reset();
  }
  reset(): void {
    this.line.clear();
    this.phase[0] = 0; this.phase[1] = 1 / 3; this.phase[2] = 2 / 3;
    this.oL = 0; this.oR = 0;
  }
  process(x: number, p: Float32Array): number {
    const r = p[P_CH_RATE] as number, d = (p[P_CH_DEPTH] as number) * this.depth;
    const w = p[P_CH_WIDTH] as number, m = p[P_CH_MIX] as number;
    let wet = 0;
    for (let i = 0; i < 3; i++) {
      let ph = (this.phase[i] as number) + r * (1 + (i - 1) * 0.28 * w);
      if (ph >= 1) ph -= 1;
      this.phase[i] = ph;
      wet += this.line.read(this.mid + (i - 1) * this.spread * w + d * lfo(ph));
    }
    this.line.write(x);
    return x * (1 - CH_DRY_CUT * m) + wet * (m * CH_WET_G);
  }
  /**
   * Same three taps, read twice: the right channel's modulation runs half a
   * cycle out of phase with the left's, so the two sides pull away from each
   * other in opposite directions instead of wobbling together. Width fades the
   * antiphase in, and at zero the two reads land on identical delays — the
   * channels are then bit-identical, not merely close.
   *
   * No cancellation risk: both sides are delayed copies of the same line with a
   * positive sign, so the mono fold is a comb, never a subtraction.
   */
  processStereo(l: number, r: number, p: Float32Array): void {
    const rate = p[P_CH_RATE] as number, d = (p[P_CH_DEPTH] as number) * this.depth;
    const w = p[P_CH_WIDTH] as number, m = p[P_CH_MIX] as number;
    let wetL = 0, wetR = 0;
    for (let i = 0; i < 3; i++) {
      let ph = (this.phase[i] as number) + rate * (1 + (i - 1) * 0.28 * w);
      if (ph >= 1) ph -= 1;
      this.phase[i] = ph;
      const base = this.mid + (i - 1) * this.spread * w;
      const mod = d * lfo(ph);
      const anti = d * lfo(ph >= 0.5 ? ph - 0.5 : ph + 0.5);
      wetL += this.line.read(base + mod);
      wetR += this.line.read(base + mod + (anti - mod) * w);
    }
    this.line.write((l + r) * 0.5);
    const dry = 1 - CH_DRY_CUT * m, g = m * CH_WET_G;
    this.oL = l * dry + wetL * g;
    this.oR = r * dry + wetR * g;
  }
}

const DL_MAX_S = 2.05;
/** Regeneration ceiling. The two-line cross-feed matrix has spectral radius
 *  exactly this at every width setting, so the delay can never run away. */
const DL_FB_MAX = 0.92, DL_WET_G = 0.7;
class Delay {
  private readonly a: Line; private readonly b: Line;
  private lpA = 0; private lpB = 0;
  oL = 0; oR = 0;
  constructor(sr: number) {
    this.a = new Line(Math.ceil(sr * DL_MAX_S)); this.b = new Line(Math.ceil(sr * DL_MAX_S));
  }
  reset(): void { this.a.clear(); this.b.clear(); this.lpA = 0; this.lpB = 0; this.oL = 0; this.oR = 0; }
  process(x: number, p: Float32Array): number {
    const t = p[P_DL_TIME] as number, f = p[P_DL_FB] as number;
    const c = p[P_DL_TONE] as number, w = p[P_DL_WIDTH] as number;
    const ra = this.a.read(t);
    // A mono sum of a true ping-pong is indistinguishable from a plain delay,
    // so width offsets the second line: repeats bounce in time, not in space.
    const rb = this.b.read(t * (1 - 0.5 * w));
    this.lpA = flush(this.lpA + c * (ra - this.lpA));
    this.lpB = flush(this.lpB + c * (rb - this.lpB));
    this.a.write(flush(x + f * (w * this.lpB + (1 - w) * this.lpA)));
    this.b.write(flush(f * (w * this.lpA + (1 - w) * this.lpB)));
    return x + (p[P_DL_MIX] as number) * DL_WET_G * (ra + rb);
  }
  /**
   * Real ping-pong. Both lines run at the same time now — the mono version's
   * time offset only existed because bouncing in space is invisible in one
   * channel. Line A goes to the left, line B to the right, and width steers two
   * things at once: how much dry lands in B, and how much of each line's
   * feedback comes from the other. At width 0 the two lines are fed identically
   * and stay sample-identical, so the delay collapses to plain mono; at 1, A is
   * the only line taking input and hands every repeat across to B and back.
   *
   * Stable at every setting: the feedback matrix f·[[1−w, w], [w, 1−w]] has
   * eigenvalues f and f(1−2w), so its spectral radius is f regardless of width.
   */
  processStereo(l: number, r: number, p: Float32Array): void {
    const t = p[P_DL_TIME] as number, f = p[P_DL_FB] as number;
    const c = p[P_DL_TONE] as number, w = p[P_DL_WIDTH] as number;
    const ra = this.a.read(t), rb = this.b.read(t);
    this.lpA = flush(this.lpA + c * (ra - this.lpA));
    this.lpB = flush(this.lpB + c * (rb - this.lpB));
    const x = (l + r) * 0.5;
    this.a.write(flush(x + f * (w * this.lpB + (1 - w) * this.lpA)));
    this.b.write(flush(x * (1 - w) + f * (w * this.lpA + (1 - w) * this.lpB)));
    const g = (p[P_DL_MIX] as number) * DL_WET_G;
    this.oL = l + g * ra;
    this.oR = r + g * rb;
  }
}

/** Level the drive stage normalises around: drive changes character, not volume. */
const DRIVE_REF = 0.35, DRIVE_MAX_G = 24;
const TILT_HZ = 900, TILT_AMOUNT = 0.9;

/** Bits mapped from a full 16: 2^(16-1). At or above this the quantiser is a
 *  no-op worth skipping rather than a subtle noise floor worth keeping. */
const CRUSH_TRANSPARENT = 32768;

/** drive -> bitcrush -> chorus -> delay -> reverb -> trim -> safety limiter. */
/** Below this a mix is inaudible, so the unit is skipped outright. */
const SILENT = 1e-4;

export class FxChain implements FxUnit {
  private wasChorus = false;
  private wasDelay = false;
  private wasReverb = false;
  private onChorus = false;
  private onDelay = false;
  private onReverb = false;
  private readonly sm: Smoother[] = []; private readonly target = new Float32Array(N_PARAMS);
  /** Smoothed, in DSP units — the only path into the DSP, so an un-smoothed
   *  parameter is structurally impossible. */
  private readonly v = new Float32Array(N_PARAMS);
  private readonly chorus: Chorus; private readonly delay: Delay; private readonly reverb: Reverb;
  private readonly sr: number; private readonly tiltC: number;
  private sizeRaw = def(P_RV_SIZE); private decayRaw = def(P_RV_DECAY);
  private tilt = 0; private held = 0; private acc = 0;
  constructor(sampleRate: number) {
    this.sr = sampleRate;
    for (let i = 0; i < N_PARAMS; i++) this.sm.push(new Smoother(sampleRate, SMOOTH_MS[i] ?? 25));
    this.chorus = new Chorus(sampleRate); this.delay = new Delay(sampleRate);
    this.reverb = new Reverb(sampleRate, def(P_RV_SIZE), def(P_RV_DECAY));
    this.tiltC = onePole(TILT_HZ, sampleRate);
    for (let i = 0; i < N_PARAMS; i++) this.setParam(i, def(i));
    this.reset();
  }
  /** Descriptor units in, DSP units out. Runs per knob move, never per sample:
   *  every exp and pow in this effect lives here. */
  private toDsp(i: number, v: number): number {
    if (i === P_DRIVE) return v < 0 ? 0 : v > 1 ? 1 : v;
    if (i === P_DRIVE_TONE) return (v * 2 - 1) * TILT_AMOUNT;
    if (i === P_CRUSH_RATE) return 1 / (1 + v * 63);
    if (i === P_CRUSH_BITS) return Math.pow(2, v - 1);
    if (i === P_CH_RATE) return v / this.sr;
    if (i === P_DL_TIME || i === P_RV_PREDELAY) return (v * this.sr) / 1000;
    if (i === P_DL_FB) return v * DL_FB_MAX;
    if (i === P_DL_TONE) return onePole(v, this.sr);
    if (i === P_RV_DAMP) return 1 - 0.985 * v * v;
    if (i === P_TRIM) return Math.pow(10, v / 20);
    return v;
  }
  setParam(index: number, value: number): void {
    if (index < 0 || index >= N_PARAMS) return;
    const dsp = this.toDsp(index, value);
    this.target[index] = dsp;
    (this.sm[index] as Smoother).setTarget(dsp);
    if (index === P_RV_SIZE) this.sizeRaw = value;
    else if (index === P_RV_DECAY) this.decayRaw = value;
    else return;
    this.reverb.setDecay(this.sizeRaw, this.decayRaw);
  }
  /** Clears every buffer and snaps all smoothers. For audio start or a patch
   *  swap; never mid-note, that is what the smoothing is for. */
  reset(): void {
    this.tilt = 0; this.held = 0; this.acc = 0;
    for (let i = 0; i < N_PARAMS; i++) {
      const t = this.target[i] as number;
      (this.sm[i] as Smoother).snap(t); this.v[i] = t;
    }
    this.chorus.reset(); this.delay.reset(); this.reverb.reset();
  }

  /**
   * PERFORMANCE: chorus, delay and reverb are skipped when their mix is silent.
   *
   * They used to run unconditionally and blend to nothing, which measured 1.69%
   * of a core for a chain producing its input unchanged. Re-enabling resets the
   * unit, because its delay lines still hold audio from before the bypass and
   * fading that in would burst stale sound.
   */
  private gate(): void {
    const v = this.v, sm = this.sm;
    for (let i = 0; i < N_PARAMS; i++) v[i] = (sm[i] as Smoother).next();
    this.onChorus = (v[P_CH_MIX] as number) > SILENT;
    this.onDelay = (v[P_DL_MIX] as number) > SILENT;
    this.onReverb = (v[P_RV_MIX] as number) > SILENT;
    if (this.onChorus && !this.wasChorus) this.chorus.reset();
    if (this.onDelay && !this.wasDelay) this.delay.reset();
    if (this.onReverb && !this.wasReverb) this.reverb.reset();
    this.wasChorus = this.onChorus; this.wasDelay = this.onDelay; this.wasReverb = this.onReverb;
  }

  /** Drive and bitcrush: memoryless-plus-tilt, and inherently one-channel. In
   *  stereo they run on the mid and the side passes them by, which is exactly
   *  what they do to a mono bus and costs nothing extra. */
  private front(dry: number, v: Float32Array): number {
    let x = dry;
    const amt = v[P_DRIVE] as number;
    this.tilt = flush(this.tilt + this.tiltC * (x - this.tilt));
    if (amt > 0) {
      const g = 1 + amt * DRIVE_MAX_G;
      const shaped = x + (v[P_DRIVE_TONE] as number) * (x - this.tilt);
      const w = (sat(shaped * g) * DRIVE_REF) / sat(DRIVE_REF * g);
      // Blended in, so drive at zero is bit-exact bypass rather than "nearly".
      x = dry + (w - dry) * (amt * (2 - amt));
    }
    const rate = v[P_CRUSH_RATE] as number;
    this.acc += rate;
    if (this.acc >= 1) { this.acc -= 1; this.held = x; }
    const half = v[P_CRUSH_BITS] as number;
    /*
     * Bit-exact bypass when neither crush control is engaged. The quantiser
     * used to run unconditionally: at the 16-bit default it still rounded every
     * sample to 1/32768, which is a noise floor nobody asked for on a chain
     * whose controls are all at zero. Two comparisons are cheaper than the
     * floor-multiply-divide they replace.
     */
    if (rate >= 1 && half >= CRUSH_TRANSPARENT) return this.held;
    return Math.floor(this.held * half + 0.5) / half;
  }

  process(buffer: Float32Array, count: number): void {
    const v = this.v, sm = this.sm;
    this.gate();
    const onChorus = this.onChorus, onDelay = this.onDelay, onReverb = this.onReverb;
    for (let n = 0; n < count; n++) {
      for (let i = 0; i < N_PARAMS; i++) v[i] = (sm[i] as Smoother).next();
      let x = this.front(buffer[n] as number, v);
      if (onChorus) x = this.chorus.process(x, v);
      if (onDelay) x = this.delay.process(x, v);
      if (onReverb) x = this.reverb.process(x, v);
      x = limitOut(x * (v[P_TRIM] as number));
      buffer[n] = x === x ? x : 0;
    }
  }

  /**
   * The stereo entry point. Width lives here, not in the oscillators: six
   * engines rendering two channels would double the synth's cost to buy
   * something the effects give away nearly free.
   */
  processStereo(left: Float32Array, right: Float32Array, count: number): void {
    const v = this.v, sm = this.sm;
    this.gate();
    const onChorus = this.onChorus, onDelay = this.onDelay, onReverb = this.onReverb;
    const ch = this.chorus, dl = this.delay, rv = this.reverb;
    for (let n = 0; n < count; n++) {
      for (let i = 0; i < N_PARAMS; i++) v[i] = (sm[i] as Smoother).next();
      const li = left[n] as number, ri = right[n] as number;
      const mid = this.front((li + ri) * 0.5, v);
      const side = (li - ri) * 0.5;
      let l = mid + side, r = mid - side;
      if (onChorus) { ch.processStereo(l, r, v); l = ch.oL; r = ch.oR; }
      if (onDelay) { dl.processStereo(l, r, v); l = dl.oL; r = dl.oR; }
      if (onReverb) { rv.processStereo(l, r, v); l = rv.oL; r = rv.oR; }
      const trim = v[P_TRIM] as number;
      l = limitOut(l * trim); r = limitOut(r * trim);
      left[n] = l === l ? l : 0;
      right[n] = r === r ? r : 0;
    }
  }
}
