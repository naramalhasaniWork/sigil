/** polyBLEP residual for a step discontinuity at phase `t` with increment `dt`. */
export function blep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/**
 * Antialiased sawtooth. A naive saw aliases badly above a few kHz, which is
 * the difference between "digital" and "harsh".
 */
export class SawOscillator {
  private phase = 0;
  private inc = 0;
  private readonly sr: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
  }

  setFrequency(hz: number): void {
    this.inc = hz / this.sr;
  }

  reset(): void {
    this.phase = 0;
  }

  next(): number {
    this.phase += this.inc;
    if (this.phase >= 1) this.phase -= 1;
    return 2 * this.phase - 1 - blep(this.phase, this.inc);
  }
}
