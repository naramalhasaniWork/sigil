/**
 * One-pole parameter smoother. Every parameter passes through one of these:
 * un-smoothed parameter changes produce zipper noise, which is the most
 * common reason a digital synth sounds cheap.
 */
export class Smoother {
  private current = 0;
  private target = 0;
  private readonly coeff: number;

  constructor(sampleRate: number, timeMs: number) {
    this.coeff = 1 - Math.exp(-1 / ((timeMs / 1000) * sampleRate));
  }

  setTarget(v: number): void {
    this.target = v;
  }

  snap(v: number): void {
    this.current = v;
    this.target = v;
  }

  next(): number {
    this.current += this.coeff * (this.target - this.current);
    if (this.current < 1e-20 && this.current > -1e-20) this.current = 0;
    return this.current;
  }
}
