import { Smoother } from '@/dsp/smoothing';
import {
  FreqShifter, Tape, blend, FX_MAGIC_DESCRIPTOR, MAGIC_PARAM as P, softLimit,
} from '@/dsp/fx-magic-descriptor';
import { Freezer, Shimmer, Stutter, VowelFilter } from '@/dsp/fx-magic-units';

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
  /** Both channels in place, zero allocation. */
  processStereo(left: Float32Array, right: Float32Array, count: number): void;
  reset(): void;
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
  private onVowel = false; private onShift = false; private onStutter = false;
  private onShimmer = false; private onFreeze = false; private onTape = false;
  private anyOn = false;
  private stutterRatio = 1; private shimmerRatio = 1;
  private stutterSlice = 0; private shimmerSize = 0; private shimmerFb = 0;

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
   *
   * Gate on the TARGET as well as the current value. Hoisting the smoother
   * stepping out of the sample loop made parameter smoothing 128x slower — a
   * knob move would have taken about a third of a second to arrive — so the
   * per-sample stepping stays and the decision looks at where each mix is
   * heading. A unit is live while it is on, still ramping up, or ramping down
   * and not yet silent.
   */
  private prepare(): void {
    if (this.wantCapture) {
      this.freezer.capture((this.freezeLenMs / 1000) * this.sr);
      this.wantCapture = false;
    }
    if (this.wantRelease) { this.freezer.release(); this.wantRelease = false; }

    const v = this.val, t = this.tgt;
    const live = (idx: number): boolean =>
      (v[idx] as number) > SILENT || (t[idx] as number) > SILENT;

    this.onVowel = live(P.vowelMix);
    this.onShift = live(P.shiftMix);
    this.onStutter = live(P.stutterMix);
    this.onShimmer = live(P.shimmerMix);
    this.onFreeze = live(P.freezeMix);
    this.onTape = live(P.tapeWear) || live(P.tapeWow) || live(P.tapeFlutter);

    if (this.onVowel && !this.wasVowel) this.vowel.reset();
    if (this.onShift && !this.wasShift) this.shifter.reset();
    if (this.onStutter && !this.wasStutter) this.stutter.reset();
    if (this.onShimmer && !this.wasShimmer) this.shimmer.reset();
    if (this.onTape && !this.wasTape) this.tape.reset();
    this.wasVowel = this.onVowel; this.wasShift = this.onShift;
    this.wasStutter = this.onStutter; this.wasShimmer = this.onShimmer;
    this.wasTape = this.onTape;

    this.anyOn = this.onVowel || this.onShift || this.onStutter
      || this.onShimmer || this.onFreeze || this.onTape;
    if (!this.anyOn) return;

    // Transcendentals hoisted to block rate. Two `2 ** x` per SAMPLE violated
    // the project's own hot-loop rule and bought nothing: both derive from
    // smoothed parameters that barely move within a 128-sample block.
    this.stutterRatio = 2 ** ((t[P.stutterPitch] as number) / 12);
    this.shimmerRatio = 2 ** ((t[P.shimmerPitch] as number) / 12);
    this.stutterSlice = ((t[P.stutterSlice] as number) / 1000) * this.sr;
    this.shimmerSize = ((t[P.shimmerSize] as number) / 1000) * this.sr;
    this.shimmerFb = (t[P.shimmerFeedback] as number) * 0.85;
  }

  process(buffer: Float32Array, count: number): void {
    this.prepare();
    const v = this.val, np = v.length;

    /*
     * Fully bypassed. The freezer still needs feeding so a later capture has
     * material, but that is a ring-buffer write per sample rather than the six
     * effects, and the samples pass through untouched.
     */
    if (!this.anyOn) {
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < np; k++) v[k] = (this.sm[k] as Smoother).next();
        this.freezer.process(buffer[i] as number);
      }
      return;
    }

    const onVowel = this.onVowel, onShift = this.onShift, onStutter = this.onStutter;
    const onShimmer = this.onShimmer, onFreeze = this.onFreeze, onTape = this.onTape;
    const stutterSlice = this.stutterSlice, shimmerSize = this.shimmerSize;
    const stutterRatio = this.stutterRatio, shimmerRatio = this.shimmerRatio;
    const shimmerFb = this.shimmerFb;

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

  /**
   * Stereo. Two of these units widen and four do not, and the four that do not
   * say so out loud: the frequency shifter, the stutter, the freezer and the
   * tape all process the MID and let the SIDE pass around them untouched. That
   * is not stereo, but it is honest, and it matters — running them on a plain
   * sum would collapse the width the vowel filter built upstream every time one
   * of them was switched on.
   *
   * The vowel filter and the shimmer are genuinely two-channel: a second mix
   * vector over the same three formant bandpasses, and a second tap off the
   * same shimmer tank. Neither runs its DSP twice.
   */
  processStereo(left: Float32Array, right: Float32Array, count: number): void {
    this.prepare();
    const v = this.val, np = v.length;

    if (!this.anyOn) {
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < np; k++) v[k] = (this.sm[k] as Smoother).next();
        this.freezer.process(((left[i] as number) + (right[i] as number)) * 0.5);
      }
      return;
    }

    const onVowel = this.onVowel, onShift = this.onShift, onStutter = this.onStutter;
    const onShimmer = this.onShimmer, onFreeze = this.onFreeze, onTape = this.onTape;
    const stutterSlice = this.stutterSlice, shimmerSize = this.shimmerSize;
    const stutterRatio = this.stutterRatio, shimmerRatio = this.shimmerRatio;
    const shimmerFb = this.shimmerFb;

    for (let i = 0; i < count; i++) {
      for (let k = 0; k < np; k++) v[k] = (this.sm[k] as Smoother).next();
      let l = left[i] as number, r = right[i] as number;

      if (onVowel) {
        const m = (l + r) * 0.5, sd = (l - r) * 0.5, mix = v[P.vowelMix] as number;
        this.vowel.processStereo(m, v[P.vowelPos] as number, v[P.vowelSharp] as number);
        l = blend(l, this.vowel.oL + sd, mix);
        r = blend(r, this.vowel.oR - sd, mix);
      }
      if (onShift) {
        const m = (l + r) * 0.5, sd = (l - r) * 0.5;
        const y = blend(m, this.shifter.process(m, v[P.shiftHz] as number,
          v[P.shiftRing] as number), v[P.shiftMix] as number);
        l = y + sd; r = y - sd;
      }
      if (onStutter) {
        const m = (l + r) * 0.5, sd = (l - r) * 0.5;
        const y = blend(m, this.stutter.process(m, stutterSlice,
          v[P.stutterChance] as number, stutterRatio), v[P.stutterMix] as number);
        l = y + sd; r = y - sd;
      }
      if (onShimmer) {
        const mix = v[P.shimmerMix] as number;
        this.shimmer.processStereo(l, r, shimmerSize, shimmerFb, shimmerRatio,
          v[P.shimmerDamp] as number);
        l = blend(l, this.shimmer.oL, mix);
        r = blend(r, this.shimmer.oR, mix);
      }
      const mid = (l + r) * 0.5, side = (l - r) * 0.5;
      const frozen = this.freezer.process(mid);
      if (onFreeze) {
        const fm = v[P.freezeMix] as number;
        const y = mid * (1 - 0.5 * fm) + frozen * fm;
        l = y + side; r = y - side;
      }
      if (onTape) {
        const m = (l + r) * 0.5, sd = (l - r) * 0.5;
        const y = this.tape.process(m, v[P.tapeWear] as number, v[P.tapeWow] as number,
          v[P.tapeFlutter] as number);
        l = y + sd; r = y - sd;
      }

      if (!(l > -1e9 && l < 1e9) || !(r > -1e9 && r < 1e9)) { this.reset(); l = 0; r = 0; }
      const yl = softLimit(l, 0.9, 0.6), yr = softLimit(r, 0.9, 0.6);
      left[i] = yl > 1.2 ? 1.2 : yl < -1.2 ? -1.2 : yl;
      right[i] = yr > 1.2 ? 1.2 : yr < -1.2 ? -1.2 : yr;
    }
  }
}
