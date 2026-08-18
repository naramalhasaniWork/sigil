import type { EngineModule, EngineVoice } from '@/audio/types';
import { ANALOG_DESCRIPTOR } from './analog-descriptor';
import { blep } from './blep';
import { createFilter, type Filter } from './filters';
import { Envelope } from './envelope';
import { Smoother } from './smoothing';
import { Lfo } from './lfo';

const P_DETUNE = 0, P_DRIFT = 1, P_CUTOFF = 2, P_RES = 3, P_FILTER_ENV = 4;
const P_ATTACK = 5, P_DECAY = 6, P_SUSTAIN = 7, P_RELEASE = 8, P_DRIVE = 9;
const P_WAVE1 = 10, P_WAVE2 = 11, P_PW = 12, P_MIX = 13;
const P_SUB_MODE = 14, P_SUB_LEVEL = 15, P_NOISE = 16;
const P_UNISON = 17, P_SPREAD = 18, P_GLIDE = 19;
const P_KEYTRACK = 20, P_MODEL = 21, P_VEL_CUT = 22, P_VEL_AMP = 23, P_CURVE = 24;
const P_LFO_RATE = 25, P_LFO_SHAPE = 26, P_LFO_DELAY = 27, P_LFO_SYNC = 28;
const P_LFO_PITCH = 29, P_LFO_CUT = 30, P_LFO_PW = 31, P_LFO_AMP = 32;

const TWO_PI = 6.283185307179586;
const LN2 = 0.6931471805599453;
/** One cent as a fractional frequency change; exact enough under 100 cents. */
const CENT = 5.7762265e-4;
/** log2(261.6256) — middle C, the note key tracking pivots around. */
const LOG2_REF = 8.0312500;
const DENORMAL = 1e-20;
/**
 * Modulation runs once per this many samples (6 kHz at 48 k). Pitch, cutoff,
 * pulse width and the LFO all move far slower than audio, and computing them
 * per sample costs an exp() and a tan() per voice for nothing audible.
 */
const CONTROL_STEP = 8;
const MAX_UNISON = 4;
/** Leaky-integrated square lands at ~0.245 peak whatever the pitch. */
const TRI_SCALE = 4.083;
const OSC_GAIN = 0.8;
const VOICE_GAIN = 0.35;

