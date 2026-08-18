import type { EngineDescriptor } from '@/audio/types';

/**
 * The magic chain's parameter table plus the DSP primitives it is built from.
 * The primitives live here only so neither file passes the 300-line ceiling.
 */

const DENORMAL = 1e-20;
export const TWO_PI = Math.PI * 2;

/** Flush denormals. Every recursive path in the chain runs through this. */
export function flush(x: number): number {
  return x < DENORMAL && x > -DENORMAL ? 0 : x;
}

/** Cheap rational tanh — monotonic, shaped for hot loops. */
export function saturate(x: number): number {
  const x2 = x * x; return (x * (27 + x2)) / (27 + 9 * x2);
}

/** Linear below `knee`, then a knee to a hard ceiling of `knee + span / 2`, so
 *  a safety limiter never colours the sounds that never needed limiting. */
export function softLimit(x: number, knee: number, span: number): number {
  const a = x < 0 ? -x : x;
  if (a <= knee) return x;
  const over = a - knee;
  const lim = over >= span ? knee + span * 0.5 : knee + over * (1 - over / (span + span));
  return x < 0 ? -lim : lim;
}

/** Copy the `n` most recent samples out of a ring buffer, oldest first. */
export function copyTail(ring: Float32Array, w: number, dst: Float32Array, n: number): void {
  const max = ring.length;
  let r = w - n;
  while (r < 0) r += max;
  for (let i = 0; i < n; i++) { dst[i] = ring[r] as number; r++; if (r >= max) r = 0; }
}

/** Fractional-delay ring buffer, power-of-two length so wrapping is one mask. */
export class DelayLine {
  private readonly buf: Float32Array; private readonly mask: number;
  private w = 0;
  constructor(maxSamples: number) {
    let size = 8;
    while (size < maxSamples + 4) size <<= 1;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
  }
  reset(): void { this.buf.fill(0); this.w = 0; }
  write(x: number): void { this.buf[this.w] = x; this.w = (this.w + 1) & this.mask; }

  /** `d` samples into the past, linearly interpolated. */
  read(d: number): number {
    const pos = this.w - 1 - d;
    const i0 = Math.floor(pos); const f = pos - i0;
    const a = this.buf[i0 & this.mask] as number;
    const b = this.buf[(i0 + 1) & this.mask] as number;
    return a + (b - a) * f;
  }
}

