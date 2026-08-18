import type { EngineModule, EngineVoice } from '@/audio/types';
import { ANALOG_DESCRIPTOR } from './analog-descriptor';
import { createFilter, type Filter } from './filters';
import { Envelope } from './envelope';
import { Smoother } from './smoothing';
import { Lfo, addOsc, WAVE_PULSE, WAVE_SINE } from './lfo';

const P_DETUNE = 0, P_DRIFT = 1, P_CUTOFF = 2, P_RES = 3, P_FILTER_ENV = 4;
const P_ATTACK = 5, P_DECAY = 6, P_SUSTAIN = 7, P_RELEASE = 8, P_DRIVE = 9;
const P_WAVE1 = 10, P_WAVE2 = 11, P_PW = 12, P_MIX = 13;
const P_SUB_MODE = 14, P_SUB_LEVEL = 15, P_NOISE = 16;
const P_UNISON = 17, P_SPREAD = 18, P_GLIDE = 19;
const P_KEYTRACK = 20, P_MODEL = 21, P_VEL_CUT = 22, P_VEL_AMP = 23, P_CURVE = 24;
const P_LFO_RATE = 25, P_LFO_SHAPE = 26, P_LFO_DELAY = 27, P_LFO_SYNC = 28;
const P_LFO_PITCH = 29, P_LFO_CUT = 30, P_LFO_PW = 31, P_LFO_AMP = 32;

const LN2 = 0.6931471805599453;
const TWO_PI = 6.283185307179586;
/** One cent as a fractional frequency change; exact enough under 100 cents. */
const CENT = 5.7762265e-4;
/** log2(261.6256) — middle C, the note key tracking pivots around. */
const LOG2_REF = 8.0312500;
/**
 * Modulation runs once per this many samples (6 kHz at 48 k). Pitch, cutoff,
 * pulse width and the LFO move far slower than audio; recomputing them per
 * sample costs an exp() and a tan() per voice for nothing audible.
 */
