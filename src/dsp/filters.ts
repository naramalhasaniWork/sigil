import { LadderFilter } from '@/dsp/ladder';

/**
 * The three filter models, behind one interface.
 *
 * A synth's filter is most of its personality, so SIGIL ships three that fail
 * in different, musical ways: the transistor ladder (see `@/dsp/ladder`), a
 * clean state-variable filter, and a squelchy diode ladder. Every model is
 * allocation-free per sample, denormal-guarded, and bounded by construction —
 * the saturators here are hard-limited, so no parameter combination can make a
 * filter run away, whatever the modulation does to it.
 */

const DENORMAL = 1e-20;
const MIN_CUTOFF = 10;
/** Anything past ~0.49 * sr makes tan() explode; nobody hears up there anyway. */
const MAX_CUTOFF_RATIO = 0.49;

export interface Filter {
  setCutoff(hz: number): void;
  setResonance(r: number): void;
  reset(): void;
  process(x: number): number;
}

export type SvfMode = 'lp' | 'bp' | 'hp';
export type FilterModel = 'ladder' | 'svf' | 'diode';

/**
 * Exactly linear below `knee`, then a quadratic knee to a hard ceiling of
 * `knee + span / 2`. Linear-below-threshold matters: a saturator that bends
 * even slightly at normal levels leaks energy out of a resonator every single
 * sample and quietly kills the resonance.
 */
function softLimit(x: number, knee: number, span: number): number {
  const a = x < 0 ? -x : x;
  if (a <= knee) return x;
  const over = a - knee;
  const lim = over >= span ? knee + span * 0.5 : knee + over * (1 - over / (span + span));
  return x < 0 ? -lim : lim;
}

/** Diode pairs conduct unevenly: the positive half folds over twice as early. */
function asymSat(x: number): number {
  return x >= 0 ? softLimit(x, 0.7, 1.4) : softLimit(x, 1.4, 2.8);
}

/**
 * 12 dB/oct state-variable filter, TPT (topology-preserving transform) form.
 * The zero-delay feedback path is solved algebraically each sample, so the
 * cutoff you ask for is the cutoff you get, right up to Nyquist — the naive
 * Chamberlin SVF drifts sharp and then blows up somewhere above sr/6.
 */
export class StateVariableFilter implements Filter {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private g = 0;
  private k = 2;
  private cLp = 1;
  private cBp = 0;
  private cHp = 0;
  private readonly sr: number;
  private readonly maxCutoff: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.maxCutoff = sampleRate * MAX_CUTOFF_RATIO;
    this.setCutoff(1000);
    this.setResonance(0);
  }

  setCutoff(hz: number): void {
    const c = hz < MIN_CUTOFF ? MIN_CUTOFF : hz > this.maxCutoff ? this.maxCutoff : hz;
    this.g = Math.tan((Math.PI * c) / this.sr);
    this.updateCoeffs();
  }

  /** 0 = flat, 1 = a ~30 dB peak that rings for a long time. */
  setResonance(r: number): void {
    const clamped = r < 0 ? 0 : r > 1 ? 1 : r;
    this.k = 2 - 1.97 * clamped;
    this.updateCoeffs();
  }

  setMode(mode: SvfMode): void {
    this.cLp = mode === 'lp' ? 1 : 0;
    this.cBp = mode === 'bp' ? 1 : 0;
    this.cHp = mode === 'hp' ? 1 : 0;
  }

  reset(): void {
    this.ic1 = 0;
    this.ic2 = 0;
  }

  private updateCoeffs(): void {
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }

  process(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;

    let s1 = v1 + v1 - this.ic1;
    let s2 = v2 + v2 - this.ic2;
    // Limiting the integrator states (not the feedback) is what bounds
    // self-oscillation: less energy in, never less damping.
    s1 = softLimit(s1, 3, 6);
    s2 = softLimit(s2, 3, 6);
    if (s1 < DENORMAL && s1 > -DENORMAL) s1 = 0;
    if (s2 < DENORMAL && s2 > -DENORMAL) s2 = 0;
    this.ic1 = s1;
    this.ic2 = s2;

    const out = this.cLp * v2 + this.cBp * v1 + this.cHp * (x - this.k * v1 - v2);
    if (!(out > -1e12 && out < 1e12)) {
      this.reset();
      return 0;
    }
    return out;
  }
}

