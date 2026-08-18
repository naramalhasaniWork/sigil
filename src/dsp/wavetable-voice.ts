import type { EngineModule, EngineVoice } from '@/audio/types';
import { WAVETABLE_DESCRIPTOR } from './wavetable-descriptor';
import { createFilter, type Filter } from './filters';
import { Envelope } from './envelope';
import { Smoother } from './smoothing';

const P_POS = 0, P_POS_ENV = 1, P_DETUNE = 2, P_MIX = 3;
const P_CUTOFF = 4, P_RES = 5, P_FILTER_ENV = 6, P_DRIVE = 7;
const P_ATTACK = 8, P_DECAY = 9, P_SUSTAIN = 10, P_RELEASE = 11;
const P_KEYTRACK = 12, P_VEL_AMP = 13;

const LN2 = 0.6931471805599453;
const TWO_PI = 6.283185307179586;
/** log2(261.6256) — middle C, the note key tracking pivots around. */
const LOG2_REF = 8.03125;
const CONTROL_STEP = 8;
const OSC_GAIN = 0.9;
/* Level-matched with the other engines — see analog-voice.ts. Measured -16.6
 * dBFS at default against FM's -10.8. */
const VOICE_GAIN = 0.55;

const TABLE_COUNT = 8;
const TABLE_SIZE = 2048;
/** Each table stores its first sample again at the end: interpolation never wraps. */
const STRIDE = TABLE_SIZE + 1;
/** Band-limit levels; level k keeps harmonics 1..2^k. */
const LEVELS = 10;
const MAX_HARM = 1 << (LEVELS - 1);

