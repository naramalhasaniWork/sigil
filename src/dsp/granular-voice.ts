import type { EngineModule, EngineVoice } from '@/audio/types';
import { GRANULAR_DESCRIPTOR } from './granular-descriptor';
import { SawOscillator } from './blep';
import { LadderFilter } from './ladder';
import { Envelope } from './envelope';
import { Smoother } from './smoothing';

const P_DENSITY = 0;
const P_SIZE = 1;
const P_POSITION = 2;
const P_SPRAY = 3;
const P_PITCH_SCATTER = 4;
const P_REVERSE = 5;
const P_WINDOW = 6;
const P_ATTACK = 7;
const P_DECAY = 8;
const P_SUSTAIN = 9;
const P_RELEASE = 10;

const MAX_GRAINS = 32;
const DENORMAL = 1e-20;
const TWO_PI = 6.283185307179586;

/** The shared source material: 3 seconds rendered once, at this rate. */
const SOURCE_SR = 48000;
const SOURCE_SECONDS = 3;
/** Pitch the source was written at; grain playback rate is relative to it. */
const SOURCE_ROOT_HZ = 110;

/** Half a raised cosine, sampled once, used to build every grain window. */
const RISE_STEPS = 1024;
const RISE = new Float32Array(RISE_STEPS + 1);
for (let i = 0; i <= RISE_STEPS; i++) {
  RISE[i] = 0.5 - 0.5 * Math.cos((Math.PI * i) / RISE_STEPS);
}

function rise(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const f = x * RISE_STEPS;
  const i = f | 0;
  const a = RISE[i] as number;
  const b = RISE[i + 1] as number;
  return a + (b - a) * (f - i);
}

/** Tukey window: flat top, raised-cosine shoulders; taper 0.5 is a plain Hann.
 * The taper never reaches 0 — a rectangular grain window clicks every grain. */
function grainWindow(phase: number, taper: number): number {
  if (phase <= 0 || phase >= 1) return 0;
  if (phase < taper) return rise(phase / taper);
  if (phase > 1 - taper) return rise((1 - phase) / taper);
  return 1;
}

/** Cheap rational tanh — monotonic, so dense clouds stay in the rails. */
function saturate(x: number): number {
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

let sourceBuffer: Float32Array | null = null;

/** Detuned saws plus swept filtered noise. Built once per process and shared by
 * every voice: per-voice buffers would allocate megabytes on every note. */
function getSource(): Float32Array {
  if (sourceBuffer) return sourceBuffer;
  const len = SOURCE_SR * SOURCE_SECONDS;
  const buf = new Float32Array(len);
  const s1 = new SawOscillator(SOURCE_SR), s2 = new SawOscillator(SOURCE_SR);
  const s3 = new SawOscillator(SOURCE_SR), noiseFilter = new LadderFilter(SOURCE_SR);
  noiseFilter.setResonance(0.3);
  let rng = 0x9e3779b9;
  let peak = 1e-9;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const wob = Math.sin(t * TWO_PI * 3) * 0.004;
    s1.setFrequency(SOURCE_ROOT_HZ);
    s2.setFrequency(SOURCE_ROOT_HZ * (1.006 + wob));
    s3.setFrequency(SOURCE_ROOT_HZ * 2 * (0.994 - wob));
    rng ^= rng << 13; rng >>>= 0; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0;
    const noise = (rng / 4294967296) * 2 - 1;
    noiseFilter.setCutoff(300 * Math.pow(2, 4.5 * (0.5 - 0.5 * Math.cos(t * TWO_PI * 2))));
    const air = 0.25 + 0.35 * (0.5 - 0.5 * Math.cos(t * TWO_PI * 5));
    const v = (s1.next() + s2.next() + s3.next() * 0.6) * 0.3
      + noiseFilter.process(noise) * air * 1.6;
    buf[i] = v;
    if (v > peak) peak = v; else if (-v > peak) peak = -v;
  }
  const norm = 0.9 / peak;
  for (let i = 0; i < len; i++) buf[i] = (buf[i] as number) * norm;
  sourceBuffer = buf;
  return buf;
}

