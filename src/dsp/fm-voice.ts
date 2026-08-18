import type { EngineModule, EngineVoice } from '@/audio/types';
import { FM_DESCRIPTOR } from './fm-descriptor';
import { Envelope } from './envelope';
import { Smoother } from './smoothing';

const P_ALGO = 0;
const P_OP_BASE = 1;
const P_OP_STRIDE = 3;
const P_INDEX = 13;
const P_KEY_SCALE = 14;
const P_FEEDBACK = 15;
const P_SPREAD = 16;
const P_BALANCE = 17;
const P_AMP_A = 18;
const P_MOD_A = 22;

const N_OPS = 4;
const MAX_ALGO = 4;
const TAU = Math.PI * 2;
const DENORM = 1e-20;
const REF_HZ = 261.6256;

/** Bit k set = operator k+1 is a carrier, per algorithm. */
const CARRIER_MASK = new Uint8Array([0b0001, 0b0001, 0b0101, 0b1111, 0b0011]);
/** Fixed, mutually irrational-ish detune pattern in semitones, scaled by Spread. */
const SPREAD_SEMIS = new Float32Array([0, 0.035, -0.026, 0.061]);

/** Hard-bounded soft clipper. Unlike a rational tanh this can never exceed 1,
 *  which is what keeps the feedback operator from running away. */
function softClip(x: number): number {
  return x / (1 + (x < 0 ? -x : x));
}

/** DX7-style coarse ratios: a half-speed setting plus the whole numbers. */
function quantizeRatio(v: number): number {
  if (v < 0.75) return 0.5;
  const r = Math.round(v);
  return r < 1 ? 1 : r > 16 ? 16 : r;
}

class FmVoice implements EngineVoice {
  private readonly params = new Float32Array(FM_DESCRIPTOR.params.length);
  private readonly inc = new Float32Array(N_OPS);
  private readonly level = new Float32Array(N_OPS);
  private readonly carrierGain = new Float32Array(N_OPS);

  private readonly envA: Envelope;
  private readonly envB: Envelope;
  private readonly envC: Envelope;
  private readonly envD: Envelope;
  private readonly indexSmooth: Smoother;
  private readonly fbSmooth: Smoother;
  private readonly levelSmooth: readonly [Smoother, Smoother, Smoother, Smoother];
  private readonly gainSmooth: readonly [Smoother, Smoother, Smoother, Smoother];

  private readonly sr: number;
  private baseFreq = 220;
  private velocity = 1;
  private active = false;
  private algo = 0;
  private carrierMask = 1;
  private keyScale = 1;

