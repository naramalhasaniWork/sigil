import type { EngineModule, EngineVoice } from '@/audio/types';
import { SAMPLER_DESCRIPTOR } from './sampler-descriptor';
import { createFilter, type Filter } from './filters';
import { Envelope } from './envelope';

const P_START = 0, P_END = 1, P_LOOP_MODE = 2, P_LOOP_START = 3, P_LOOP_LENGTH = 4;
const P_XFADE = 5, P_REVERSE = 6, P_TUNE = 7, P_FINE = 8;
const P_CUTOFF = 9, P_RES = 10, P_MODEL = 11;
const P_ATTACK = 12, P_DECAY = 13, P_SUSTAIN = 14, P_RELEASE = 15;
const P_DRIVE = 16, P_BITS = 17, P_VEL_AMP = 18, P_WOBBLE = 19, P_WOBBLE_RATE = 20;

const TWO_PI = 6.283185307179586;
/** Pitch wobble and cutoff move far slower than audio; once per 16 samples. */
const CONTROL_STEP = 16;
/** DEFAULT_ROOT is middle C, the pitch the built-in sample was written at. */
const DEFAULT_SR = 48000, DEFAULT_ROOT = 261.6255653;
/** Fade at the edges of a one-shot, in source frames — about 2 ms at 48 k. */
const EDGE_FADE = 96, INV_EDGE_FADE = 1 / EDGE_FADE;
/** Below this a loop is shorter than the crossfade machinery can handle. */
const MIN_LOOP = 32;
const VOICE_GAIN = 0.85;

/**
 * The sample every voice plays, held at module level. Voices keep no copy and
 * never make one: swapping the buffer is a single reference assignment, so the
 * UI can drop in a 30 MB recording between blocks without touching the pool.
 */
let activeData: Float32Array | null = null;
let activeSr = DEFAULT_SR;
let activeRoot = DEFAULT_ROOT;

/** Point every voice at new material. Ignores obviously broken input. */
export function setActiveSample(data: Float32Array, sampleRate: number, rootHz: number): void {
  if (data.length >= 16) activeData = data;
  if (sampleRate > 1000 && sampleRate < 768000) activeSr = sampleRate;
  if (rootHz > 8 && rootHz < 12000) activeRoot = rootHz;
}

/** A struck tone at middle C, so the engine sounds before anything is loaded.
 * Built once, on the first voice allocation — never inside render(). */