class GranularVoice implements EngineVoice {
  private readonly params = new Float32Array(GRANULAR_DESCRIPTOR.params.length);
  private readonly ampEnv: Envelope;
  private readonly posSmooth: Smoother;
  private readonly densitySmooth: Smoother;

  private readonly gActive = new Uint8Array(MAX_GRAINS);
  private readonly gPos = new Float64Array(MAX_GRAINS);   // read head, samples
  private readonly gInc = new Float64Array(MAX_GRAINS);   // rate, negative = reverse
  private readonly gAge = new Float64Array(MAX_GRAINS);
  private readonly gLen = new Float64Array(MAX_GRAINS);
  private readonly gTaper = new Float32Array(MAX_GRAINS);
  private readonly gGainL = new Float32Array(MAX_GRAINS);
  private readonly gGainR = new Float32Array(MAX_GRAINS);

  private readonly src: Float32Array;
  private readonly srcLen: number;
  private readonly sr: number;
  private readonly invSr: number;
  private readonly srcRateRatio: number;

  private rng = 1;
  private spawnAccum = 0;
  private pitchRatio = 1;
  private velocity = 1;
  private active = false;
  private dcX1 = 0;
  private dcY1 = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.invSr = 1 / sampleRate;
    this.src = getSource();
    this.srcLen = this.src.length;
    this.srcRateRatio = SOURCE_SR / sampleRate;
    this.ampEnv = new Envelope(sampleRate);
    this.posSmooth = new Smoother(sampleRate, 25);
    this.densitySmooth = new Smoother(sampleRate, 40);
    for (let i = 0; i < this.params.length; i++) {
      this.params[i] = GRANULAR_DESCRIPTOR.params[i]?.default ?? 0;
    }
    this.posSmooth.snap(this.params[P_POSITION] as number);
    this.densitySmooth.snap(this.params[P_DENSITY] as number);
  }

  /** xorshift32. Seeded per voice so a rendered patch is reproducible. */
  private rand(): number {
    let x = this.rng;
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    this.rng = x;
    return x / 4294967296;
  }

  setParam(index: number, value: number): void {
    if (index < 0 || index >= this.params.length) return;
    this.params[index] = value;
    if (
      index === P_ATTACK || index === P_DECAY ||
      index === P_SUSTAIN || index === P_RELEASE
    ) {
      this.applyEnvelope();
    }
  }

  private applyEnvelope(): void {
    this.ampEnv.set(
      this.params[P_ATTACK] as number,
      this.params[P_DECAY] as number,
      this.params[P_SUSTAIN] as number,
      this.params[P_RELEASE] as number,
    );
  }

  noteOn(freq: number, velocity: number, voiceIndex: number): void {
    this.velocity = velocity;
    this.active = true;
    this.pitchRatio = freq / SOURCE_ROOT_HZ;
    this.rng = ((voiceIndex * 2654435761) ^ 0x5bf03635) >>> 0 || 1;
    this.spawnAccum = 1;
    this.dcX1 = 0;
    this.dcY1 = 0;
    this.gActive.fill(0);
    this.applyEnvelope();
    this.ampEnv.trigger();
    this.posSmooth.snap(this.params[P_POSITION] as number);
    this.densitySmooth.snap(this.params[P_DENSITY] as number);
  }

  noteOff(): void {
    this.ampEnv.release();
  }

  isFinished(): boolean {
    return this.active && this.ampEnv.isFinished();
  }

  private spawn(posNorm: number, sizeSamples: number): void {
    let slot = -1;
    for (let g = 0; g < MAX_GRAINS; g++) {
      if (this.gActive[g] === 0) { slot = g; break; }
    }
    if (slot < 0) return;

    const len = this.srcLen;
    const spray = clamp(this.params[P_SPRAY] as number, 0, 1);
    let start = (clamp(posNorm, 0, 1) + (this.rand() * 2 - 1) * spray) * len;
    start %= len;
    if (start < 0) start += len;

    const scatter = clamp(this.params[P_PITCH_SCATTER] as number, 0, 12);
    const cents = (this.rand() * 2 - 1) * scatter;
    let inc = this.pitchRatio * this.srcRateRatio * Math.pow(2, cents / 12);
    if (inc > 16) inc = 16;
    if (this.rand() < clamp(this.params[P_REVERSE] as number, 0, 1)) inc = -inc;

    let dur = sizeSamples * (1 + (this.rand() * 2 - 1) * 0.15 * spray);
    if (dur < 8) dur = 8;

    // Grains are panned across the stereo field; render() is mono for now and
    // folds the two gains back down, so pan still shapes the cloud's weight.
    const pan = this.rand();
    const shape = clamp(this.params[P_WINDOW] as number, 0, 1);

    this.gActive[slot] = 1;
    this.gPos[slot] = start;
    this.gInc[slot] = inc;
    this.gAge[slot] = 0;
    this.gLen[slot] = dur;
    this.gTaper[slot] = 0.05 + 0.45 * shape;
    this.gGainL[slot] = Math.cos(pan * Math.PI * 0.5) * 0.45;
    this.gGainR[slot] = Math.sin(pan * Math.PI * 0.5) * 0.45;
  }

  render(out: Float32Array, offset: number, count: number): void {
    if (!this.active) return;

    const src = this.src;
    const len = this.srcLen;
    const sizeSamples = clamp(this.params[P_SIZE] as number, 1, 4000) * 0.001 * this.sr;
    this.posSmooth.setTarget(clamp(this.params[P_POSITION] as number, 0, 1));
    this.densitySmooth.setTarget(clamp(this.params[P_DENSITY] as number, 0, 400));

    for (let i = 0; i < count; i++) {
      const pos = this.posSmooth.next();
      this.spawnAccum += this.densitySmooth.next() * this.invSr;
      if (this.spawnAccum >= 1) {
        this.spawnAccum -= 1;
        if (this.spawnAccum > 1) this.spawnAccum = 1;
        this.spawn(pos, sizeSamples);
      }

      let sumL = 0;
      let sumR = 0;
      for (let g = 0; g < MAX_GRAINS; g++) {
        if (this.gActive[g] === 0) continue;
        const age = this.gAge[g] as number;
        const glen = this.gLen[g] as number;
        if (age >= glen) { this.gActive[g] = 0; continue; }

        let p = this.gPos[g] as number;
        const i0 = p | 0;
        let i1 = i0 + 1;
        if (i1 >= len) i1 = 0;
        const a = src[i0] as number;
        const b = src[i1] as number;
        const s = (a + (b - a) * (p - i0)) * grainWindow(age / glen, this.gTaper[g] as number);

        sumL += s * (this.gGainL[g] as number);
        sumR += s * (this.gGainR[g] as number);

        p += this.gInc[g] as number;
        if (p >= len) p -= len;
        else if (p < 0) p += len;
        this.gPos[g] = p;
        this.gAge[g] = age + 1;
      }

      // Grains start and stop mid-waveform, so the cloud carries a wandering
      // DC offset. Left in, it eats headroom and dulls the saturator.
      const mono = (sumL + sumR) * 0.7071067811865476;
      let hp = mono - this.dcX1 + 0.995 * this.dcY1;
      if (hp < DENORMAL && hp > -DENORMAL) hp = 0;
      this.dcX1 = mono < DENORMAL && mono > -DENORMAL ? 0 : mono;
      this.dcY1 = hp;

      const y = saturate(hp * 0.55) * this.ampEnv.next() * this.velocity * 0.9;
      out[offset + i] = (out[offset + i] as number) + (y === y ? y : 0);
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export const GranularEngine: EngineModule = {
  descriptor: GRANULAR_DESCRIPTOR,
  allocVoice: (sampleRate: number): EngineVoice => new GranularVoice(sampleRate),
};