/** Deterministic hash to 0..1 — the "random" phases and sparse metallic partials. */
function hash01(n: number): number {
  let x = Math.imul(n, 0x9e3779b9);
  x ^= x >>> 16; x = Math.imul(x, 0x45d9f3b); x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

function bump(n: number, centre: number, width: number): number {
  const d = (n - centre) / width; return Math.exp(-d * d);
}

/**
 * Amplitude of harmonic n for table t. The row runs from pure to complex:
 * sine, triangle, soft organic, square, saw, two vocal formants, metallic.
 */
function harmonicAmp(t: number, n: number): number {
  switch (t) {
    case 0: return n === 1 ? 1 : 0;
    case 1: return (n & 1) === 1 ? 1 / (n * n) : 0;
    // Organic: a fast harmonic rolloff with a touch of octave, like a plucked gut string.
    case 2: return Math.exp(-0.75 * (n - 1)) + (n === 2 ? 0.22 : 0);
    case 3: return (n & 1) === 1 ? 1 / n : 0;
    case 4: return 1 / n;
    // Vocal shapes: a thin sawtooth bed with formant bumps where vowels put them.
    case 5: return 0.1 / n + bump(n, 3, 1.6) + 0.65 * bump(n, 10, 3.5);
    case 6: return 0.1 / n + bump(n, 2, 1.2) + 0.55 * bump(n, 16, 5);
    // Metallic: sparse pseudo-random partials, the recipe for a bell-like clang.
    default: return n === 1 ? 0.5 : hash01(n) < 0.2 ? 1 / Math.sqrt(n) : 0;
  }
}

function harmonicPhase(t: number, n: number): number {
  if (t === 1) return (n & 3) === 3 ? Math.PI : 0;
  if (t >= 5) return hash01(n * 17 + t) * TWO_PI;
  return 0;
}

/**
 * Builds every table at every band-limit level, additively. Harmonics are
 * accumulated in ascending order and the running sum is snapshotted each time
 * it crosses a power-of-two cap, so each harmonic is computed exactly once.
 * Runs once at module load; voices share the result read-only.
 */
function buildBank(): Float32Array {
  const bank = new Float32Array(LEVELS * TABLE_COUNT * STRIDE);
  const acc = new Float64Array(TABLE_SIZE);
  for (let t = 0; t < TABLE_COUNT; t++) {
    acc.fill(0);
    let level = 0;
    for (let n = 1; n <= MAX_HARM; n++) {
      const a = harmonicAmp(t, n);
      if (a !== 0) {
        // Rotate a unit phasor instead of calling sin() per sample.
        const step = (TWO_PI * n) / TABLE_SIZE;
        const cosD = Math.cos(step), sinD = Math.sin(step);
        const ph = harmonicPhase(t, n);
        let s = Math.sin(ph), c = Math.cos(ph);
        for (let i = 0; i < TABLE_SIZE; i++) {
          acc[i] = (acc[i] as number) + a * s;
          const ns = s * cosD + c * sinD;
          c = c * cosD - s * sinD;
          s = ns;
        }
      }
      if (level < LEVELS && n === 1 << level) {
        let peak = 1e-9;
        for (let i = 0; i < TABLE_SIZE; i++) {
          const v = acc[i] as number;
          if (v > peak) peak = v; else if (-v > peak) peak = -v;
        }
        const g = 0.95 / peak;
        const off = (level * TABLE_COUNT + t) * STRIDE;
        for (let i = 0; i < TABLE_SIZE; i++) bank[off + i] = (acc[i] as number) * g;
        bank[off + TABLE_SIZE] = bank[off] as number;
        level++;
      }
    }
  }
  return bank;
}

const BANK = buildBank();
/** Cheap rational tanh — monotonic, bounded, shaped for hot loops. */
function saturate(x: number): number {
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

class WavetableVoice implements EngineVoice {
  private readonly filter: Filter;
  private readonly ampEnv: Envelope;
  private readonly filterEnv: Envelope;
  private readonly posEnv: Envelope;
  private readonly cutoffSmooth: Smoother;
  private readonly posSmooth: Smoother;
  private readonly params = new Float32Array(WAVETABLE_DESCRIPTOR.params.length);

  private readonly invSr: number;
  private readonly ctrlRate: number;
  private readonly maxFreq: number;
  private ph1 = 0;
  private ph2 = 0;
  private inc1 = 0;
  private inc2 = 0;
  private offA1 = 0; private offB1 = 0;
  private offA2 = 0; private offB2 = 0;
  private xfade = 0;
  private detuneMul = 1;
  private posAmt = 0;
  private ctrl = 0;
  private logFreq = LOG2_REF;
  private velocity = 1;
  private active = false;

  constructor(sampleRate: number) {
    this.invSr = 1 / sampleRate;
    this.ctrlRate = sampleRate / CONTROL_STEP;
    this.maxFreq = sampleRate * 0.45;
    this.filter = createFilter('ladder', sampleRate);
    this.ampEnv = new Envelope(sampleRate);
    this.filterEnv = new Envelope(this.ctrlRate);
    this.posEnv = new Envelope(this.ctrlRate);
    this.cutoffSmooth = new Smoother(this.ctrlRate, 8);
    this.posSmooth = new Smoother(this.ctrlRate, 15);
    for (let i = 0; i < this.params.length; i++) {
      this.params[i] = WAVETABLE_DESCRIPTOR.params[i]?.default ?? 0;
    }
    this.applyEnvelopes();
    this.cutoffSmooth.snap(this.params[P_CUTOFF] as number);
    this.posSmooth.snap(this.params[P_POS] as number);
  }

  setParam(index: number, value: number): void {
    if (index < 0 || index >= this.params.length) return;
    this.params[index] = value;
    if (index >= P_ATTACK && index <= P_RELEASE) this.applyEnvelopes();
  }

  private applyEnvelopes(): void {
    const p = this.params;
    const a = p[P_ATTACK] as number, d = p[P_DECAY] as number;
    const s = p[P_SUSTAIN] as number, r = p[P_RELEASE] as number;
    this.ampEnv.set(a, d, s, r);
    // The filter closes ahead of the amplitude and settles lower — a note that
    // dulls as it fades is what acoustic instruments do.
    this.filterEnv.set(a, d * 0.8, s * 0.5, r);
    // The position envelope settles even lower, so Motion sweeps the timbre a
    // long way at the start of a note and comes to rest, rather than parking
    // the table permanently somewhere else.
    this.posEnv.set(a, d * 1.2, s * 0.3, r);
  }

  noteOn(freq: number, velocity: number, voiceIndex: number): void {
    const f = freq > 8 ? (freq < 12000 ? freq : 12000) : 8;
    this.logFreq = Math.log2(f);
    this.velocity = velocity > 0 ? (velocity < 1 ? velocity : 1) : 0;
    // Staggered start phases: voices that begin identically sound like one
    // loud voice until they happen to drift apart.
    this.ph1 = ((voiceIndex * 0.137) % 1 + 1) % 1;
    this.ph2 = ((voiceIndex * 0.311) % 1 + 1) % 1;
    this.filter.reset();
    this.applyEnvelopes();
    this.ampEnv.trigger(); this.filterEnv.trigger(); this.posEnv.trigger();
    this.cutoffSmooth.snap(this.params[P_CUTOFF] as number);
    this.posSmooth.snap(this.params[P_POS] as number);
    this.ctrl = 0;
    this.active = true;
  }

  noteOff(): void {
    this.ampEnv.release();
    this.filterEnv.release();
    this.posEnv.release();
  }

  /** True once a note has been triggered and its amp envelope has run out. */
  isFinished(): boolean {
    return this.active && this.ampEnv.isFinished();
  }

  /** Bank offset of table `t` at the band-limit level right for `freq`. */
  private levelBase(freq: number): number {
    const harm = this.maxFreq / (freq > 1 ? freq : 1);
    let level = Math.floor(Math.log2(harm > 1 ? harm : 1));
    if (level >= LEVELS) level = LEVELS - 1;
    return level * TABLE_COUNT * STRIDE;
  }

  /** Everything that moves slower than audio, recomputed once per control step. */
  private updateControl(): void {
    const p = this.params;
    const base = Math.exp(LN2 * this.logFreq);
    const max = this.maxFreq;
    const f1 = base > max ? max : base;
    const f2raw = base * this.detuneMul;
    const f2 = f2raw > max ? max : f2raw;
    this.inc1 = f1 * this.invSr;
    this.inc2 = f2 * this.invSr;

    // Table position: the knob (smoothed) plus the envelope's push, clamped
    // to the row. The scan crossfades between the two neighbouring tables.
    let pos = this.posSmooth.next() + this.posAmt * this.posEnv.next();
    if (pos < 0) pos = 0; else if (pos > 1) pos = 1;
    const scaled = pos * (TABLE_COUNT - 1);
    let tA = scaled | 0;
    if (tA > TABLE_COUNT - 2) tA = TABLE_COUNT - 2;
    this.xfade = scaled - tA;
    const base1 = this.levelBase(f1);
    const base2 = this.levelBase(f2);
    this.offA1 = base1 + tA * STRIDE; this.offB1 = this.offA1 + STRIDE;
    this.offA2 = base2 + tA * STRIDE; this.offB2 = this.offA2 + STRIDE;

    const fenv = this.filterEnv.next();
    const oct = (p[P_KEYTRACK] as number) * (this.logFreq - LOG2_REF);
    let cut = this.cutoffSmooth.next() * Math.exp(LN2 * oct)
      * (1 + (p[P_FILTER_ENV] as number) * fenv * 6);
    if (!(cut > 10)) cut = 10;
    else if (cut > max) cut = max;
    this.filter.setCutoff(cut);
  }

  /** Linear-interpolated read of one oscillator: two tables, one crossfade. */
  private read(offA: number, offB: number, phase: number): number {
    const idx = phase * TABLE_SIZE;
    const i0 = idx | 0;
    const fr = idx - i0;
    const a = (BANK[offA + i0] as number)
      + ((BANK[offA + i0 + 1] as number) - (BANK[offA + i0] as number)) * fr;
    const b = (BANK[offB + i0] as number)
      + ((BANK[offB + i0 + 1] as number) - (BANK[offB + i0] as number)) * fr;
    return a + (b - a) * this.xfade;
  }

  render(out: Float32Array, offset: number, count: number): void {
    if (!this.active) return;
    const p = this.params;
    this.detuneMul = Math.exp((LN2 * (p[P_DETUNE] as number)) / 12);
    this.posAmt = p[P_POS_ENV] as number;
    this.cutoffSmooth.setTarget(p[P_CUTOFF] as number);
    this.posSmooth.setTarget(p[P_POS] as number);
    this.filter.setResonance(p[P_RES] as number);
    const drive = 1 + (p[P_DRIVE] as number) * 6, driveComp = 1 / Math.sqrt(drive);
    const raw = p[P_MIX] as number;
    const bal = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    const g1 = (1 - bal) * OSC_GAIN, g2 = bal * OSC_GAIN;
    const velAmp = p[P_VEL_AMP] as number;
    const gain = (1 - velAmp + velAmp * this.velocity * this.velocity) * VOICE_GAIN;

    let i = 0;
    while (i < count) {
      if (this.ctrl === 0) { this.updateControl(); this.ctrl = CONTROL_STEP; }
      const m = this.ctrl < count - i ? this.ctrl : count - i;
      for (let j = 0; j < m; j++) {
        const s1 = this.read(this.offA1, this.offB1, this.ph1);
        const s2 = this.read(this.offA2, this.offB2, this.ph2);
        this.ph1 += this.inc1; if (this.ph1 >= 1) this.ph1 -= 1;
        this.ph2 += this.inc2; if (this.ph2 >= 1) this.ph2 -= 1;
        const sig = saturate((s1 * g1 + s2 * g2) * drive) * driveComp;
        let y = this.filter.process(sig) * this.ampEnv.next() * gain;
        // Catches NaN and infinity alike: a failed comparison falls to zero.
        if (!(y > -4 && y < 4)) y = y > 0 ? 4 : y < 0 ? -4 : 0;
        out[offset + i + j] = (out[offset + i + j] as number) + y;
      }
      i += m; this.ctrl -= m;
    }
  }
}

export const WavetableEngine: EngineModule = {
  descriptor: WAVETABLE_DESCRIPTOR,
  allocVoice: (sampleRate: number): EngineVoice => new WavetableVoice(sampleRate),
};
