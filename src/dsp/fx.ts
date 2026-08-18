import { Smoother } from '@/dsp/smoothing';
import { FX_DESCRIPTOR } from './fx-descriptor';

const DENORMAL = 1e-20;

export interface FxUnit {
  setParam(index: number, value: number): void;
  /** Rewrites `buffer` in place. Allocates nothing. */
  process(buffer: Float32Array, count: number): void;
  reset(): void;
}

const P_DRIVE = 0;
const P_DRIVE_TONE = 1;
const P_CRUSH_RATE = 2;
const P_CRUSH_BITS = 3;
const P_CH_RATE = 4;
const P_CH_DEPTH = 5;
const P_CH_WIDTH = 6;
const P_CH_MIX = 7;
const P_DL_TIME = 8;
const P_DL_FB = 9;
const P_DL_TONE = 10;
const P_DL_WIDTH = 11;
const P_DL_MIX = 12;
const P_RV_PREDELAY = 13;
const P_RV_SIZE = 14;
const P_RV_DECAY = 15;
const P_RV_DAMP = 16;
const P_RV_MIX = 17;
const P_TRIM = 18;

function def(i: number): number {
  return FX_DESCRIPTOR.params[i]?.default ?? 0;
}

function flush(x: number): number {
  return x > -DENORMAL && x < DENORMAL ? 0 : x;
}

/** The ladder's rational tanh, with the input clamped so it is truly bounded
 *  to ±1 (the bare rational form starts climbing again past |x| ≈ 3). */
function sat(x: number): number {
  const c = x > 3 ? 3 : x < -3 ? -3 : x;
  const c2 = c * c;
  return (c * (27 + c2)) / (27 + 9 * c2);
}

/** Parabolic sine over phase 0..1. Close enough for an LFO, and keeps every
 *  transcendental out of the per-sample path. */
function lfo(p: number): number {
  const t = p * 2 - 1;
  return 4 * t * (t < 0 ? 1 + t : 1 - t);
}

/** One-pole coefficient for a cutoff in Hz. Only ever called at param rate. */
function onePole(hz: number, sr: number): number {
  const c = 1 - Math.exp((-2 * Math.PI * hz) / sr);
  return c > 0.999 ? 0.999 : c < 1e-4 ? 1e-4 : c;
}

/** A Smoother that remembers its target, so reset() can snap the whole chain. */
class Sm {
  private readonly s: Smoother;
  private t = 0;
  constructor(sampleRate: number, timeMs: number) {
    this.s = new Smoother(sampleRate, timeMs);
  }
  set(v: number): void {
    this.t = v;
    this.s.setTarget(v);
  }
  snap(): void {
    this.s.snap(this.t);
  }
  next(): number {
    return this.s.next();
  }
}

/** Power-of-two circular buffer with linear-interpolated fractional reads.
 *  Linear interpolation costs a gentle treble roll-off at long delays; that is
 *  the price of a read pointer that can move without clicking, and it is the
 *  reason time and size can be modulated at all. */
class Line {
  private readonly buf: Float32Array;
  private readonly mask: number;
  private w = 0;
  constructor(maxSamples: number) {
    let n = 4;
    while (n < maxSamples + 4) n <<= 1;
    this.buf = new Float32Array(n);
    this.mask = n - 1;
  }
  write(x: number): void {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }
  read(d: number): number {
    const lim = this.mask - 2;
    const c = d < 1 ? 1 : d > lim ? lim : d;
    const k = c | 0;
    const a = this.buf[(this.w - k) & this.mask] as number;
    const b = this.buf[(this.w - k - 1) & this.mask] as number;
    return a + (b - a) * (c - k);
  }
  clear(): void {
    this.buf.fill(0);
    this.w = 0;
  }
}

const CH_MID_MS = 12;
const CH_SPREAD_MS = 7;
const CH_DEPTH_MS = 3.5;

/** Three taps off one modulated line. Independent LFO phases and rates, so the
 *  copies never line up and cancel. */