function buildDefault(): Float32Array {
  const len = DEFAULT_SR;
  const buf = new Float32Array(len);
  let peak = 1e-9;
  for (let i = 0; i < len; i++) {
    const t = i / DEFAULT_SR;
    const w = DEFAULT_ROOT * TWO_PI * t;
    // Slightly stretched partials, each dying faster than the one below it:
    // that ratio is what the ear reads as "struck" rather than "held".
    let v = Math.sin(w) * Math.exp(-3.2 * t)
      + Math.sin(w * 2.01) * 0.42 * Math.exp(-5.5 * t)
      + Math.sin(w * 3.02) * 0.22 * Math.exp(-8 * t)
      + Math.sin(w * 5.4) * 0.11 * Math.exp(-15 * t);
    v *= 1 - Math.exp(-t * 900);
    buf[i] = v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  const g = 0.9 / peak;
  for (let i = 0; i < len; i++) buf[i] = (buf[i] as number) * g;
  return buf;
}

/**
 * Linear interpolation between the two samples either side of a fractional read
 * position. The treble cost is real: this is a one-zero lowpass, so a sample
 * pitched up an octave loses about a decibel at the top of its range, and
 * several octaves up it audibly dulls while the aliasing it fails to suppress
 * creeps in underneath. Cubic costs four reads and a polynomial per sample for
 * maybe 10 dB more rejection; across the two octaves either side of the root
 * that a sampler is actually played over, linear plus the filter is the trade.
 */
function readLin(d: Float32Array, pos: number, len: number): number {
  let i0 = pos | 0;
  if (i0 < 0) i0 = 0; else if (i0 > len - 1) i0 = len - 1;
  let i1 = i0 + 1;
  if (i1 > len - 1) i1 = len - 1;
  const a = d[i0] as number, b = d[i1] as number;
  return a + (b - a) * (pos - i0);
}

/** Cheap rational tanh — monotonic, bounded, shaped for hot loops. */
function saturate(x: number): number {
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

class SamplerVoice implements EngineVoice {
  private readonly params = new Float32Array(SAMPLER_DESCRIPTOR.params.length);
  private readonly ladder: Filter;
  private readonly svf: Filter;
  private readonly diode: Filter;
  private activeFilter: Filter;
  private readonly ampEnv: Envelope;
  private readonly invSr: number;

  private pos = 0;
  private dir = 1;
  private baseInc = 1;
  private inc = 1;
  private wobPhase = 0;
  private wobInc = 0;
  private ctrl = 0;
  private velocity = 1;
  private noteRatio = 1;
  private active = false;
  private ended = false;
  private restart = false;

  constructor(sampleRate: number) {
    this.invSr = 1 / sampleRate;
    this.ladder = createFilter('ladder', sampleRate);
    this.svf = createFilter('svf', sampleRate);
    this.diode = createFilter('diode', sampleRate);
    this.activeFilter = this.ladder;
    this.ampEnv = new Envelope(sampleRate);
    for (let i = 0; i < this.params.length; i++) {
      this.params[i] = SAMPLER_DESCRIPTOR.params[i]?.default ?? 0;
    }
    if (!activeData) activeData = buildDefault();
    this.applyEnvelope();
  }

  setParam(index: number, value: number): void {
    if (index < 0 || index >= this.params.length) return;
    this.params[index] = value;
    if (index >= P_ATTACK && index <= P_RELEASE) this.applyEnvelope();
  }

  private applyEnvelope(): void {
    const p = this.params;
    this.ampEnv.set(
      p[P_ATTACK] as number, p[P_DECAY] as number,
      p[P_SUSTAIN] as number, p[P_RELEASE] as number,
    );
  }

  noteOn(freq: number, velocity: number, voiceIndex: number): void {
    const f = freq > 8 ? (freq < 12000 ? freq : 12000) : 8;
    this.noteRatio = f / activeRoot;
    this.velocity = velocity > 0 ? (velocity < 1 ? velocity : 1) : 0;
    this.ladder.reset(); this.svf.reset(); this.diode.reset();
    this.applyEnvelope();
    this.ampEnv.trigger();
    // Staggered wobble phase: identical phase across a chord makes every note
    // bend the same way at the same moment, which sounds like a fault.
    this.wobPhase = ((voiceIndex * 0.317) % 1 + 1) % 1;
    this.ctrl = 0;
    this.ended = false;
    this.restart = true;
    this.active = true;
  }

  noteOff(): void {
    this.ampEnv.release();
  }

  isFinished(): boolean {
    return this.active && (this.ended || this.ampEnv.isFinished());
  }

  private updateControl(): void {
    const p = this.params;
    const depth = clamp01(p[P_WOBBLE] as number);
    let mul = 1;
    if (depth > 0) {
      let ph = this.wobPhase + this.wobInc;
      if (ph >= 1) ph -= (ph | 0);
      this.wobPhase = ph;
      mul = 1 + depth * 0.06 * Math.sin(ph * TWO_PI);
    }
    let inc = this.baseInc * mul;
    if (!(inc > 1e-4)) inc = 1e-4; else if (inc > 64) inc = 64;
    this.inc = inc;
    let cut = p[P_CUTOFF] as number;
    if (!(cut > 10)) cut = 10;
    this.activeFilter.setCutoff(cut);
  }

  render(out: Float32Array, offset: number, count: number): void {
    if (!this.active || this.ended) return;
    const data = activeData;
    if (data === null) return;
    const len = data.length;
    if (len < 16) return;
    const p = this.params;

    // Trim window, in source frames. Every bound below is derived from these,
    // so one clamp here keeps the whole render inside the buffer.
    let s0 = Math.floor(clamp01(p[P_START] as number) * len);
    let s1 = Math.floor(clamp01(p[P_END] as number) * len);
    if (s0 > len - 8) s0 = len - 8;
    if (s1 < s0 + 4) s1 = s0 + 4;

    let mode = Math.round(p[P_LOOP_MODE] as number);
    if (!(mode > 0)) mode = 0; else if (mode > 2) mode = 2;
    const span = s1 - s0;
    if (span < MIN_LOOP * 2) mode = 0;
    let lStart = s0 + clamp01(p[P_LOOP_START] as number) * span;
    let lLen = clamp01(p[P_LOOP_LENGTH] as number) * (s1 - lStart);
    if (lLen < MIN_LOOP) lLen = MIN_LOOP;
    let lEnd = lStart + lLen;
    if (lEnd > s1) { lEnd = s1; lStart = lEnd - lLen; }
    if (lStart < s0) { lStart = s0; lLen = lEnd - lStart; }

    // The crossfade reads one loop length behind the play head, so it can only
    // be as long as the material sitting before the loop start.
    let xf = (p[P_XFADE] as number) * 0.001 * activeSr;
    if (!(xf > 0)) xf = 0;
    const room = lStart - s0;
    if (xf > room) xf = room;
    if (xf > lLen * 0.5) xf = lLen * 0.5;
    const fading = mode === 1 && xf >= 1;
    const invXf = fading ? 1 / xf : 0;
    const xfStart = lEnd - xf;

    const rev = (p[P_REVERSE] as number) >= 0.5;
    if (this.restart) {
      this.dir = rev ? -1 : 1;
      this.pos = rev ? s1 - 1 : s0;
      this.restart = false;
    } else if (this.pos < s0) this.pos = s0;
    else if (this.pos > s1) this.pos = s1 - 1;

    const model = Math.round(p[P_MODEL] as number);
    const filter = model === 1 ? this.svf : model === 2 ? this.diode : this.ladder;
    this.activeFilter = filter;
    filter.setResonance(p[P_RES] as number);

    const semis = (p[P_TUNE] as number) + (p[P_FINE] as number);
    let base = this.noteRatio * activeSr * this.invSr * Math.pow(2, semis / 12);
    if (!(base > 0)) base = 1;
    this.baseInc = base;
    this.wobInc = (p[P_WOBBLE_RATE] as number) * this.invSr * CONTROL_STEP;

    const drive = 1 + (p[P_DRIVE] as number) * 8, driveComp = 1 / Math.sqrt(drive);
    let bits = Math.round(p[P_BITS] as number);
    if (!(bits > 2)) bits = 2; else if (bits > 16) bits = 16;
    const q = bits < 16 ? Math.pow(2, bits - 1) : 0, invQ = q > 0 ? 1 / q : 0;
    const velAmp = clamp01(p[P_VEL_AMP] as number);
    const gain = (1 - velAmp + velAmp * this.velocity * this.velocity) * VOICE_GAIN;

    let i = 0;
    while (i < count) {
      if (this.ctrl === 0) { this.updateControl(); this.ctrl = CONTROL_STEP; }
      const m = this.ctrl < count - i ? this.ctrl : count - i;
      const step = this.inc;
      let j = 0;
      for (; j < m; j++) {
        let pos = this.pos;
        let s = readLin(data, pos, len);
        if (fading && pos > xfStart) {
          // Blend in the material one loop length back — the same phase of the
          // loop, approached from before its start — so the seam has no step.
          const t = (pos - xfStart) * invXf;
          s += (readLin(data, pos - lLen, len) - s) * t;
        } else if (mode === 0) {
          let d = pos - s0;
          const d2 = s1 - pos;
          if (d2 < d) d = d2;
          if (d < EDGE_FADE) s *= d * INV_EDGE_FADE;
        }
        if (q > 0) s = Math.round(s * q) * invQ;
        s = saturate(s * drive) * driveComp;
        let y = filter.process(s) * this.ampEnv.next() * gain;
        // Catches NaN and infinity alike: a failed comparison falls to zero.
        if (!(y > -4 && y < 4)) y = y > 0 ? 4 : y < 0 ? -4 : 0;
        out[offset + i + j] = (out[offset + i + j] as number) + y;

        pos += step * this.dir;
        if (mode === 1) {
          while (pos >= lEnd) pos -= lLen;
          while (pos < lStart) pos += lLen;
        } else if (mode === 2) {
          if (pos >= lEnd) { pos = lEnd + lEnd - pos; this.dir = -1; }
          else if (pos <= lStart) { pos = lStart + lStart - pos; this.dir = 1; }
          if (pos > lEnd) pos = lEnd; else if (pos < lStart) pos = lStart;
        } else if (pos >= s1 || pos < s0) {
          this.pos = pos;
          this.ended = true;
          return;
        }
        this.pos = pos;
      }
      i += j;
      this.ctrl -= j;
    }
  }
}

export const SamplerEngine: EngineModule = {
  descriptor: SAMPLER_DESCRIPTOR,
  allocVoice: (sampleRate: number): EngineVoice => new SamplerVoice(sampleRate),
};