/** Second-order allpass, H(z) = (a² − z⁻²) / (1 − a² z⁻²). The Hilbert building block. */
export class Allpass2 {
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  private readonly a: number;
  constructor(coeff: number) { this.a = coeff * coeff; }
  reset(): void { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  process(x: number): number {
    const y = this.a * (x + this.y2) - this.x2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = flush(y);
    return this.y1;
  }
}

// Niemitalo's allpass pair: two four-section chains whose outputs sit ~90° apart
// across the band once one branch is delayed a single sample.
const HILBERT_I = [0.6923877778065, 0.9360654322959, 0.988229522686, 0.9987488452737];
const HILBERT_Q = [0.4021921162426, 0.856171088242, 0.9722909545651, 0.9952884791278];

/** Approximate Hilbert transformer. `i` and `q` are the quadrature branches of
 *  the analytic signal — what makes true frequency shifting possible at all. */
export class HilbertPair {
  private readonly ci: Allpass2[] = []; private readonly cq: Allpass2[] = [];
  private z = 0; i = 0; q = 0;
  constructor() {
    for (let k = 0; k < 4; k++) {
      this.ci.push(new Allpass2(HILBERT_I[k] as number));
      this.cq.push(new Allpass2(HILBERT_Q[k] as number));
    }
  }
  reset(): void {
    for (let k = 0; k < 4; k++) { (this.ci[k] as Allpass2).reset(); (this.cq[k] as Allpass2).reset(); }
    this.z = 0; this.i = 0; this.q = 0;
  }
  process(x: number): void {
    let a = x; let b = x;
    for (let k = 0; k < 4; k++) {
      a = (this.ci[k] as Allpass2).process(a);
      b = (this.cq[k] as Allpass2).process(b);
    }
    this.i = this.z; this.z = a; this.q = b;
  }
}

/**
 * Rotating-tap pitch shifter. Two read pointers drift through a delay line at
 * the shift ratio, half a window apart, crossfaded by a raised cosine whose
 * gain is zero exactly where a pointer wraps, so the splice you would otherwise
 * hear as a click happens underneath silence. No FFT.
 */
export class PitchShifter {
  private readonly line: DelayLine; private readonly win: number;
  private phase = 0;
  constructor(sampleRate: number, windowMs: number) {
    this.win = Math.round((windowMs / 1000) * sampleRate);
    this.line = new DelayLine(this.win * 2 + 8);
  }
  reset(): void { this.line.reset(); this.phase = 0; }
  process(x: number, ratio: number): number {
    this.line.write(x);
    const w = this.win;
    let p = this.phase + (1 - ratio);
    if (p < 0) p += w; else if (p >= w) p -= w;
    this.phase = p;
    const q = p < w * 0.5 ? p + w * 0.5 : p - w * 0.5;
    const g = 0.5 - 0.5 * Math.cos((TWO_PI * p) / w);
    return g * this.line.read(p) + (1 - g) * this.line.read(q);
  }
}

/** Schroeder allpass — unity gain, smears transients. Diffusion for the shimmer tank. */
export class Diffuser {
  private readonly buf: Float32Array; private readonly len: number;
  private idx = 0; private readonly g: number;
  constructor(lengthSamples: number, g: number) {
    this.len = Math.max(2, Math.round(lengthSamples));
    this.buf = new Float32Array(this.len);
    this.g = g;
  }
  reset(): void { this.buf.fill(0); this.idx = 0; }
  process(x: number): number {
    const d = this.buf[this.idx] as number;
    const y = d - this.g * x;
    this.buf[this.idx] = flush(x + this.g * y);
    this.idx++; if (this.idx >= this.len) this.idx = 0;
    return y;
  }
}

// A, E, I, O, U — three formant centres each, as natural logs so that morphing
// between vowels is a plain interpolation.
const FORMANT_HZ = [730, 1090, 2440, 530, 1840, 2480, 270, 2290, 3010, 570, 840, 2410, 300, 870, 2240];
export const FORMANT_LOG = new Float32Array(FORMANT_HZ.length);
for (let i = 0; i < FORMANT_HZ.length; i++) FORMANT_LOG[i] = Math.log(FORMANT_HZ[i] as number);

/** Parameter indices — chain and tests index by these, never by a literal. */
export const MAGIC_PARAM = {
  freezeCapture: 0, freezeLength: 1, freezeMix: 2, shimmerMix: 3, shimmerPitch: 4,
  shimmerFeedback: 5, shimmerSize: 6, shimmerDamp: 7, shiftHz: 8, shiftMix: 9,
  shiftRing: 10, vowelPos: 11, vowelMix: 12, vowelSharp: 13, stutterMix: 14,
  stutterChance: 15, stutterSlice: 16, stutterPitch: 17, stutterSeed: 18,
  tapeWear: 19, tapeWow: 20, tapeFlutter: 21,
} as const;

export const FX_MAGIC_DESCRIPTOR: EngineDescriptor = {
  id: 'fx-magic',
  name: 'Magic',
  colour: '#7DF9FF',
  macroNames: ['Suspend', 'Bloom', 'Alien', 'Wear'],
  params: [
    { id: 'freeze-capture', name: 'Capture', group: 'Freeze', unit: 'none',
      min: 0, max: 1, default: 0, curve: 'stepped', steps: 2, mutability: 0.1,
      explain: 'The trigger. Turn it on and the last slice of sound is caught and looped forever, so a chord you played half a second ago hangs in the air while you keep playing over the top of it. Turn it off and the held sound fades away.', },
    { id: 'freeze-length', name: 'Hold Length', group: 'Freeze', unit: 'ms',
      min: 40, max: 2000, default: 500, curve: 'exp', mutability: 0.6,
      explain: 'How much of the recent past gets caught when you capture. Short lengths turn a note into a buzzing drone with a pitch of its own; long lengths hold a whole phrase suspended and still recognisable.', },
    { id: 'freeze-mix', name: 'Suspend', group: 'Freeze', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', macro: 0, macroDepth: 0.9, mutability: 0.7,
      explain: 'How loud the frozen layer sits under what you are playing now. Raising it pulls the held sound forward and steps the live signal back, so one hand can play against a chord that nobody is holding down any more.', },
    { id: 'shimmer-mix', name: 'Shimmer', group: 'Shimmer', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', macro: 1, macroDepth: 0.8, mutability: 0.9,
      explain: 'Blends in a reverb tail that climbs in pitch as it decays. This is a note blooming upward into a cathedral instead of simply fading out, and it is the fastest way to make a small sound feel enormous.', },
    { id: 'shimmer-pitch', name: 'Bloom Interval', group: 'Shimmer', unit: 'semitones',
      min: 0, max: 12, default: 12, curve: 'linear', mutability: 0.7,
      explain: 'How far the tail is transposed each time round the loop. 12 is the classic octave halo; 7 gives a fifth that stacks into a chord; small values detune the tail into a shivering cloud rather than climbing.', },
    { id: 'shimmer-feedback', name: 'Regeneration', group: 'Shimmer', unit: 'pct',
      min: 0, max: 1, default: 0.6, curve: 'linear', mutability: 0.8,
      explain: 'How much of the tail is fed back to be transposed again, stacking octave on octave into a rising choir. It is clamped below unity on purpose, so however far you push it the tail always decays in the end.', },
    { id: 'shimmer-size', name: 'Size', group: 'Shimmer', unit: 'ms',
      min: 20, max: 500, default: 180, curve: 'exp', mutability: 0.7,
      explain: 'The length of the space the tail circulates in. Small sizes ring like a bright metal room; large sizes space the rising octaves far enough apart that you hear each one arrive separately.', },
    { id: 'shimmer-damp', name: 'Damping', group: 'Shimmer', unit: 'pct',
      min: 0, max: 1, default: 0.4, curve: 'linear', mutability: 0.7,
      explain: 'Takes a little more top off the tail on every pass, the way air and soft furnishings absorb high frequencies in a real room. Without it a shimmer climbs until there is nothing left but hiss.', },
    { id: 'shift-hz', name: 'Shift', group: 'Frequency Shifter', unit: 'hz',
      min: -1000, max: 1000, default: 0, curve: 'linear', mutability: 0.9,
      explain: 'Moves every frequency by the same number of Hz rather than the same musical interval, so harmonics stop being whole-number multiples of the note. A few Hz gives eerie slow beating; hundreds turn anything into struck metal with no pitch left at all.', },
    { id: 'shift-mix', name: 'Alien', group: 'Frequency Shifter', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', macro: 2, macroDepth: 0.8, mutability: 0.9,
      explain: 'How much of the shifted signal replaces the original. Halfway leaves the real pitch audible underneath, which is what makes the clang sound like it belongs to the note rather than to a separate machine in the room.', },
    { id: 'shift-ring', name: 'Ring', group: 'Frequency Shifter', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', mutability: 0.8,
      explain: 'Morphs from true single-sideband shifting toward plain ring modulation, which produces the sum and the difference at once. Ring is harsher and more symmetrical; shifting is stranger and more liquid.', },
    { id: 'vowel-pos', name: 'Vowel', group: 'Formant', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', mutability: 0.9,
      explain: 'Sweeps three resonances through the shapes a human mouth makes, A to E to I to O to U. Everywhere in between is a mouth position nobody can hold, which is where it stops sounding like a filter and starts sounding like a voice.', },
    { id: 'vowel-mix', name: 'Speak', group: 'Formant', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', mutability: 0.9,
      explain: 'How much of the vowel filtering replaces the plain sound. A little makes the tone nasal and vocal; full makes the synth talk, with whatever you are playing acting as the vocal cords.', },
    { id: 'vowel-sharp', name: 'Sharpness', group: 'Formant', unit: 'pct',
      min: 0, max: 1, default: 0.6, curve: 'linear', mutability: 0.7,
      explain: 'How narrow the three resonances are. Wide is a soft breathy vowel; narrow is a tight shouted one that rings on for a moment after the note itself has stopped.', },
    { id: 'stutter-mix', name: 'Stutter', group: 'Stutter', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', mutability: 0.8,
      explain: 'How completely a repeat takes over from the live signal while it runs. Partial amounts leave the real performance audible underneath the glitch, which reads as an effect rather than as a mistake.', },
    { id: 'stutter-chance', name: 'Chance', group: 'Stutter', unit: 'pct',
      min: 0, max: 1, default: 0.35, curve: 'linear', mutability: 0.9,
      explain: 'The probability that any given slice gets caught and repeated. Low values falter now and then like a machine with a fault; at maximum every slice repeats and the glitch becomes the rhythm.', },
    { id: 'stutter-slice', name: 'Slice', group: 'Stutter', unit: 'ms',
      min: 20, max: 500, default: 120, curve: 'exp', mutability: 0.8,
      explain: 'The length of the chunk that gets repeated. Long slices sound like a beat repeat you could dance to; under about 50 ms the repetition happens fast enough to fuse into a pitch of its own.', },
    { id: 'stutter-pitch', name: 'Repeat Pitch', group: 'Stutter', unit: 'semitones',
      min: -12, max: 12, default: 0, curve: 'linear', mutability: 0.8,
      explain: 'Transposes each repeat relative to the one before, so a stutter falls into a hole or climbs away from you instead of sitting still. Zero is the straight mechanical repeat.', },
    { id: 'stutter-seed', name: 'Seed', group: 'Stutter', unit: 'none',
      min: 1, max: 9999, default: 1337, curve: 'stepped', steps: 9999, mutability: 0.4,
      explain: 'Chooses which random sequence the stutter follows. The randomness is genuine but repeatable, so the same seed always glitches in exactly the same places and a take you liked can be played again.', },
    { id: 'tape-wear', name: 'Wear', group: 'Tape', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', macro: 3, macroDepth: 0.8, mutability: 0.9,
      explain: 'Drives the signal into tape saturation and progressively loses the top end, the way a reel that has been round the machine too many times does. This is the cheapest way to stop digital sound feeling weightless.', },
    { id: 'tape-wow', name: 'Wow', group: 'Tape', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', mutability: 0.9,
      explain: 'Slow pitch drift, about once a second, from a reel that is not perfectly round. A little makes sustained notes breathe instead of standing dead still; a lot sounds seasick and broken.', },
    { id: 'tape-flutter', name: 'Flutter', group: 'Tape', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', mutability: 0.9,
      explain: 'Fast pitch wobble from the capstan and the guide rollers. Too quick to hear as pitch, so instead it adds a grainy unsteady texture that the ear reads as "recorded on something physical".', },
  ],
};

/**
 * TAPE. Wow (slow) and flutter (fast) as pitch modulation of a short delay line,
 * plus saturation and high-frequency loss that both climb with wear. This is
 * what stops a digital signal sounding weightless.
 */
export class Tape {
  private readonly line: DelayLine; private readonly sr: number; private readonly base: number;
  private wowPh = 0; private fl1 = 0; private fl2 = 0; private lp = 0;
  constructor(sr: number) {
    this.sr = sr;
    this.base = sr * 0.006;
    this.line = new DelayLine(Math.round(sr * 0.02));
  }
  reset(): void { this.line.reset(); this.wowPh = 0; this.fl1 = 0; this.fl2 = 0; this.lp = 0; }
  process(x: number, wear: number, wow: number, flutter: number): number {
    this.wowPh += (TWO_PI * 0.73) / this.sr; if (this.wowPh > TWO_PI) this.wowPh -= TWO_PI;
    this.fl1 += (TWO_PI * 7.3) / this.sr; if (this.fl1 > TWO_PI) this.fl1 -= TWO_PI;
    this.fl2 += (TWO_PI * 11.9) / this.sr; if (this.fl2 > TWO_PI) this.fl2 -= TWO_PI;
    const mod = this.sr * (wow * 0.0028 * Math.sin(this.wowPh)
      + flutter * 0.00035 * (Math.sin(this.fl1) * 0.7 + Math.sin(this.fl2) * 0.3));
    this.line.write(x);
    const d = this.line.read(this.base + mod);
    const hot = saturate(d * (1 + wear * 5)) / (1 + wear * 1.6);
    const y = d + (hot - d) * wear;
    // One-pole tone control; approximating the coefficient saves a per-sample
    // exp() and is well inside "close enough" for tape rolloff.
    let c = (TWO_PI * (18000 - 15200 * wear)) / this.sr;
    if (c > 0.99) c = 0.99;
    this.lp = flush(this.lp + c * (y - this.lp));
    return this.lp;
  }
}

/** Crossfade dry toward wet. Every effect in the chain is mixed through this. */
export function blend(dry: number, wet: number, m: number): number { return dry + (wet - dry) * m; }

/**
 * FREQUENCY SHIFTER. Not a pitch shifter: every partial moves by the same
 * number of Hz, so 100 + 200 + 300 becomes 150 + 250 + 350 and the harmonic
 * series stops being one — the source of every alien sound in here. `ring`
 * morphs across to ring modulation, which keeps both sidebands.
 */
export class FreqShifter {
  private readonly hil = new HilbertPair();
  private readonly sr: number;
  private phase = 0;
  constructor(sr: number) { this.sr = sr; }
  reset(): void { this.hil.reset(); this.phase = 0; }
  process(x: number, hz: number, ring: number): number {
    this.hil.process(x);
    let ph = this.phase + (TWO_PI * hz) / this.sr;
    if (ph > Math.PI) ph -= TWO_PI; else if (ph < -Math.PI) ph += TWO_PI;
    this.phase = ph;
    const c = Math.cos(ph), s = Math.sin(ph);
    // i lags q by 90°, so summing the products keeps the upper sideband — a
    // positive shift has to move the spectrum up, not down.
    return blend(this.hil.i * c + this.hil.q * s, x * c, ring);
  }
}