class Chorus {
  private readonly line: Line;
  private readonly phase = new Float32Array(3);
  private readonly mid: number;
  private readonly spread: number;
  private readonly maxDepth: number;
  private readonly sr: number;
  private readonly rate: Sm;
  private readonly depth: Sm;
  private readonly width: Sm;
  private readonly mix: Sm;

  constructor(sr: number) {
    this.sr = sr;
    this.line = new Line(Math.ceil(sr * 0.05));
    this.mid = (CH_MID_MS * sr) / 1000;
    this.spread = (CH_SPREAD_MS * sr) / 1000;
    this.maxDepth = (CH_DEPTH_MS * sr) / 1000;
    this.rate = new Sm(sr, 30);
    this.depth = new Sm(sr, 30);
    this.width = new Sm(sr, 30);
    this.mix = new Sm(sr, 30);
    for (let i = P_CH_RATE; i <= P_CH_MIX; i++) this.setParam(i, def(i));
    this.reset();
  }

  setParam(i: number, v: number): void {
    if (i === P_CH_RATE) this.rate.set(v / this.sr);
    else if (i === P_CH_DEPTH) this.depth.set(v);
    else if (i === P_CH_WIDTH) this.width.set(v);
    else if (i === P_CH_MIX) this.mix.set(v);
  }

  reset(): void {
    this.line.clear();
    this.phase[0] = 0;
    this.phase[1] = 1 / 3;
    this.phase[2] = 2 / 3;
    this.rate.snap();
    this.depth.snap();
    this.width.snap();
    this.mix.snap();
  }

  process(x: number): number {
    const r = this.rate.next();
    const d = this.depth.next() * this.maxDepth;
    const w = this.width.next();
    const m = this.mix.next();
    let wet = 0;
    for (let i = 0; i < 3; i++) {
      let p = (this.phase[i] as number) + r * (1 + (i - 1) * 0.28 * w);
      if (p >= 1) p -= 1;
      else if (p < 0) p += 1;
      this.phase[i] = p;
      wet += this.line.read(this.mid + (i - 1) * this.spread * w + d * lfo(p));
    }
    this.line.write(x);
    return x * (1 - 0.5 * m) + wet * (m * 0.34);
  }
}

const DL_MAX_S = 2.05;
/** Hard ceiling on delay regeneration. The two-line matrix has spectral radius
 *  exactly this, for every width setting, so it can never run away. */
const DL_FB_MAX = 0.92;

class Delay {
  private readonly a: Line;
  private readonly b: Line;
  private lpA = 0;
  private lpB = 0;
  private readonly sr: number;
  private readonly time: Sm;
  private readonly fb: Sm;
  private readonly tone: Sm;
  private readonly width: Sm;
  private readonly mix: Sm;

  constructor(sr: number) {
    this.sr = sr;
    this.a = new Line(Math.ceil(sr * DL_MAX_S));
    this.b = new Line(Math.ceil(sr * DL_MAX_S));
    // Slow enough that a knob sweep glides like tape rather than clicking.
    this.time = new Sm(sr, 80);
    this.fb = new Sm(sr, 30);
    this.tone = new Sm(sr, 30);
    this.width = new Sm(sr, 60);
    this.mix = new Sm(sr, 30);
    for (let i = P_DL_TIME; i <= P_DL_MIX; i++) this.setParam(i, def(i));
    this.reset();
  }

  setParam(i: number, v: number): void {
    if (i === P_DL_TIME) this.time.set((v * this.sr) / 1000);
    else if (i === P_DL_FB) this.fb.set(v * DL_FB_MAX);
    else if (i === P_DL_TONE) this.tone.set(onePole(v, this.sr));
    else if (i === P_DL_WIDTH) this.width.set(v);
    else if (i === P_DL_MIX) this.mix.set(v);
  }

  reset(): void {
    this.a.clear();
    this.b.clear();
    this.lpA = 0;
    this.lpB = 0;
    this.time.snap();
    this.fb.snap();
    this.tone.snap();
    this.width.snap();
    this.mix.snap();
  }

