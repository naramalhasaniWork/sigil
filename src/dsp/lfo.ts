import { blep } from './blep';

const TWO_PI = 6.283185307179586;
const DENORMAL = 1e-20;

/** Oscillator shapes, in descriptor step order. */
export const WAVE_SAW = 0;
export const WAVE_PULSE = 1;
export const WAVE_TRIANGLE = 2;
export const WAVE_SINE = 3;
export const WAVE_COUNT = 4;

/** A leaky-integrated square settles at ~0.245 peak, whatever the pitch. */
const TRI_SCALE = 4.083;

/**
 * Adds `count` antialiased oscillator samples into `out`, scaled by `gain`.
 *
 * Block form on purpose. Choosing a waveform per sample means a branch and a
 * non-inlined call in the hottest loop in the synth, which measured about
 * twice the cost of the oscillator itself; hoisting the choice outside the
 * loop and keeping phase in a local makes each shape a tight monomorphic loop.
 * `ph` holds phases and `tri` the triangle integrator states, indexed by `u`,
 * so one voice can run several copies without allocating an object per copy.
 *
 * Saw and pulse are polyBLEP corrected — a naive version of either aliases
 * audibly above a few kHz, which is the difference between "digital" and
 * "harsh". A pulse is two BLEP-corrected saws offset by the pulse width, and
 * that offset cancels the DC exactly, so no correction term is needed.
 * Triangle is the leaky integral of a square, which rolls off whatever
 * aliasing survived the square by a further 6 dB per octave for free.
 */
export function addOsc(
  shape: number, out: Float64Array, count: number,
  ph: Float64Array, tri: Float64Array, u: number,
  inc: number, pw: number, gain: number,
): void {
  let p = ph[u] as number;
  if (shape <= WAVE_SAW) {
    for (let i = 0; i < count; i++) {
      p += inc; if (p >= 1) p -= 1;
      out[i] = (out[i] as number) + (2 * p - 1 - blep(p, inc)) * gain;
    }
  } else if (shape >= WAVE_SINE) {
    for (let i = 0; i < count; i++) {
      p += inc; if (p >= 1) p -= 1;
      out[i] = (out[i] as number) + Math.sin(p * TWO_PI) * gain;
    }
  } else if (shape === WAVE_PULSE) {
    for (let i = 0; i < count; i++) {
      p += inc; if (p >= 1) p -= 1;
      let q = p + pw; if (q >= 1) q -= 1;
      const sq = (2 * p - 1 - blep(p, inc)) - (2 * q - 1 - blep(q, inc));
      out[i] = (out[i] as number) + sq * gain;
    }
  } else {
    let t = tri[u] as number;
    const g = gain * TRI_SCALE;
    for (let i = 0; i < count; i++) {
      p += inc; if (p >= 1) p -= 1;
      let q = p + 0.5; if (q >= 1) q -= 1;
      const sq = (2 * p - 1 - blep(p, inc)) - (2 * q - 1 - blep(q, inc));
      t = t * (1 - inc) + inc * sq;
      if (t < DENORMAL && t > -DENORMAL) t = 0;
      out[i] = (out[i] as number) + t * g;
    }
    tri[u] = t;
  }
  ph[u] = p;
}

/** LFO shapes, in descriptor step order. */
export const LFO_SINE = 0;
export const LFO_TRIANGLE = 1;
export const LFO_SQUARE = 2;
export const LFO_SAMPLE_HOLD = 3;
export const LFO_RANDOM_WALK = 4;
export const LFO_SHAPE_COUNT = 5;

/** How far one random-walk step may move, in output units. */
const WALK_STEP = 0.55;

/**
 * A modulation source that is not an envelope.
 *
 * Five shapes, because they do genuinely different jobs: sine and triangle for
 * vibrato and slow swells, square for trills and gating, sample-and-hold for
 * the stepped burbling of an old sequencer, and a smooth random walk for the
 * kind of movement that never repeats and so never announces itself as a loop.
 * Every shape returns -1..1, so any destination can scale it with one number.
 *
 * Three details separate a musical LFO from a sine generator:
 *   - **Keysync**: reset the phase on every note, or let it free-run so each
 *     note catches the wave somewhere different. Free-running is what stops a
 *     chord sounding like one sound played four times.
 *   - **Fade-in**: modulation that arrives after the note starts is expressive;
 *     modulation that is already there when the note starts is a texture.
 *   - **Per-voice seeding**: two voices sharing a random stream lock together
 *     and stop sounding like two voices.
 *
 * Allocation-free: `next()` touches numbers only.
 */
