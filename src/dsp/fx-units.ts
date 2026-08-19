/**
 * The two delay-line effects of the master FX chain: chorus and the ping-pong
 * delay. Split out of fx.ts to keep both files inside the 300-line ceiling, and
 * split along the same seam as the C++ port's fx-chain-units.h so the two stay
 * easy to read side by side.
 */
import {
  Line, flush, lfo,
  P_CH_RATE, P_CH_DEPTH, P_CH_WIDTH, P_CH_MIX,
  P_DL_TIME, P_DL_FB, P_DL_TONE, P_DL_WIDTH, P_DL_MIX,
} from './fx-core';

const CH_MID_MS = 12, CH_SPREAD_MS = 7, CH_DEPTH_MS = 3.5, CH_DRY_CUT = 0.4, CH_WET_G = 0.55;
/** Three taps off one modulated line, each with its own LFO phase and (once
 *  width opens up) its own rate, so the copies never line up and cancel. */
export class Chorus {
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
export const DL_FB_MAX = 0.92;
const DL_WET_G = 0.7;
export class Delay {
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