  process(x: number): number {
    const t = this.time.next();
    const f = this.fb.next();
    const c = this.tone.next();
    const w = this.width.next();
    const m = this.mix.next();
    const ra = this.a.read(t);
    // A mono sum of a true ping-pong is just a plain delay, so width offsets
    // the second line instead: the repeats bounce in time, not in space.
    const rb = this.b.read(t * (1 - 0.5 * w));
    this.lpA = flush(this.lpA + c * (ra - this.lpA));
    this.lpB = flush(this.lpB + c * (rb - this.lpB));
    this.a.write(flush(x + f * (w * this.lpB + (1 - w) * this.lpA)));
    this.b.write(flush(f * (w * this.lpA + (1 - w) * this.lpB)));
    return x + m * 0.7 * (ra + rb);
  }
}

const FDN_N = 8;
/** Mutually prime at 48k, ~23–63 ms. Prime lengths push the echo coincidences
 *  as far apart as possible; equal or harmonically related lengths are exactly
 *  what makes a cheap FDN ring like a steel pipe. */
const FDN_LEN = [1123, 1367, 1621, 1889, 2179, 2467, 2789, 3037];
/** Schroeder allpass diffusers ahead of the network. Without these the early
 *  response is a handful of discrete echoes and no amount of tail fixes it. */
const AP_LEN = [67, 131, 229, 367];
const AP_G = 0.55;
const HAD = 0.3535533905932738;
const RV_MAX_G = 0.94;
const RV_MOD = 1.6;
const RV_IN = 0.5;

function hadamard8(v: Float32Array): void {
  for (let s = 1; s < FDN_N; s <<= 1) {
    for (let i = 0; i < FDN_N; i += s << 1) {
      for (let j = i; j < i + s; j++) {
        const a = v[j] as number;
        const b = v[j + s] as number;
        v[j] = a + b;
        v[j + s] = a - b;
      }
    }
  }
  for (let i = 0; i < FDN_N; i++) v[i] = (v[i] as number) * HAD;
}

/** Feedback delay network: pre-delay, four allpass diffusers, then eight
 *  damped delay lines mixed by an orthonormal Hadamard matrix. The matrix
 *  preserves energy exactly, so the loop gain is the largest line gain — hold
 *  that under 1 and the tail is mathematically guaranteed to decay. */
class Reverb {
  private readonly sr: number;
  private readonly pre: Line;
  private readonly ap: Line[] = [];
  private readonly apLen = new Float32Array(AP_LEN.length);
  private readonly buf: Float32Array;
  private readonly stride: number;
  private readonly mask: number;
  private w = 0;
  private readonly len = new Float32Array(FDN_N);
  private readonly gain = new Float32Array(FDN_N);
  private readonly lp = new Float32Array(FDN_N);
  private readonly v = new Float32Array(FDN_N);
  private readonly ph = new Float32Array(FDN_N);
  private readonly inc = new Float32Array(FDN_N);
  private sizeT = 0.5;
  private decayT = 2.2;
  private readonly predelay: Sm;
  private readonly size: Sm;
  private readonly damp: Sm;
  private readonly mix: Sm;

  constructor(sr: number) {
    this.sr = sr;
    const k = sr / 48000;
    this.pre = new Line(Math.ceil(sr * 0.2));
    for (let i = 0; i < AP_LEN.length; i++) {
      const l = (AP_LEN[i] as number) * k;
      this.apLen[i] = l;
      this.ap.push(new Line(Math.ceil(l) + 4));
    }
    let n = 4;
    let longest = 0;
    for (let i = 0; i < FDN_N; i++) {
      this.len[i] = (FDN_LEN[i] as number) * k;
      if ((this.len[i] as number) > longest) longest = this.len[i] as number;
      this.ph[i] = i / FDN_N;
      this.inc[i] = (0.31 + i * 0.07) / sr;
    }
    while (n < longest + 8) n <<= 1;
    this.stride = n;
    this.mask = n - 1;
    this.buf = new Float32Array(n * FDN_N);
    this.predelay = new Sm(sr, 120);
    this.size = new Sm(sr, 120);
    this.damp = new Sm(sr, 40);
    this.mix = new Sm(sr, 30);
    for (let i = P_RV_PREDELAY; i <= P_RV_MIX; i++) this.setParam(i, def(i));
    this.reset();
  }

