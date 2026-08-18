import { Smoother } from '@/dsp/smoothing';
import { FX_DESCRIPTOR } from './fx-descriptor';

const DENORMAL = 1e-20;

export interface FxUnit {
  setParam(index: number, value: number): void;
  /** Rewrites `buffer` in place. Allocates nothing. */
  process(buffer: Float32Array, count: number): void;
  reset(): void;
}

const P_DRIVE = 0, P_DRIVE_TONE = 1, P_CRUSH_RATE = 2, P_CRUSH_BITS = 3;
const P_CH_RATE = 4, P_CH_DEPTH = 5, P_CH_WIDTH = 6, P_CH_MIX = 7;
const P_DL_TIME = 8, P_DL_FB = 9, P_DL_TONE = 10, P_DL_WIDTH = 11, P_DL_MIX = 12;
const P_RV_PREDELAY = 13, P_RV_SIZE = 14, P_RV_DECAY = 15;
const P_RV_DAMP = 16, P_RV_MIX = 17, P_TRIM = 18;

const N_PARAMS = FX_DESCRIPTOR.params.length;
/** Per-parameter smoothing. Delay time and reverb size move a read pointer so
 *  they glide; mixes and gains only need de-zippering. */
const SMOOTH_MS = [25, 25, 25, 25, 30, 30, 30, 30, 80, 30, 30, 60, 30, 120, 120, 30, 40, 30, 25];

function def(i: number): number { return FX_DESCRIPTOR.params[i]?.default ?? 0; }
function flush(x: number): number { return x > -DENORMAL && x < DENORMAL ? 0 : x; }

/** The ladder's rational tanh, input-clamped so it is genuinely bounded to ±1
 *  (the bare rational form starts climbing again past |x| = 3). */
function sat(x: number): number {
  const c = x > 3 ? 3 : x < -3 ? -3 : x, c2 = c * c;
  return (c * (27 + c2)) / (27 + 9 * c2);
}
/** Parabolic sine over phase 0..1 — no transcendentals in the sample loop. */
function lfo(p: number): number {
  const t = p * 2 - 1;
  return 4 * t * (t < 0 ? 1 + t : 1 - t);
}
/** One-pole coefficient for a cutoff in Hz. Only ever called at param rate. */
function onePole(hz: number, sr: number): number {
  const c = 1 - Math.exp((-2 * Math.PI * hz) / sr);
  return c > 0.999 ? 0.999 : c < 1e-4 ? 1e-4 : c;
}

/** Power-of-two circular buffer, linear-interpolated fractional reads. The
 *  interpolation buys a read pointer that can move without clicking. */
class Line {
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

const CH_MID_MS = 12, CH_SPREAD_MS = 7, CH_DEPTH_MS = 3.5, CH_DRY_CUT = 0.4, CH_WET_G = 0.55;
/** Three taps off one modulated line, each with its own LFO phase and (once
 *  width opens up) its own rate, so the copies never line up and cancel. */
class Chorus {
  private readonly line: Line;
  private readonly phase = new Float32Array(3);
  private readonly mid: number; private readonly spread: number; private readonly depth: number;
  constructor(sr: number) {
    this.line = new Line(Math.ceil(sr * 0.05));
    this.mid = (CH_MID_MS * sr) / 1000; this.spread = (CH_SPREAD_MS * sr) / 1000;
    this.depth = (CH_DEPTH_MS * sr) / 1000;
    this.reset();
  }
  reset(): void {
    this.line.clear();
    this.phase[0] = 0; this.phase[1] = 1 / 3; this.phase[2] = 2 / 3;
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
}

const DL_MAX_S = 2.05;
/** Regeneration ceiling. The two-line cross-feed matrix has spectral radius
 *  exactly this at every width setting, so the delay can never run away. */
const DL_FB_MAX = 0.92;
class Delay {
  private readonly a: Line; private readonly b: Line;
  private lpA = 0; private lpB = 0;
  constructor(sr: number) {
    this.a = new Line(Math.ceil(sr * DL_MAX_S)); this.b = new Line(Math.ceil(sr * DL_MAX_S));
  }
  reset(): void { this.a.clear(); this.b.clear(); this.lpA = 0; this.lpB = 0; }
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
    return x + (p[P_DL_MIX] as number) * 0.7 * (ra + rb);
  }
}

const FDN_N = 8, AP_N = 4;
/** Mutually prime at 48k, 23–63 ms. Primes push the coincidences between echoes
 *  as far apart as they go; equal or harmonically related lengths are exactly
 *  what makes a cheap FDN ring like a steel pipe. */
const FDN_LEN = [1123, 1367, 1621, 1889, 2179, 2467, 2789, 3037];
/** Schroeder allpass diffusers ahead of the network. Without them the early
 *  response is a handful of bare echoes, and no tail rescues that. */
const AP_LEN = [67, 131, 229, 367];
const AP_G = 0.55, HAD = 0.3535533905932738;
const RV_MAX_G = 0.94, RV_MOD = 1.6, RV_IN = 0.5;
function hadamard8(v: Float32Array): void {
  for (let s = 1; s < FDN_N; s <<= 1) {
    for (let i = 0; i < FDN_N; i += s << 1) {
      for (let j = i; j < i + s; j++) {
        const a = v[j] as number, b = v[j + s] as number;
        v[j] = a + b; v[j + s] = a - b;
      }
    }
  }
  for (let i = 0; i < FDN_N; i++) v[i] = (v[i] as number) * HAD;
}

/** Pre-delay, four allpass diffusers, then eight damped delay lines mixed by an
 *  orthonormal Hadamard matrix. The matrix preserves energy exactly, so loop
 *  gain is just the largest line gain: hold it under 1 and decay is a theorem. */
class Reverb {
  private readonly sr: number; private readonly pre: Line;
  private readonly ap: Line[] = []; private readonly apLen = new Float32Array(AP_N);
  private readonly line: Line[] = [];
  private readonly len = new Float32Array(FDN_N); private readonly gain = new Float32Array(FDN_N);
  private readonly lp = new Float32Array(FDN_N); private readonly v = new Float32Array(FDN_N);
  private readonly ph = new Float32Array(FDN_N); private readonly inc = new Float32Array(FDN_N);
  constructor(sr: number) {
    this.sr = sr;
    const k = sr / 48000;
    this.pre = new Line(Math.ceil(sr * 0.2));
    for (let i = 0; i < AP_N; i++) {
      const l = (AP_LEN[i] as number) * k;
      this.apLen[i] = l; this.ap.push(new Line(Math.ceil(l) + 4));
    }
    for (let i = 0; i < FDN_N; i++) {
      const l = (FDN_LEN[i] as number) * k;
      this.len[i] = l; this.inc[i] = (0.31 + i * 0.07) / sr;
      this.line.push(new Line(Math.ceil(l) + 8));
    }
    this.setDecay(def(P_RV_SIZE), def(P_RV_DECAY));
    this.reset();
  }

