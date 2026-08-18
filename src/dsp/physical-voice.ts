import type { EngineModule, EngineVoice } from '@/audio/types';
import { PHYSICAL_DESCRIPTOR } from './physical-descriptor';
import { LadderFilter } from './ladder';
import { Envelope } from './envelope';
import { Smoother } from './smoothing';

const P_MATERIAL = 0;
const P_STRUCTURE = 1;
const P_DECAY = 2;
const P_DAMPING = 3;
const P_POSITION = 4;
const P_AIR = 5;
const P_EXCITER = 6;
const P_GRIT = 7;
const P_HARDNESS = 8;
const P_TONE = 9;
const P_RELEASE = 10;
const P_LEVEL = 11;

const EX_MALLET = 0;
const EX_NOISE = 1;
const EX_BOW = 2;

export const MAX_MODES = 20;
const MATERIALS = 4;
const DENORMAL = 1e-20;
/** Poles are always inside the unit circle, so the bank can never run away. */
const R_MAX = 0.99997;
const LN1000 = 6.907755278982137;
const TWO_PI = 6.283185307179586;

/** Frequency ratios of the ringing modes, 20 per material. */
const RATIOS = new Float32Array([
  // membrane: circular drum head, stretched and strongly inharmonic
  1, 1.593, 2.135, 2.295, 2.653, 2.917, 3.155, 3.5, 3.598, 3.652,
  3.965, 4.06, 4.23, 4.372, 4.601, 4.831, 4.903, 5.084, 5.242, 5.412,
  // wood: bar-like, wide spacing, upper partials die almost immediately
  1, 2.9, 5.8, 8.9, 12.4, 15.9, 19.8, 23.6, 27.9, 32.1,
  36.7, 41.3, 46.3, 51.3, 56.6, 62, 67.6, 73.4, 79.3, 85.4,
  // metal: struck bell, the classic inharmonic set
  1, 2, 2.4, 3, 3.61, 4.17, 5.43, 6.8, 8.21, 9.75,
  11.4, 13.2, 15.1, 17.2, 19.4, 21.7, 24.2, 26.8, 29.5, 32.4,
  // glass: near-harmonic and slightly stretched, bright and long
  1, 2.01, 3.03, 4.06, 5.11, 6.17, 7.25, 8.35, 9.47, 10.6,
  11.8, 13, 14.2, 15.5, 16.8, 18.1, 19.5, 20.9, 22.3, 23.8,
]);
const AMP_TILT = new Float32Array([0.8, 1.15, 0.55, 0.45]);
const DECAY_TILT = new Float32Array([1.2, 1.7, 0.55, 0.35]);
const DECAY_SCALE = new Float32Array([0.55, 0.28, 1.25, 1.5]);

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x === x ? x : lo;
}

class PhysicalVoice implements EngineVoice {
  private readonly a1 = new Float32Array(MAX_MODES);
  private readonly a2 = new Float32Array(MAX_MODES);
  private readonly b0 = new Float32Array(MAX_MODES);
  private readonly y1 = new Float32Array(MAX_MODES);
  private readonly y2 = new Float32Array(MAX_MODES);
  private readonly params = new Float32Array(PHYSICAL_DESCRIPTOR.params.length);

  private readonly excEnv: Envelope;
  private readonly excFilter: LadderFilter;
  private readonly driveSmooth: Smoother;
  private readonly sr: number;

