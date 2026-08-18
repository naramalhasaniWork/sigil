import { FX_DESCRIPTOR } from './fx-descriptor';

/**
 * Shared primitives and parameter indices for the master FX chain. These lived
 * in fx.ts until the reverb grew a second output vector; splitting them out
 * keeps fx.ts and fx-reverb.ts both under the 300-line ceiling.
 */

const DENORMAL = 1e-20;

export function flush(x: number): number {
  return x > -DENORMAL && x < DENORMAL ? 0 : x;
}

/** The ladder's rational tanh, input-clamped so it is genuinely bounded to ±1
 *  (the bare rational form starts climbing again past |x| = 3). */
export function sat(x: number): number {
  const c = x > 3 ? 3 : x < -3 ? -3 : x, c2 = c * c;
  return (c * (27 + c2)) / (27 + 9 * c2);
}

/**
 * The output stage's ceiling. Signal is untouched below `LIMIT_KNEE` and is
 * bent smoothly toward `LIMIT_CEIL` above it.
 */
export const LIMIT_KNEE = 1.0;
export const LIMIT_CEIL = 1.5;

/**
 * Safety limiter with a genuinely linear region.
 *
 * The previous output stage was `sat(x / 1.5) * 1.5`, which has no linear
 * region at all: sat's cubic shaping puts a third-harmonic term on EVERY
 * sample, growing with level. Measured, that was -48 dB THD+N at -20 dBFS
 * rising to -30 dB (3.2%) with -0.8 dB of loss at full scale — permanent, on
 * the default chain, with every effect switched off. Hot sources sat in the
 * worst of it continuously. It is the mechanism behind a long-standing
 * complaint that the instrument sounded slightly veiled.
 *
 * Below the knee this returns x unchanged — bit-exact, not "nearly". Above it,
 * u/(1+u) bends toward the ceiling with slope exactly 1 at the knee, so the
 * transition is C1 continuous and cannot click. Only true overs are shaped,
 * which is what a safety limiter is for.
 */
export function limitOut(x: number): number {
  const a = x < 0 ? -x : x;
  if (a <= LIMIT_KNEE) return x;
  const span = LIMIT_CEIL - LIMIT_KNEE;
  const u = (a - LIMIT_KNEE) / span;
  const bent = LIMIT_KNEE + span * (u / (1 + u));
  return x < 0 ? -bent : bent;
}

/** Parabolic sine over phase 0..1 — no transcendentals in the sample loop. */
export function lfo(p: number): number {
  const t = p * 2 - 1;
  return 4 * t * (t < 0 ? 1 + t : 1 - t);
}

/** One-pole coefficient for a cutoff in Hz. Only ever called at param rate. */
export function onePole(hz: number, sr: number): number {
  const c = 1 - Math.exp((-2 * Math.PI * hz) / sr);
  return c > 0.999 ? 0.999 : c < 1e-4 ? 1e-4 : c;
}

/** Power-of-two circular buffer, linear-interpolated fractional reads. The
 *  interpolation buys a read pointer that can move without clicking. */
export class Line {
  private readonly buf: Float32Array; private readonly mask: number;
  private w = 0;
  constructor(maxSamples: number) {
    let n = 4;
    while (n < maxSamples + 4) n <<= 1;
    this.buf = new Float32Array(n);
    this.mask = n - 1;
  }
  write(x: number): void { this.buf[this.w] = x; this.w = (this.w + 1) & this.mask; }
  read(d: number): number {
    const lim = this.mask - 2, c = d < 1 ? 1 : d > lim ? lim : d, k = c | 0;
    const a = this.buf[(this.w - k) & this.mask] as number;
    const b = this.buf[(this.w - k - 1) & this.mask] as number;
    return a + (b - a) * (c - k);
  }
  clear(): void { this.buf.fill(0); this.w = 0; }
}

export const P_DRIVE = 0, P_DRIVE_TONE = 1, P_CRUSH_RATE = 2, P_CRUSH_BITS = 3;
export const P_CH_RATE = 4, P_CH_DEPTH = 5, P_CH_WIDTH = 6, P_CH_MIX = 7;
export const P_DL_TIME = 8, P_DL_FB = 9, P_DL_TONE = 10, P_DL_WIDTH = 11, P_DL_MIX = 12;
export const P_RV_PREDELAY = 13, P_RV_SIZE = 14, P_RV_DECAY = 15;
export const P_RV_DAMP = 16, P_RV_MIX = 17, P_TRIM = 18;

export const N_PARAMS = FX_DESCRIPTOR.params.length;

export function def(i: number): number { return FX_DESCRIPTOR.params[i]?.default ?? 0; }
