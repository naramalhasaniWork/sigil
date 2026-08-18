const DENORMAL = 1e-20;

/** Cheap rational tanh — monotonic, bounded, shaped for hot loops. */
function saturate(x: number): number {
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/** 4-pole transistor-ladder-style lowpass with saturating feedback. */
export class LadderFilter {
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;
  private s4 = 0;
  private g = 0;
  private feedback = 0;
  private readonly sr: number;
  private readonly maxCutoff: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.maxCutoff = sampleRate * 0.45;
    this.setCutoff(1000);
    this.setResonance(0);
  }

  setCutoff(hz: number): void {
    const c = hz < 10 ? 10 : hz > this.maxCutoff ? this.maxCutoff : hz;
    this.g = 1 - Math.exp((-2 * Math.PI * c) / this.sr);
  }

  setResonance(r: number): void {
    const clamped = r < 0 ? 0 : r > 1 ? 1 : r;
    this.feedback = clamped * 4.0;
  }

  reset(): void {
    this.s1 = 0;
    this.s2 = 0;
    this.s3 = 0;
    this.s4 = 0;
  }

  process(x: number): number {
    const fb = this.feedback * (this.s4 - 0.5 * this.s3);
    const input = saturate(x - fb);

    this.s1 += this.g * (input - this.s1);
    this.s2 += this.g * (this.s1 - this.s2);
    this.s3 += this.g * (this.s2 - this.s3);
    this.s4 += this.g * (this.s3 - this.s4);

    if (this.s1 < DENORMAL && this.s1 > -DENORMAL) this.s1 = 0;
    if (this.s2 < DENORMAL && this.s2 > -DENORMAL) this.s2 = 0;
    if (this.s3 < DENORMAL && this.s3 > -DENORMAL) this.s3 = 0;
    if (this.s4 < DENORMAL && this.s4 > -DENORMAL) this.s4 = 0;

    return this.s4;
  }
}