  private activeModes = 0;
  private bowScale = 1;
  private baseFreq = 220;
  private velocity = 1;
  private active = false;
  private dirty = true;
  private needsSnap = true;
  private quietBlocks = 0;
  private rng = 22222;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.excEnv = new Envelope(sampleRate);
    this.excFilter = new LadderFilter(sampleRate);
    this.driveSmooth = new Smoother(sampleRate, 12);
    for (let i = 0; i < this.params.length; i++) {
      this.params[i] = PHYSICAL_DESCRIPTOR.params[i]?.default ?? 0;
    }
    this.applyExciter();
  }

  setParam(index: number, value: number): void {
    if (index < 0 || index >= this.params.length) return;
    this.params[index] = value;
    this.dirty = true;
    if (index === P_EXCITER || index === P_HARDNESS || index === P_RELEASE) {
      this.applyExciter();
    }
  }

  private applyExciter(): void {
    const type = Math.round(clamp(this.params[P_EXCITER] as number, 0, 2));
    const hard = clamp(this.params[P_HARDNESS] as number, 0.2, 80);
    const rel = clamp(this.params[P_RELEASE] as number, 5, 2000);
    if (type === EX_BOW) {
      this.excEnv.set(8 + hard * 3, 60, 1, rel);
    } else if (type === EX_NOISE) {
      this.excEnv.set(0.5 + hard * 0.4, hard * 2.5, 0, hard);
    } else {
      this.excEnv.set(0.2 + hard * 0.3, hard, 0, hard);
    }
  }

  /** Recomputes the whole modal bank. Never runs inside the sample loop. */
  private updateModes(): void {
    this.dirty = false;
    const morph = clamp(this.params[P_MATERIAL] as number, 0, 1) * (MATERIALS - 1);
    let i0 = Math.floor(morph);
    if (i0 > MATERIALS - 2) i0 = MATERIALS - 2;
    if (i0 < 0) i0 = 0;
    const f = morph - i0;
    const o0 = i0 * MAX_MODES;
    const o1 = o0 + MAX_MODES;
    const ampTilt = (AMP_TILT[i0] as number) + ((AMP_TILT[i0 + 1] as number) - (AMP_TILT[i0] as number)) * f;
    const decTilt = (DECAY_TILT[i0] as number) + ((DECAY_TILT[i0 + 1] as number) - (DECAY_TILT[i0] as number)) * f;
    const decScale = (DECAY_SCALE[i0] as number) + ((DECAY_SCALE[i0 + 1] as number) - (DECAY_SCALE[i0] as number)) * f;

    const stretch = clamp(this.params[P_STRUCTURE] as number, 0, 1);
    const damping = clamp(this.params[P_DAMPING] as number, 0, 1);
    const air = clamp(this.params[P_AIR] as number, 0, 1);
    const pos = clamp(this.params[P_POSITION] as number, 0.02, 0.98);
    const t60 = (clamp(this.params[P_DECAY] as number, 20, 3000) / 1000) * (1 - 0.55 * damping);
    const decayExp = decTilt + damping * 1.6;
    const ampExp = (air - 0.5) * 1.4;
    const nyquist = this.sr * 0.47;
    const wScale = TWO_PI / this.sr;
    let want = 3 + Math.round(air * (MAX_MODES - 3));
    if (want > MAX_MODES) want = MAX_MODES;

    let count = 0;
    let gainSum = 0;
    let noisePower = 0;
    for (let k = 0; k < want; k++) {
      const base = (RATIOS[o0 + k] as number) + ((RATIOS[o1 + k] as number) - (RATIOS[o0 + k] as number)) * f;
      const ratio = base * (1 + stretch * 0.05 * (base - 1));
      const freq = this.baseFreq * ratio;
      if (freq >= nyquist || freq < 5) break;
      const w = freq * wScale;
      const t60k = clamp(t60 * decScale * Math.pow(ratio, -decayExp), 0.002, 8);
      let r = Math.exp(-LN1000 / (t60k * this.sr));
      if (!(r > 0)) r = 0;
      if (r > R_MAX) r = R_MAX;
      const gain = Math.pow(k + 1, -ampTilt) * Math.pow(ratio, ampExp) *
        (0.12 + 0.88 * Math.abs(Math.sin(Math.PI * pos * ratio)));
      this.a1[k] = 2 * r * Math.cos(w);
      this.a2[k] = -r * r;
      this.b0[k] = gain * Math.sin(w);
      gainSum += gain;
      noisePower += (gain * gain) / (4 * (1 - r));
      count = k + 1;
    }

    // More modes share the same total drive, so the sum of their peaks stays
    // roughly level as Air opens the bank up.
    const norm = (1.2 * Math.sqrt((count + 1) / 8)) / (0.001 + gainSum);
    for (let k = 0; k < count; k++) this.b0[k] = (this.b0[k] as number) * norm;
    for (let k = count; k < MAX_MODES; k++) {
      this.b0[k] = 0;
      this.y1[k] = 0;
      this.y2[k] = 0;
    }
    this.activeModes = count;
    // Bounds continuous (bowed) excitation: predicted steady output stays < 1
    // however lightly damped the bank is, so it can never build up forever.
    this.bowScale = 1.8 / (0.05 + norm * Math.sqrt(noisePower));
  }

  private resetModes(): void {
    for (let k = 0; k < MAX_MODES; k++) {
      this.y1[k] = 0;
      this.y2[k] = 0;
    }
  }

  noteOn(freq: number, velocity: number, voiceIndex: number): void {
    this.baseFreq = clamp(freq, 8, this.sr * 0.4);
    this.velocity = clamp(velocity, 0, 1);
    this.active = true;
    this.dirty = true;
    this.needsSnap = true;
    this.quietBlocks = 0;
    this.rng = 22222 + voiceIndex * 7919;
    this.resetModes();
    this.excFilter.reset();
    this.applyExciter();
    this.excEnv.trigger();
  }

  noteOff(): void {
    this.excEnv.release();
  }

  isFinished(): boolean {
    return this.active && this.quietBlocks >= 3;
  }

  render(out: Float32Array, offset: number, count: number): void {
    if (!this.active) return;
    if (this.dirty) this.updateModes();

    const a1 = this.a1;
    const a2 = this.a2;
    const b0 = this.b0;
    const y1 = this.y1;
    const y2 = this.y2;
    const n = this.activeModes;

    const type = Math.round(clamp(this.params[P_EXCITER] as number, 0, 2));
    const grit = clamp(this.params[P_GRIT] as number, 0, 1);
    const air = clamp(this.params[P_AIR] as number, 0, 1);
    const tone = clamp(this.params[P_TONE] as number, 200, 16000);
    const dc = type === EX_MALLET ? 1 : type === EX_NOISE ? 0.2 : 0;
    const noiseAmt = type === EX_MALLET ? grit * 0.7 : 1;
    // A longer contact pumps proportionally more energy in, so hardness would
    // otherwise double as a volume knob.
    const rootTau = Math.sqrt((clamp(this.params[P_HARDNESS] as number, 0.2, 80) * this.sr) / 4000);
    const drive = type === EX_BOW ? this.bowScale
      : type === EX_NOISE ? 2.2 / (1 + 0.35 * rootTau)
      : 1.6 / (1 + 0.9 * rootTau);
    const level = clamp(this.params[P_LEVEL] as number, 0, 1) * this.velocity * 0.34;

    this.excFilter.setCutoff(tone * (0.35 + 1.2 * grit) * (0.55 + air));
    this.excFilter.setResonance(grit * 0.25);
    this.driveSmooth.setTarget(drive);
    if (this.needsSnap) {
      this.driveSmooth.snap(drive);
      this.needsSnap = false;
    }

    let rs = this.rng;
    let peak = 0;
    let excPeak = 0;
    for (let i = 0; i < count; i++) {
      rs ^= rs << 13;
      rs ^= rs >>> 17;
      rs ^= rs << 5;
      const noise = rs * 4.656612873077393e-10;

      const e = this.excEnv.next();
      if (e > excPeak) excPeak = e;
      const x = this.excFilter.process((dc + noiseAmt * noise) * e) * this.driveSmooth.next();

      let acc = 0;
      for (let m = 0; m < n; m++) {
        const y = (b0[m] as number) * x + (a1[m] as number) * (y1[m] as number) +
          (a2[m] as number) * (y2[m] as number);
        y2[m] = y1[m] as number;
        y1[m] = y;
        acc += y;
      }
      if (acc !== acc) {
        this.resetModes();
        acc = 0;
      }
      const mag = acc < 0 ? -acc : acc;
      if (mag > peak) peak = mag;

      const v = Math.tanh(acc * level) * 0.9;
      out[offset + i] = (out[offset + i] as number) + v;
    }

    // Denormal state costs hundreds of cycles per sample on x86, so the whole
    // bank is flushed to true zero once a block rather than sample by sample.
    for (let m = 0; m < n; m++) {
      if ((y1[m] as number) < DENORMAL && (y1[m] as number) > -DENORMAL) y1[m] = 0;
      if ((y2[m] as number) < DENORMAL && (y2[m] as number) > -DENORMAL) y2[m] = 0;
    }

    this.rng = rs;
    if (peak < 1e-4 && excPeak < 1e-4) this.quietBlocks++;
    else this.quietBlocks = 0;
  }
}

export const PhysicalEngine: EngineModule = {
  descriptor: PHYSICAL_DESCRIPTOR,
  allocVoice: (sampleRate: number): EngineVoice => new PhysicalVoice(sampleRate),
};