  /** Per-line gain for a -60 dB tail. A step in feedback gain changes the decay
   *  rate, not the waveform, so unlike everything else it needs no smoothing. */
  setDecay(size: number, decayMs: number): void {
    const dec = (decayMs / 1000) * this.sr;
    for (let i = 0; i < FDN_N; i++) {
      const g = Math.pow(10, (-3 * (this.len[i] as number) * size) / dec);
      this.gain[i] = g > RV_MAX_G ? RV_MAX_G : g;
    }
  }
  reset(): void {
    this.pre.clear();
    for (let i = 0; i < AP_N; i++) (this.ap[i] as Line).clear();
    for (let i = 0; i < FDN_N; i++) { (this.line[i] as Line).clear(); this.ph[i] = i / FDN_N; }
    this.lp.fill(0); this.v.fill(0);
  }
  process(x: number, p: Float32Array): number {
    const s = p[P_RV_SIZE] as number, dp = p[P_RV_DAMP] as number;
    let d = this.pre.read(p[P_RV_PREDELAY] as number);
    this.pre.write(x);
    for (let i = 0; i < AP_N; i++) {
      const ln = this.ap[i] as Line;
      const bo = ln.read(this.apLen[i] as number), vv = flush(d + AP_G * bo);
      ln.write(vv); d = bo - AP_G * vv;
    }
    let wet = 0;
    for (let i = 0; i < FDN_N; i++) {
      let ph = (this.ph[i] as number) + (this.inc[i] as number);
      if (ph >= 1) ph -= 1;
      this.ph[i] = ph;
      // A sliver of movement on every read stops the modes parking on fixed
      // frequencies — the difference between air and metal.
      const r = (this.line[i] as Line).read((this.len[i] as number) * s + RV_MOD * lfo(ph));
      wet += r;
      const l = flush((this.lp[i] as number) + dp * (r - (this.lp[i] as number)));
      this.lp[i] = l;
      this.v[i] = l * (this.gain[i] as number);
    }
    hadamard8(this.v);
    const inj = d * RV_IN;
    for (let i = 0; i < FDN_N; i++) (this.line[i] as Line).write(flush(inj + (this.v[i] as number)));
    return x + (p[P_RV_MIX] as number) * wet * HAD;
  }
}

/** Level the drive stage normalises around: drive changes character, not volume. */
const DRIVE_REF = 0.35, DRIVE_MAX_G = 24;
const TILT_HZ = 900, TILT_AMOUNT = 0.9, LIMIT = 1.5;

/** drive -> bitcrush -> chorus -> delay -> reverb -> trim -> safety limiter. */
export class FxChain implements FxUnit {
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
    this.reverb = new Reverb(sampleRate); this.tiltC = onePole(TILT_HZ, sampleRate);
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
  process(buffer: Float32Array, count: number): void {
    const v = this.v, sm = this.sm;
    for (let n = 0; n < count; n++) {
      for (let i = 0; i < N_PARAMS; i++) v[i] = (sm[i] as Smoother).next();
      const dry = buffer[n] as number;
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
      this.acc += v[P_CRUSH_RATE] as number;
      if (this.acc >= 1) { this.acc -= 1; this.held = x; }
      const half = v[P_CRUSH_BITS] as number;
      x = Math.floor(this.held * half + 0.5) / half;
      x = this.chorus.process(x, v);
      x = this.delay.process(x, v);
      x = this.reverb.process(x, v);
      x = sat((x * (v[P_TRIM] as number)) / LIMIT) * LIMIT;
      buffer[n] = x === x ? x : 0;
    }
  }
}