/** Cheap rational tanh — monotonic, bounded, shaped for hot loops. */
function saturate(x: number): number {
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/**
 * Bends a 0..1 envelope without moving its endpoints. k < 0 is concave (snappy
 * exponential decay, the shape of a plucked string), k > 0 is convex (slow,
 * even, the shape of a swell). One divide, no pow().
 */
function bend(v: number, k: number): number {
  return (v * (1 + k)) / (1 + k * v);
}

class AnalogVoice implements EngineVoice {
  private readonly ladder: Filter;
  private readonly svf: Filter;
  private readonly diode: Filter;
  private active_filter: Filter;
  private readonly ampEnv: Envelope;
  private readonly filterEnv: Envelope;
  private readonly cutoffSmooth: Smoother;
  private readonly lfo: Lfo;

  private readonly params = new Float32Array(ANALOG_DESCRIPTOR.params.length);
  private readonly ph1 = new Float64Array(MAX_UNISON);
  private readonly ph2 = new Float64Array(MAX_UNISON);
  private readonly tri1 = new Float64Array(MAX_UNISON);
  private readonly tri2 = new Float64Array(MAX_UNISON);
  private readonly inc1 = new Float64Array(MAX_UNISON);
  private readonly inc2 = new Float64Array(MAX_UNISON);
  private readonly driftPhase = new Float64Array(MAX_UNISON);
  private readonly driftInc = new Float64Array(MAX_UNISON);
  /** Detune positions per unison count, row-major: (count - 1) * 4 + slot. */
  private readonly spread = new Float64Array(MAX_UNISON * MAX_UNISON);

  private readonly invSr: number;
  private readonly maxFreq: number;
  private uni = 1;
  private uniGain = 1;
  private subPhase = 0;
  private subInc = 0;
  private subRatio = 0.5;
  private detuneMul = 1;
  private noiseState = 0x9e3779b9 | 0;
  private ctrl = 0;
  private pw = 0.5;
  private ampMod = 1;
  private envK = 0;
  private logFreq = 7.78;
  private logTarget = 7.78;
  private glideCoeff = 1;
  private velocity = 1;
  private active = false;

  constructor(sampleRate: number) {
    this.invSr = 1 / sampleRate;
    this.maxFreq = sampleRate * 0.45;
    this.ladder = createFilter('ladder', sampleRate);
    this.svf = createFilter('svf', sampleRate);
    this.diode = createFilter('diode', sampleRate);
    this.active_filter = this.ladder;
    this.ampEnv = new Envelope(sampleRate);
    this.filterEnv = new Envelope(sampleRate);
    // Smoother and LFO tick at control rate, so they are told that rate.
    this.cutoffSmooth = new Smoother(sampleRate / CONTROL_STEP, 8);
    this.lfo = new Lfo(sampleRate / CONTROL_STEP);
    for (let i = 0; i < this.params.length; i++) {
      this.params[i] = ANALOG_DESCRIPTOR.params[i]?.default ?? 0;
    }
    this.spread[4] = -1; this.spread[5] = 1;
    this.spread[8] = -1; this.spread[10] = 1;
    this.spread[12] = -1; this.spread[13] = -0.34;
    this.spread[14] = 0.34; this.spread[15] = 1;
    this.applyEnvelopes();
    this.applyLfo();
    this.cutoffSmooth.snap(this.params[P_CUTOFF] as number);
  }

  setParam(index: number, value: number): void {
    if (index < 0 || index >= this.params.length) return;
    this.params[index] = value;
    if (index >= P_ATTACK && index <= P_RELEASE) this.applyEnvelopes();
    else if (index === P_CURVE) this.envK = (value - 0.5) * 1.6;
    else if (index >= P_LFO_RATE && index <= P_LFO_DELAY) this.applyLfo();
  }

  private applyEnvelopes(): void {
    const a = this.params[P_ATTACK] as number;
    const d = this.params[P_DECAY] as number;
    const s = this.params[P_SUSTAIN] as number;
    const r = this.params[P_RELEASE] as number;
    this.ampEnv.set(a, d, s, r);
    this.filterEnv.set(a, d * 0.8, s * 0.5, r);
  }

  private applyLfo(): void {
    this.lfo.setRate(this.params[P_LFO_RATE] as number);
    this.lfo.setShape(this.params[P_LFO_SHAPE] as number);
    this.lfo.setDelayMs(this.params[P_LFO_DELAY] as number);
  }

  noteOn(freq: number, velocity: number, voiceIndex: number): void {
    const p = this.params;
    const f = freq > 8 ? (freq < 12000 ? freq : 12000) : 8;
    const target = Math.log2(f);
    const glideMs = p[P_GLIDE] as number;
    // A voice that has never sounded has nothing to glide from.
    if (!this.active || !(glideMs > 0)) this.logFreq = target;
    this.logTarget = target;
    const steps = Math.max(1, (glideMs / 1000) * this.invSr === 0 ? 1 : (glideMs / 1000) / (this.invSr * CONTROL_STEP));
    this.glideCoeff = glideMs > 0 ? 1 - Math.exp(-1 / (steps / 4)) : 1;

    this.velocity = velocity > 0 ? (velocity < 1 ? velocity : 1) : 0;
    this.envK = ((p[P_CURVE] as number) - 0.5) * 1.6;
    const n = Math.round(p[P_UNISON] as number);
    this.uni = n < 1 ? 1 : n > MAX_UNISON ? MAX_UNISON : n;
    this.uniGain = 1 / Math.sqrt(this.uni);

    for (let u = 0; u < MAX_UNISON; u++) {
      // Staggered start phases: unison copies that begin together sound like
      // one loud oscillator until they drift apart.
      this.ph1[u] = ((voiceIndex * 0.137 + u * 0.618) % 1 + 1) % 1;
      this.ph2[u] = ((voiceIndex * 0.311 + u * 0.382) % 1 + 1) % 1;
      this.tri1[u] = 0;
      this.tri2[u] = 0;
      this.driftPhase[u] = ((voiceIndex * 0.37 + u * 0.211) % 1 + 1) % 1;
      this.driftInc[u] = (0.11 + u * 0.041 + (voiceIndex % 4) * 0.017) * this.invSr * CONTROL_STEP;
    }
    this.subPhase = 0;
    this.noiseState = ((voiceIndex + 1) * 0x6d2b79f5) | 0;
    if (this.noiseState === 0) this.noiseState = 0x9e3779b9 | 0;

    this.ladder.reset();
    this.svf.reset();
    this.diode.reset();
    this.applyEnvelopes();
    this.applyLfo();
    this.lfo.seed(voiceIndex);
    this.lfo.trigger((p[P_LFO_SYNC] as number) >= 0.5);
    this.ampEnv.trigger();
    this.filterEnv.trigger();
    this.cutoffSmooth.snap(p[P_CUTOFF] as number);
    this.ctrl = 0;
    this.active = true;
  }

  noteOff(): void {
    this.ampEnv.release();
    this.filterEnv.release();
  }

  /**
   * True only once a note has been triggered and its amp envelope has run out.
   * A freshly allocated voice reports false; VoiceManager only asks about
   * slots it has marked busy, so that is correct but worth knowing.
   */
  isFinished(): boolean {
    return this.active && this.ampEnv.isFinished();
  }

  /** One antialiased oscillator sample; `tri` carries the integrator state. */
  private oscSample(
    shape: number, ph: Float64Array, tri: Float64Array,
    u: number, inc: number, pw: number,
  ): number {
    let p = (ph[u] as number) + inc;
    if (p >= 1) p -= 1;
    ph[u] = p;
    if (shape <= 0) return 2 * p - 1 - blep(p, inc);
    if (shape >= 3) return Math.sin(p * TWO_PI);
    // A pulse is two BLEP-corrected saws offset by the width; the offset
    // cancels the DC exactly, so no correction term is needed.
    const w = shape === 1 ? pw : 0.5;
    let q = p + w;
    if (q >= 1) q -= 1;
    const sq = (2 * p - 1 - blep(p, inc)) - (2 * q - 1 - blep(q, inc));
    if (shape === 1) return sq;
    // Triangle: leaky-integrate the square. Integration rolls off whatever
    // aliasing survived the square by another 6 dB per octave for free.
    let t = (tri[u] as number) * (1 - inc) + inc * sq;
    if (t < DENORMAL && t > -DENORMAL) t = 0;
    tri[u] = t;
    return t * TRI_SCALE;
  }

  private subSample(sine: boolean): number {
    let p = this.subPhase + this.subInc;
    if (p >= 1) p -= 1;
    this.subPhase = p;
    if (sine) return Math.sin(p * TWO_PI);
    let q = p + 0.5;
    if (q >= 1) q -= 1;
    return (2 * p - 1 - blep(p, this.subInc)) - (2 * q - 1 - blep(q, this.subInc));
  }

  /** Seeded xorshift32 — deterministic per voice, unlike Math.random. */
  private noise(): number {
    let s = this.noiseState;
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    this.noiseState = s;
    return (s >>> 0) / 2147483648 - 1;
  }

  /** Everything that moves slower than audio, recomputed once per control step. */
  private updateControl(): void {
    const p = this.params;
    const lfoV = this.lfo.next();
    this.logFreq += this.glideCoeff * (this.logTarget - this.logFreq);

    const vib = (p[P_LFO_PITCH] as number) * (p[P_LFO_PITCH] as number) * lfoV;
    const base = Math.exp(LN2 * (this.logFreq + vib));
    const driftAmt = (p[P_DRIFT] as number) * 0.012;
    const spreadAmt = (p[P_SPREAD] as number) * 30 * CENT;
    const row = (this.uni - 1) * MAX_UNISON;
    const max = this.maxFreq;
    for (let u = 0; u < this.uni; u++) {
      let dp = (this.driftPhase[u] as number) + (this.driftInc[u] as number);
      if (dp >= 1) dp -= 1;
      this.driftPhase[u] = dp;
      const dev = Math.sin(dp * TWO_PI) * driftAmt + (this.spread[row + u] as number) * spreadAmt;
      const f1 = base * (1 + dev);
      const f2 = base * this.detuneMul * (1 - dev);
      this.inc1[u] = (f1 > max ? max : f1 < 0.01 ? 0.01 : f1) * this.invSr;
      this.inc2[u] = (f2 > max ? max : f2 < 0.01 ? 0.01 : f2) * this.invSr;
    }
    const fs = base * this.subRatio;
    this.subInc = (fs > max ? max : fs < 0.01 ? 0.01 : fs) * this.invSr;

    let fenv = 0;
    for (let s = 0; s < CONTROL_STEP; s++) fenv = this.filterEnv.next();
    fenv = bend(fenv, this.envK);
    // Key track, velocity and LFO are all pitch-like: sum them in octaves and
    // pay for exactly one exp().
    const oct = (p[P_KEYTRACK] as number) * (this.logFreq - LOG2_REF)
      + (p[P_LFO_CUT] as number) * 3 * lfoV
      - (p[P_VEL_CUT] as number) * 4 * (1 - this.velocity);
    let cut = this.cutoffSmooth.next() * Math.exp(LN2 * oct)
      * (1 + (p[P_FILTER_ENV] as number) * fenv * 6);
    if (!(cut > 10)) cut = 10;
    else if (cut > max) cut = max;
    this.active_filter.setCutoff(cut);

    const w = (p[P_PW] as number) + (p[P_LFO_PW] as number) * lfoV * 0.45;
    this.pw = w < 0.06 ? 0.06 : w > 0.94 ? 0.94 : w;
    this.ampMod = 1 - (p[P_LFO_AMP] as number) * 0.5 * (1 - lfoV);
  }

  render(out: Float32Array, offset: number, count: number): void {
    if (!this.active) return;
    const p = this.params;
    const model = Math.round(p[P_MODEL] as number);
    const filter = model === 1 ? this.svf : model === 2 ? this.diode : this.ladder;
    this.active_filter = filter;
    filter.setResonance(p[P_RES] as number);

    const drive = 1 + (p[P_DRIVE] as number) * 6;
    const driveComp = 1 / Math.sqrt(drive);
    const w1 = Math.round(p[P_WAVE1] as number);
    const w2 = Math.round(p[P_WAVE2] as number);
    const mix = (p[P_MIX] as number) < 0 ? 0 : (p[P_MIX] as number) > 1 ? 1 : (p[P_MIX] as number);
    const g1 = (1 - mix) * OSC_GAIN;
    const g2 = mix * OSC_GAIN;
    const subMode = Math.round(p[P_SUB_MODE] as number);
    const subSine = subMode >= 2;
    const subLevel = (p[P_SUB_LEVEL] as number) * 0.9;
    const noiseLevel = (p[P_NOISE] as number) * 0.5;
    const velAmp = p[P_VEL_AMP] as number;
    const gain = (1 - velAmp + velAmp * this.velocity * this.velocity) * VOICE_GAIN;
    const n = this.uni;
    const k = this.envK;
    this.detuneMul = Math.exp((LN2 * (p[P_DETUNE] as number)) / 12);
    this.subRatio = (subMode & 1) === 1 ? 0.25 : 0.5;
    this.cutoffSmooth.setTarget(p[P_CUTOFF] as number);

    for (let i = 0; i < count; i++) {
      if (this.ctrl === 0) {
        this.updateControl();
        this.ctrl = CONTROL_STEP;
      }
      this.ctrl--;

      const pw = this.pw;
      let sig = 0;
      for (let u = 0; u < n; u++) {
        sig += this.oscSample(w1, this.ph1, this.tri1, u, this.inc1[u] as number, pw) * g1;
        sig += this.oscSample(w2, this.ph2, this.tri2, u, this.inc2[u] as number, pw) * g2;
      }
      sig *= this.uniGain;
      if (subLevel > 0) sig += this.subSample(subSine) * subLevel;
      if (noiseLevel > 0) sig += this.noise() * noiseLevel;
      sig = saturate(sig * drive) * driveComp;

      let y = filter.process(sig) * bend(this.ampEnv.next(), k) * gain * this.ampMod;
      // Catches NaN and infinity alike: a failed comparison falls to zero.
      if (!(y > -4 && y < 4)) y = y > 0 ? 4 : y < 0 ? -4 : 0;
      out[offset + i] = (out[offset + i] as number) + y;
    }
  }
}

export const AnalogEngine: EngineModule = {
  descriptor: ANALOG_DESCRIPTOR,
  allocVoice: (sampleRate: number): EngineVoice => new AnalogVoice(sampleRate),
};