export class Lfo {
  private phase = 0;
  private inc = 0;
  private shape = LFO_SINE;
  private depth = 1;
  private fade = 1;
  private fadeInc = 1;
  private held = 0;
  private from = 0;
  private to = 0;
  private rngState = 0x9e3779b9 | 0;
  private readonly sr: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate > 1 ? sampleRate : 1;
    this.setRate(4);
  }

  /** Deterministic xorshift32 in -1..1. Seeded per voice, never Math.random. */
  private rand(): number {
    let s = this.rngState;
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    this.rngState = s;
    return (s >>> 0) / 2147483648 - 1;
  }

  setRate(hz: number): void {
    const max = this.sr * 0.45;
    const f = !(hz > 0) ? 0 : hz > max ? max : hz;
    this.inc = f / this.sr;
  }

  setShape(shape: number): void {
    const s = Math.round(shape);
    this.shape = s < 0 ? 0 : s >= LFO_SHAPE_COUNT ? LFO_SHAPE_COUNT - 1 : s;
  }

  /** Overall output scale, 0..1. Destination depths multiply on top of this. */
  setDepth(depth: number): void {
    this.depth = !(depth > 0) ? 0 : depth > 1 ? 1 : depth;
  }

  /** Time the LFO takes to fade up to full after each note starts. */
  setDelayMs(ms: number): void {
    const samples = (ms / 1000) * this.sr;
    this.fadeInc = samples >= 1 ? 1 / samples : 1;
  }

  /** Decorrelates one voice from the next; same index gives the same stream. */
  seed(voiceIndex: number): void {
    const s = (Math.trunc(voiceIndex) * 0x9e3779b1 + 0x85ebca6b) | 0;
    this.rngState = s === 0 ? 0x6d2b79f5 | 0 : s;
    this.from = this.rand();
    this.to = this.rand();
    this.held = this.from;
  }

  /**
   * Note start. The fade always restarts; the phase only resets when the
   * patch asked for keysync.
   */
  trigger(keysync: boolean): void {
    this.fade = this.fadeInc >= 1 ? 1 : 0;
    if (keysync) this.phase = 0;
  }

  reset(): void {
    this.phase = 0;
    this.fade = 1;
    this.from = 0;
    this.to = 0;
    this.held = 0;
  }

  next(): number {
    let p = this.phase + this.inc;
    if (p >= 1) {
      p -= 1;
      if (p >= 1) p = 0;
      // One new random per cycle drives both stepped shapes: sample-and-hold
      // jumps straight to it, the walk takes a step of that size towards its
      // next resting point. The walk REFLECTS off the rails rather than
      // clamping - a clamped walk parks against a rail and stops moving.
      const r = this.rand();
      this.held = r;
      this.from = this.to;
      let t = this.to + r * WALK_STEP;
      if (t > 1) t = 2 - t;
      else if (t < -1) t = -2 - t;
      this.to = t;
    }
    this.phase = p;

    let v: number;
    if (this.shape === LFO_SINE) {
      v = Math.sin(p * TWO_PI);
    } else if (this.shape === LFO_TRIANGLE) {
      v = p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    } else if (this.shape === LFO_SQUARE) {
      v = p < 0.5 ? 1 : -1;
    } else if (this.shape === LFO_SAMPLE_HOLD) {
      v = this.held;
    } else {
      const s = p * p * (3 - 2 * p);
      v = this.from + (this.to - this.from) * s;
    }

    if (this.fade < 1) {
      this.fade += this.fadeInc;
      if (this.fade > 1) this.fade = 1;
    }

    const out = v * this.depth * this.fade;
    return out < DENORMAL && out > -DENORMAL ? 0 : out;
  }
}