const CONTROL_STEP = 8;
const MAX_UNISON = 4;
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
  private activeFilter: Filter;
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
  /** Oscillator sum for one control step, before filter and amplifier. */
  private readonly mix = new Float64Array(CONTROL_STEP);

  private readonly invSr: number;
  private readonly ctrlRate: number;
  private readonly maxFreq: number;
  private uni = 1;
  private uniGain = 1;
  private readonly subPh = new Float64Array(1);
  private readonly subTri = new Float64Array(1);
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
    this.ctrlRate = sampleRate / CONTROL_STEP;
    this.maxFreq = sampleRate * 0.45;
    this.ladder = createFilter('ladder', sampleRate);
    this.svf = createFilter('svf', sampleRate);
    this.diode = createFilter('diode', sampleRate);
    this.activeFilter = this.ladder;
    this.ampEnv = new Envelope(sampleRate);
    this.filterEnv = new Envelope(this.ctrlRate);
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
    const p = this.params;
    const a = p[P_ATTACK] as number, d = p[P_DECAY] as number;
    const s = p[P_SUSTAIN] as number, r = p[P_RELEASE] as number;
    this.ampEnv.set(a, d, s, r);
    // The filter closes a little ahead of the amplitude and sits lower: a note
    // that dulls as it fades is what an acoustic instrument does.
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
    const steps = Math.max(1, (glideMs / 1000) * this.ctrlRate);
    this.glideCoeff = glideMs > 0 ? 1 - Math.exp(-4 / steps) : 1;

    this.velocity = velocity > 0 ? (velocity < 1 ? velocity : 1) : 0;
    this.envK = ((p[P_CURVE] as number) - 0.5) * 1.6;
    const n = Math.round(p[P_UNISON] as number);
    this.uni = n < 1 ? 1 : n > MAX_UNISON ? MAX_UNISON : n;
    this.uniGain = 1 / Math.sqrt(this.uni);

    for (let u = 0; u < MAX_UNISON; u++) {
      // Staggered starts: copies that begin in phase sound like one loud
      // oscillator until they happen to drift apart.
      this.ph1[u] = ((voiceIndex * 0.137 + u * 0.618) % 1 + 1) % 1;
      this.ph2[u] = ((voiceIndex * 0.311 + u * 0.382) % 1 + 1) % 1;
      this.tri1[u] = 0; this.tri2[u] = 0;
      this.driftPhase[u] = ((voiceIndex * 0.37 + u * 0.211) % 1 + 1) % 1;
      this.driftInc[u] = (0.11 + u * 0.041 + (voiceIndex % 4) * 0.017) * this.invSr * CONTROL_STEP;
    }
    this.subPh[0] = 0;
    const seed = ((voiceIndex + 1) * 0x6d2b79f5) | 0;
    this.noiseState = seed === 0 ? 0x9e3779b9 | 0 : seed;

    this.ladder.reset(); this.svf.reset(); this.diode.reset();
    this.applyEnvelopes();
    this.applyLfo();
    this.lfo.seed(voiceIndex);
    this.lfo.trigger((p[P_LFO_SYNC] as number) >= 0.5);
    this.ampEnv.trigger(); this.filterEnv.trigger();
    this.cutoffSmooth.snap(p[P_CUTOFF] as number);
    this.ctrl = 0;
    this.active = true;
  }

  noteOff(): void {
    this.ampEnv.release();
    this.filterEnv.release();
  }

  /** True once a note has been triggered and its amp envelope has run out. */
  isFinished(): boolean {
    return this.active && this.ampEnv.isFinished();
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

    const fenv = bend(this.filterEnv.next(), this.envK);
    // Key track, velocity and LFO are all pitch-like: sum them in octaves and
    // pay for exactly one exp().
    const oct = (p[P_KEYTRACK] as number) * (this.logFreq - LOG2_REF)
      + (p[P_LFO_CUT] as number) * 3 * lfoV
      - (p[P_VEL_CUT] as number) * 4 * (1 - this.velocity);
    let cut = this.cutoffSmooth.next() * Math.exp(LN2 * oct)
      * (1 + (p[P_FILTER_ENV] as number) * fenv * 6);
    if (!(cut > 10)) cut = 10;
    else if (cut > max) cut = max;
    this.activeFilter.setCutoff(cut);

    const w = (p[P_PW] as number) + (p[P_LFO_PW] as number) * lfoV * 0.45;
    this.pw = w < 0.06 ? 0.06 : w > 0.94 ? 0.94 : w;
    this.ampMod = 1 - (p[P_LFO_AMP] as number) * 0.5 * (1 - lfoV);
  }

  render(out: Float32Array, offset: number, count: number): void {
    if (!this.active) return;
    const p = this.params;
    const model = Math.round(p[P_MODEL] as number);
    const filter = model === 1 ? this.svf : model === 2 ? this.diode : this.ladder;
    this.activeFilter = filter;
    filter.setResonance(p[P_RES] as number);

    const drive = 1 + (p[P_DRIVE] as number) * 6, driveComp = 1 / Math.sqrt(drive);
    const w1 = Math.round(p[P_WAVE1] as number), w2 = Math.round(p[P_WAVE2] as number);
    const raw = p[P_MIX] as number;
    const bal = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    const g1 = (1 - bal) * OSC_GAIN * this.uniGain, g2 = bal * OSC_GAIN * this.uniGain;
    const subMode = Math.round(p[P_SUB_MODE] as number);
    const subShape = subMode >= 2 ? WAVE_SINE : WAVE_PULSE;
    const subLevel = (p[P_SUB_LEVEL] as number) * 0.9;
    const noiseLevel = (p[P_NOISE] as number) * 0.5, velAmp = p[P_VEL_AMP] as number;
    const gain = (1 - velAmp + velAmp * this.velocity * this.velocity) * VOICE_GAIN;
    const n = this.uni;
    const k = this.envK;
    this.detuneMul = Math.exp((LN2 * (p[P_DETUNE] as number)) / 12);
    this.subRatio = (subMode & 1) === 1 ? 0.25 : 0.5;
    this.cutoffSmooth.setTarget(p[P_CUTOFF] as number);

    const mix = this.mix;
    let noise = this.noiseState;
    let i = 0;
    while (i < count) {
      if (this.ctrl === 0) { this.updateControl(); this.ctrl = CONTROL_STEP; }
      const m = this.ctrl < count - i ? this.ctrl : count - i;
      const pw = this.pw;
      for (let j = 0; j < m; j++) mix[j] = 0;
      for (let u = 0; u < n; u++) {
        addOsc(w1, mix, m, this.ph1, this.tri1, u, this.inc1[u] as number, pw, g1);
        addOsc(w2, mix, m, this.ph2, this.tri2, u, this.inc2[u] as number, pw, g2);
      }
      if (subLevel > 0) {
        addOsc(subShape, mix, m, this.subPh, this.subTri, 0, this.subInc, 0.5, subLevel);
      }
      const amp = gain * this.ampMod;

      for (let j = 0; j < m; j++) {
        let sig = mix[j] as number;
        if (noiseLevel > 0) {
          noise ^= noise << 13; noise |= 0;
          noise ^= noise >>> 17;
          noise ^= noise << 5; noise |= 0;
          sig += ((noise >>> 0) / 2147483648 - 1) * noiseLevel;
        }
        sig = saturate(sig * drive) * driveComp;
        const e = this.ampEnv.next();
        let y = filter.process(sig) * (k === 0 ? e : bend(e, k)) * amp;
        // Catches NaN and infinity alike: a failed comparison falls to zero.
        if (!(y > -4 && y < 4)) y = y > 0 ? 4 : y < 0 ? -4 : 0;
        out[offset + i + j] = (out[offset + i + j] as number) + y;
      }
      i += m; this.ctrl -= m;
    }
    this.noiseState = noise;
  }
}

export const AnalogEngine: EngineModule = {
  descriptor: ANALOG_DESCRIPTOR,
  allocVoice: (sampleRate: number): EngineVoice => new AnalogVoice(sampleRate),
};