  private ph0 = 0;
  private ph1 = 0;
  private ph2 = 0;
  private ph3 = 0;
  private fbZ1 = 0;
  private fbZ2 = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.envA = new Envelope(sampleRate);
    this.envB = new Envelope(sampleRate);
    this.envC = new Envelope(sampleRate);
    this.envD = new Envelope(sampleRate);
    this.indexSmooth = new Smoother(sampleRate, 12);
    this.fbSmooth = new Smoother(sampleRate, 12);
    const mk = (): Smoother => new Smoother(sampleRate, 8);
    this.levelSmooth = [mk(), mk(), mk(), mk()];
    this.gainSmooth = [mk(), mk(), mk(), mk()];
    for (let i = 0; i < FM_DESCRIPTOR.params.length; i++) {
      this.params[i] = FM_DESCRIPTOR.params[i]?.default ?? 0;
    }
    this.applyRouting();
    this.indexSmooth.snap(this.params[P_INDEX] as number);
    this.fbSmooth.snap(this.params[P_FEEDBACK] as number);
    this.snapGains();
  }

  setParam(index: number, value: number): void {
    if (index < 0 || index >= this.params.length) return;
    this.params[index] = value;
    if (index === P_ALGO) this.applyRouting();
    else if (index >= P_AMP_A) this.applyEnvelopes();
  }

  private applyRouting(): void {
    const raw = this.params[P_ALGO] as number;
    const q = raw < 0 ? 0 : raw > MAX_ALGO ? MAX_ALGO : Math.round(raw);
    this.algo = q;
    this.carrierMask = CARRIER_MASK[q] as number;
    this.applyEnvelopes();
  }

  /** Carriers follow the amp ADSR, modulators the brightness ADSR. */
  private configure(env: Envelope, bit: number): void {
    const base = (this.carrierMask & bit) !== 0 ? P_AMP_A : P_MOD_A;
    env.set(
      this.params[base] as number,
      this.params[base + 1] as number,
      this.params[base + 2] as number,
      this.params[base + 3] as number,
    );
  }

  private applyEnvelopes(): void {
    this.configure(this.envA, 1);
    this.configure(this.envB, 2);
    this.configure(this.envC, 4);
    this.configure(this.envD, 8);
  }

  /** Block-rate work: operator increments, levels, carrier balance, key scaling. */
  private updateBlock(): void {
    const spread = this.params[P_SPREAD] as number;
    for (let k = 0; k < N_OPS; k++) {
      const b = P_OP_BASE + k * P_OP_STRIDE;
      const ratio = quantizeRatio(this.params[b] as number);
      const semis = (this.params[b + 1] as number) + (SPREAD_SEMIS[k] as number) * spread;
      const f = (this.baseFreq * ratio * Math.pow(2, semis / 12)) / this.sr;
      this.inc[k] = f > 0.45 ? 0.45 : f;
      this.level[k] = this.params[b + 2] as number;
    }

    const ks = Math.pow(REF_HZ / this.baseFreq, this.params[P_KEY_SCALE] as number);
    this.keyScale = ks < 0.15 ? 0.15 : ks > 2.5 ? 2.5 : ks;

    const mask = this.carrierMask;
    let n = 0;
    for (let k = 0; k < N_OPS; k++) if ((mask & (1 << k)) !== 0) n++;
    const tilt = this.params[P_BALANCE] as number;
    let rank = 0;
    for (let k = 0; k < N_OPS; k++) {
      if ((mask & (1 << k)) === 0) {
        this.carrierGain[k] = 0;
        continue;
      }
      const p = n > 1 ? rank / (n - 1) : 0;
      this.carrierGain[k] = (1 - tilt) * (1 - 0.85 * p) + tilt * (0.15 + 0.85 * p);
      rank++;
    }
  }

  /** Levels and carrier balance run through smoothers so drags cannot step the
   *  gain at block edges; a fresh note snaps them so it starts at its target
   *  instead of gliding in from a stolen voice's stale state. */
  private snapGains(): void {
    this.updateBlock();
    const ls = this.levelSmooth;
    const gs = this.gainSmooth;
    ls[0].snap(this.level[0] as number); gs[0].snap(this.carrierGain[0] as number);
    ls[1].snap(this.level[1] as number); gs[1].snap(this.carrierGain[1] as number);
    ls[2].snap(this.level[2] as number); gs[2].snap(this.carrierGain[2] as number);
    ls[3].snap(this.level[3] as number); gs[3].snap(this.carrierGain[3] as number);
  }

  noteOn(freq: number, velocity: number, voiceIndex: number): void {
    this.baseFreq = freq > 1 ? freq : 1;
    this.velocity = velocity;
    this.active = true;
    const off = (voiceIndex * 0.113) % 1;
    this.ph0 = off;
    this.ph1 = (off + 0.017) % 1;
    this.ph2 = (off + 0.041) % 1;
    this.ph3 = (off + 0.073) % 1;
    this.fbZ1 = 0;
    this.fbZ2 = 0;
    this.applyRouting();
    this.envA.trigger();
    this.envB.trigger();
    this.envC.trigger();
    this.envD.trigger();
    this.indexSmooth.snap(this.params[P_INDEX] as number);
    this.fbSmooth.snap(this.params[P_FEEDBACK] as number);
    this.snapGains();
  }

  noteOff(): void {
    this.envA.release();
    this.envB.release();
    this.envC.release();
    this.envD.release();
  }

  /** Finished once every carrier envelope has run out; modulators do not
   *  hold a voice open because they make no sound of their own. */
  isFinished(): boolean {
    if (!this.active) return false;
    const m = this.carrierMask;
    if ((m & 1) !== 0 && !this.envA.isFinished()) return false;
    if ((m & 2) !== 0 && !this.envB.isFinished()) return false;
    if ((m & 4) !== 0 && !this.envC.isFinished()) return false;
    if ((m & 8) !== 0 && !this.envD.isFinished()) return false;
    return true;
  }

  render(out: Float32Array, offset: number, count: number): void {
    if (!this.active) return;
    this.updateBlock();

    const i0 = this.inc[0] as number;
    const i1 = this.inc[1] as number;
    const i2 = this.inc[2] as number;
    const i3 = this.inc[3] as number;
    const ls = this.levelSmooth;
    const gs = this.gainSmooth;
    const algo = this.algo;
    const ks = this.keyScale;
    const amp = this.velocity * 0.32;

    this.indexSmooth.setTarget(this.params[P_INDEX] as number);
    this.fbSmooth.setTarget(this.params[P_FEEDBACK] as number);
    ls[0].setTarget(this.level[0] as number); gs[0].setTarget(this.carrierGain[0] as number);
    ls[1].setTarget(this.level[1] as number); gs[1].setTarget(this.carrierGain[1] as number);
    ls[2].setTarget(this.level[2] as number); gs[2].setTarget(this.carrierGain[2] as number);
    ls[3].setTarget(this.level[3] as number); gs[3].setTarget(this.carrierGain[3] as number);

    for (let n = 0; n < count; n++) {
      const e0 = this.envA.next();
      const e1 = this.envB.next();
      const e2 = this.envC.next();
      const e3 = this.envD.next();
      const index = this.indexSmooth.next() * ks;
      const l0 = ls[0].next(); const l1 = ls[1].next();
      const l2 = ls[2].next(); const l3 = ls[3].next();
      const g0 = gs[0].next(); const g1 = gs[1].next();
      const g2 = gs[2].next(); const g3 = gs[3].next();

      this.ph0 += i0; if (this.ph0 >= 1) this.ph0 -= 1;
      this.ph1 += i1; if (this.ph1 >= 1) this.ph1 -= 1;
      this.ph2 += i2; if (this.ph2 >= 1) this.ph2 -= 1;
      this.ph3 += i3; if (this.ph3 >= 1) this.ph3 -= 1;

      const fbArg = softClip((this.fbZ1 + this.fbZ2) * 0.5) * this.fbSmooth.next() * Math.PI;
      const m3 = Math.sin(this.ph3 * TAU + fbArg) * l3 * e3;
      this.fbZ2 = this.fbZ1 < DENORM && this.fbZ1 > -DENORM ? 0 : this.fbZ1;
      this.fbZ1 = m3 < DENORM && m3 > -DENORM ? 0 : m3;

      let y = 0;
      // Review finding 2026-08-18: operator 4 (the feedback op) was computed
      // every sample but never READ in algos 0/1, and `index` was absent from
      // algo 3 — so the Grit macro was silent on two algorithms and Air on a
      // third. Every algorithm now routes both.
      if (algo === 0) {
        // 2-stack, with op4 shading the modulator: op4 -> op2 -> op1
        const m1 = Math.sin(this.ph1 * TAU + m3 * index) * l1 * e1 * index;
        y = Math.sin(this.ph0 * TAU + m1) * l0 * e0 * g0;
      } else if (algo === 1) {
        // 3-stack: op4 -> op3 -> op2 -> op1
        const m2 = Math.sin(this.ph2 * TAU + m3 * index) * l2 * e2 * index;
        const m1 = Math.sin(this.ph1 * TAU + m2) * l1 * e1 * index;
        y = Math.sin(this.ph0 * TAU + m1) * l0 * e0 * g0;
      } else if (algo === 2) {
        const m1 = Math.sin(this.ph1 * TAU) * l1 * e1 * index;
        y = Math.sin(this.ph0 * TAU + m1) * l0 * e0 * g0
          + Math.sin(this.ph2 * TAU + m3 * index) * l2 * e2 * g2;
      } else if (algo === 3) {
        // Parallel carriers, all shaded by op4 scaled by index, so both the
        // Air and Grit macros are audible here rather than dead.
        const shade = m3 * index * 0.5;
        y = Math.sin(this.ph0 * TAU + shade) * l0 * e0 * g0
          + Math.sin(this.ph1 * TAU + shade * 1.4) * l1 * e1 * g1
          + Math.sin(this.ph2 * TAU + shade * 0.7) * l2 * e2 * g2
          + m3 * g3;
      } else {
        const m2 = Math.sin(this.ph2 * TAU) * l2 * e2 * index;
        y = Math.sin(this.ph0 * TAU + m2) * l0 * e0 * g0
          + Math.sin(this.ph1 * TAU + m3 * index) * l1 * e1 * g1;
      }

      const s = y * amp;
      out[offset + n] = (out[offset + n] as number) + (s === s ? s : 0);
    }
  }
}

export const FmEngine: EngineModule = {
  descriptor: FM_DESCRIPTOR,
  allocVoice: (sampleRate: number): EngineVoice => new FmVoice(sampleRate),
};
