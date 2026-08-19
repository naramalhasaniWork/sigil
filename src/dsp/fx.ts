import { Smoother } from '@/dsp/smoothing';
import {
  def, flush, onePole, sat,
  N_PARAMS, P_DRIVE, P_DRIVE_TONE, P_CRUSH_RATE, P_CRUSH_BITS,
  P_CH_RATE, P_CH_WIDTH, P_CH_MIX,
  P_DL_TIME, P_DL_FB, P_DL_TONE, P_DL_WIDTH, P_DL_MIX,
  P_RV_PREDELAY, P_RV_SIZE, P_RV_DECAY, P_RV_DAMP, P_RV_MIX, P_TRIM, P_GLUE,
  limitOut, glueOut,
} from './fx-core';
import { Reverb } from './fx-reverb';
import { Chorus, Delay, DL_FB_MAX } from './fx-units';

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
const SMOOTH_MS = [25, 25, 25, 25, 30, 30, 30, 30, 80, 30, 30, 60, 30, 120, 120, 30, 40, 30, 25, 25];

/** Level the drive stage normalises around: drive changes character, not volume. */
const DRIVE_REF = 0.35, DRIVE_MAX_G = 24;
const TILT_HZ = 900, TILT_AMOUNT = 0.9;

/** Bits mapped from a full 16: 2^(16-1). At or above this the quantiser is a
 *  no-op worth skipping rather than a subtle noise floor worth keeping. */
const CRUSH_TRANSPARENT = 32768;

/** drive -> bitcrush -> chorus -> delay -> reverb -> trim -> glue -> limiter. */
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
    if (this.onChorus && !this.wasChorus) { this.chorus.reset(); this.snapRange(P_CH_RATE, P_CH_WIDTH); }
    if (this.onDelay && !this.wasDelay) { this.delay.reset(); this.snapRange(P_DL_TIME, P_DL_WIDTH); }
    if (this.onReverb && !this.wasReverb) {
      this.reverb.reset(); this.snapRange(P_RV_PREDELAY, P_RV_DAMP);
    }
    this.wasChorus = this.onChorus; this.wasDelay = this.onDelay; this.wasReverb = this.onReverb;
  }

  /** Settings of a unit that has just been switched back on jump straight to
   *  target rather than gliding from wherever they were left. They were not
   *  being advanced per sample while the unit was silent (see step()), and the
   *  unit's buffers have just been cleared, so there is nothing for them to
   *  click against — whereas gliding a delay time in from a stale value is an
   *  audible sweep on the first repeats. Mix values are never snapped: a mix
   *  has to fade. */
  private snapRange(from: number, to: number): void {
    for (let i = from; i <= to; i++) {
      const t = this.target[i] as number;
      (this.sm[i] as Smoother).snap(t);
      this.v[i] = t;
    }
  }

  /**
   * Advance the smoothers this sample actually consumes.
   *
   * Every parameter used to be advanced on every sample, including the eleven
   * belonging to units gate() had just switched off — whose values nothing then
   * read. On a bypassed chain that was over half of the only work left, and it
   * is the reason a chain producing its input unchanged still cost real CPU.
   * The three mix values stay in the per-sample set because gate() tests them
   * and because a mix must fade without a step; the switched-off units' settings
   * still advance once per block in gate(), and are snapped on the way back in.
   */
  private step(): void {
    const v = this.v, sm = this.sm;
    for (let i = P_DRIVE; i <= P_CRUSH_BITS; i++) v[i] = (sm[i] as Smoother).next();
    if (this.onChorus) {
      for (let i = P_CH_RATE; i <= P_CH_WIDTH; i++) v[i] = (sm[i] as Smoother).next();
    }
    v[P_CH_MIX] = (sm[P_CH_MIX] as Smoother).next();
    if (this.onDelay) {
      for (let i = P_DL_TIME; i <= P_DL_WIDTH; i++) v[i] = (sm[i] as Smoother).next();
    }
    v[P_DL_MIX] = (sm[P_DL_MIX] as Smoother).next();
    if (this.onReverb) {
      for (let i = P_RV_PREDELAY; i <= P_RV_DAMP; i++) v[i] = (sm[i] as Smoother).next();
    }
    v[P_RV_MIX] = (sm[P_RV_MIX] as Smoother).next();
    v[P_TRIM] = (sm[P_TRIM] as Smoother).next();
    v[P_GLUE] = (sm[P_GLUE] as Smoother).next();
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
    const v = this.v;
    this.gate();
    const onChorus = this.onChorus, onDelay = this.onDelay, onReverb = this.onReverb;
    for (let n = 0; n < count; n++) {
      this.step();
      let x = this.front(buffer[n] as number, v);
      if (onChorus) x = this.chorus.process(x, v);
      if (onDelay) x = this.delay.process(x, v);
      if (onReverb) x = this.reverb.process(x, v);
      // Trim first, exactly as the old always-on stage was driven, so pushing
      // Output up pushes harder into the glue. The limiter stays behind it: at
      // glue 0 this is `limitOut(x * trim)` untouched, and at glue 1 the curve
      // has already bent toward 1.5 before the limiter sees it, so the two
      // compose into a slightly lower ceiling rather than fighting.
      const t = x * (v[P_TRIM] as number);
      const glue = v[P_GLUE] as number;
      x = limitOut(glue > 0 ? glueOut(t, glue) : t);
      buffer[n] = x === x ? x : 0;
    }
  }

  /**
   * The stereo entry point. Width lives here, not in the oscillators: six
   * engines rendering two channels would double the synth's cost to buy
   * something the effects give away nearly free.
   */
  processStereo(left: Float32Array, right: Float32Array, count: number): void {
    const v = this.v;
    this.gate();
    const onChorus = this.onChorus, onDelay = this.onDelay, onReverb = this.onReverb;
    const ch = this.chorus, dl = this.delay, rv = this.reverb;
    for (let n = 0; n < count; n++) {
      this.step();
      const li = left[n] as number, ri = right[n] as number;
      const mid = this.front((li + ri) * 0.5, v);
      const side = (li - ri) * 0.5;
      let l = mid + side, r = mid - side;
      if (onChorus) { ch.processStereo(l, r, v); l = ch.oL; r = ch.oR; }
      if (onDelay) { dl.processStereo(l, r, v); l = dl.oL; r = dl.oR; }
      if (onReverb) { rv.processStereo(l, r, v); l = rv.oL; r = rv.oR; }
      const trim = v[P_TRIM] as number;
      const glue = v[P_GLUE] as number;
      const tl = l * trim, tr = r * trim;
      l = limitOut(glue > 0 ? glueOut(tl, glue) : tl);
      r = limitOut(glue > 0 ? glueOut(tr, glue) : tr);
      left[n] = l === l ? l : 0;
      right[n] = r === r ? r : 0;
    }
  }
}