  setParam(i: number, v: number): void {
    if (i === P_RV_PREDELAY) this.predelay.set((v * this.sr) / 1000);
    else if (i === P_RV_SIZE) {
      this.sizeT = v;
      this.size.set(v);
      this.recompute();
    } else if (i === P_RV_DECAY) {
      this.decayT = v / 1000;
      this.recompute();
    } else if (i === P_RV_DAMP) this.damp.set(1 - 0.985 * v * v);
    else if (i === P_RV_MIX) this.mix.set(v);
  }

  /** Per-line gain for a -60 dB tail at the requested time. A step in feedback
   *  gain changes the decay rate, not the waveform, so it needs no smoothing. */
  private recompute(): void {
    const dec = this.decayT * this.sr;
    for (let i = 0; i < FDN_N; i++) {
      const l = (this.len[i] as number) * this.sizeT;
      const g = Math.pow(10, (-3 * l) / dec);
      this.gain[i] = g > RV_MAX_G ? RV_MAX_G : g;
    }
  }

  reset(): void {
    this.pre.clear();
    for (let i = 0; i < this.ap.length; i++) (this.ap[i] as Line).clear();
    this.buf.fill(0);
    this.lp.fill(0);
    this.v.fill(0);
    this.w = 0;
    for (let i = 0; i < FDN_N; i++) this.ph[i] = i / FDN_N;
    this.predelay.snap();
    this.size.snap();
    this.damp.snap();
    this.mix.snap();
  }

  private tap(i: number, d: number): number {
    const mask = this.mask;
    const base = i * this.stride;
    const lim = mask - 2;
    const c = d < 1 ? 1 : d > lim ? lim : d;
    const k = c | 0;
    const a = this.buf[base + ((this.w - k) & mask)] as number;
    const b = this.buf[base + ((this.w - k - 1) & mask)] as number;
    return a + (b - a) * (c - k);
  }

  process(x: number): number {
    const s = this.size.next();
    const dp = this.damp.next();
    const m = this.mix.next();
    let d = this.pre.read(this.predelay.next());
    this.pre.write(x);
    for (let i = 0; i < AP_LEN.length; i++) {
      const line = this.ap[i] as Line;
      const bo = line.read(this.apLen[i] as number);
      const vv = flush(d + AP_G * bo);
      line.write(vv);
      d = bo - AP_G * vv;
    }
    let wet = 0;
    for (let i = 0; i < FDN_N; i++) {
      let p = (this.ph[i] as number) + (this.inc[i] as number);
      if (p >= 1) p -= 1;
      this.ph[i] = p;
      // A sliver of movement on every read keeps the modes from parking on
      // fixed frequencies, which is the difference between air and metal.
      const r = this.tap(i, (this.len[i] as number) * s + RV_MOD * lfo(p));
      wet += r;
      const l = flush((this.lp[i] as number) + dp * (r - (this.lp[i] as number)));
      this.lp[i] = l;
      this.v[i] = l * (this.gain[i] as number);
    }
    hadamard8(this.v);
    const inj = d * RV_IN;
    for (let i = 0; i < FDN_N; i++) {
      this.buf[i * this.stride + this.w] = flush(inj + (this.v[i] as number));
    }
    this.w = (this.w + 1) & this.mask;
    return x + m * wet * HAD;
  }
}

/** Nominal bus level the drive stage normalises around, so raising drive
 *  changes character instead of volume. */