/**
 * 24 dB/oct diode-ladder lowpass. Four zero-delay one-pole sections solved as
 * one loop, with the feedback amplifier clipping asymmetrically — that lopsided
 * clip is where the squelch comes from: as resonance rises the loop bites into
 * the waveform unevenly, generating even harmonics the ladder never makes.
 */
export class DiodeFilter implements Filter {
  private z1 = 0;
  private z2 = 0;
  private z3 = 0;
  private z4 = 0;
  private g1 = 0;
  private g2 = 0;
  private g3 = 0;
  private g4 = 0;
  private oneMinusG = 0;
  private invDen = 1;
  private k = 0;
  private readonly sr: number;
  private readonly maxCutoff: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.maxCutoff = sampleRate * MAX_CUTOFF_RATIO;
    this.setCutoff(1000);
    this.setResonance(0);
  }

  setCutoff(hz: number): void {
    const c = hz < MIN_CUTOFF ? MIN_CUTOFF : hz > this.maxCutoff ? this.maxCutoff : hz;
    const g = Math.tan((Math.PI * c) / this.sr);
    const gg = g / (1 + g);
    this.g1 = gg;
    this.g2 = gg * gg;
    this.g3 = this.g2 * gg;
    this.g4 = this.g3 * gg;
    this.oneMinusG = 1 - gg;
    this.updateDen();
  }

  /** Past ~0.9 the loop gain passes unity and the filter sings on its own. */
  setResonance(r: number): void {
    const clamped = r < 0 ? 0 : r > 1 ? 1 : r;
    this.k = 4.5 * clamped;
    this.updateDen();
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
    this.z3 = 0;
    this.z4 = 0;
  }

  private updateDen(): void {
    this.invDen = 1 / (1 + this.k * this.g4);
  }

  process(x: number): number {
    const s1 = this.oneMinusG * this.z1;
    const s2 = this.oneMinusG * this.z2;
    const s3 = this.oneMinusG * this.z3;
    const s4 = this.oneMinusG * this.z4;

    // Closed-form solution of the four-pole loop one sample ahead of itself.
    const sfb = this.g3 * s1 + this.g2 * s2 + this.g1 * s3 + s4;
    const yLin = (this.g4 * x + sfb) * this.invDen;
    const u = x - this.k * asymSat(yLin);

    const y1 = this.g1 * u + s1;
    this.z1 = y1 + y1 - this.z1;
    const y2 = this.g1 * y1 + s2;
    this.z2 = y2 + y2 - this.z2;
    const y3 = this.g1 * y2 + s3;
    this.z3 = y3 + y3 - this.z3;
    const y4 = this.g1 * y3 + s4;
    this.z4 = y4 + y4 - this.z4;

    if (this.z1 < DENORMAL && this.z1 > -DENORMAL) this.z1 = 0;
    if (this.z2 < DENORMAL && this.z2 > -DENORMAL) this.z2 = 0;
    if (this.z3 < DENORMAL && this.z3 > -DENORMAL) this.z3 = 0;
    if (this.z4 < DENORMAL && this.z4 > -DENORMAL) this.z4 = 0;

    if (!(y4 > -1e12 && y4 < 1e12)) {
      this.reset();
      return 0;
    }
    return y4;
  }
}

/** The one place that knows which class a model name means. */
export function createFilter(model: FilterModel, sampleRate: number): Filter {
  if (model === 'svf') return new StateVariableFilter(sampleRate);
  if (model === 'diode') return new DiodeFilter(sampleRate);
  return new LadderFilter(sampleRate);
}