const DRIVE_REF = 0.35;
const DRIVE_MAX_G = 24;
const TILT_HZ = 900;
const TILT_AMOUNT = 0.9;
const LIMIT = 1.5;

/** drive -> bitcrush -> chorus -> delay -> reverb -> trim -> safety limiter. */
export class FxChain implements FxUnit {
  private readonly chorus: Chorus;
  private readonly delay: Delay;
  private readonly reverb: Reverb;
  private readonly drive: Sm;
  private readonly driveTone: Sm;
  private readonly crushRate: Sm;
  private readonly crushBits: Sm;
  private readonly trim: Sm;
  private readonly tiltC: number;
  private tilt = 0;
  private held = 0;
  private acc = 0;

  constructor(sampleRate: number) {
    this.chorus = new Chorus(sampleRate);
    this.delay = new Delay(sampleRate);
    this.reverb = new Reverb(sampleRate);
    this.drive = new Sm(sampleRate, 25);
    this.driveTone = new Sm(sampleRate, 25);
    this.crushRate = new Sm(sampleRate, 25);
    this.crushBits = new Sm(sampleRate, 25);
    this.trim = new Sm(sampleRate, 25);
    this.tiltC = onePole(TILT_HZ, sampleRate);
    for (const i of [P_DRIVE, P_DRIVE_TONE, P_CRUSH_RATE, P_CRUSH_BITS, P_TRIM]) {
      this.setParam(i, def(i));
    }
    this.reset();
  }

  setParam(index: number, value: number): void {
    if (index >= P_CH_RATE && index <= P_CH_MIX) return this.chorus.setParam(index, value);
    if (index >= P_DL_TIME && index <= P_DL_MIX) return this.delay.setParam(index, value);
    if (index >= P_RV_PREDELAY && index <= P_RV_MIX) return this.reverb.setParam(index, value);
    if (index === P_DRIVE) this.drive.set(value < 0 ? 0 : value > 1 ? 1 : value);
    else if (index === P_DRIVE_TONE) this.driveTone.set((value * 2 - 1) * TILT_AMOUNT);
    else if (index === P_CRUSH_RATE) this.crushRate.set(1 / (1 + value * 63));
    else if (index === P_CRUSH_BITS) this.crushBits.set(Math.pow(2, value - 1));
    else if (index === P_TRIM) this.trim.set(Math.pow(10, value / 20));
  }

  /** Clears every buffer and snaps all smoothers to their targets. Call it when
   *  audio starts or a patch is swapped, never mid-note. */
  reset(): void {
    this.tilt = 0;
    this.held = 0;
    this.acc = 0;
    this.drive.snap();
    this.driveTone.snap();
    this.crushRate.snap();
    this.crushBits.snap();
    this.trim.snap();
    this.chorus.reset();
    this.delay.reset();
    this.reverb.reset();
  }

  process(buffer: Float32Array, count: number): void {
    for (let n = 0; n < count; n++) {
      const dry = buffer[n] as number;
      let x = dry;

      const amt = this.drive.next();
      const tilt = this.driveTone.next();
      this.tilt = flush(this.tilt + this.tiltC * (x - this.tilt));
      if (amt > 0) {
        const g = 1 + amt * DRIVE_MAX_G;
        const shaped = x + tilt * (x - this.tilt);
        const w = (sat(shaped * g) * DRIVE_REF) / sat(DRIVE_REF * g);
        // Blend in, so drive at zero is bit-exact bypass rather than "nearly".
        const blend = amt * (2 - amt);
        x = dry + (w - dry) * blend;
      }

      this.acc += this.crushRate.next();
      if (this.acc >= 1) {
        this.acc -= 1;
        this.held = x;
      }
      const half = this.crushBits.next();
      x = Math.floor(this.held * half + 0.5) / half;

      x = this.chorus.process(x);
      x = this.delay.process(x);
      x = this.reverb.process(x);
      x = sat((x * this.trim.next()) / LIMIT) * LIMIT;
      buffer[n] = x === x ? x : 0;
    }
  }
}
