const IDLE = 0;
const ATTACK = 1;
const DECAY = 2;
const SUSTAIN = 3;
const RELEASE = 4;

/**
 * ADSR with exponential curvature. Linear ramps sound artificial; the curve
 * is what makes an envelope feel analog.
 */
export class Envelope {
  private stage = IDLE;
  private value = 0;
  private attackCoeff = 0;
  private decayCoeff = 0;
  private releaseCoeff = 0;
  private sustainLevel = 0.7;
  private readonly sr: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.set(5, 100, 0.7, 200);
  }

  private coeff(ms: number): number {
    const samples = Math.max(1, (ms / 1000) * this.sr);
    return 1 - Math.exp(-1 / (samples / 4));
  }

  set(attackMs: number, decayMs: number, sustain: number, releaseMs: number): void {
    this.attackCoeff = this.coeff(attackMs);
    this.decayCoeff = this.coeff(decayMs);
    this.releaseCoeff = this.coeff(releaseMs);
    this.sustainLevel = sustain < 0 ? 0 : sustain > 1 ? 1 : sustain;
  }

  trigger(): void {
    this.stage = ATTACK;
  }

  release(): void {
    if (this.stage !== IDLE) this.stage = RELEASE;
  }

  isFinished(): boolean {
    return this.stage === IDLE;
  }

  next(): number {
    if (this.stage === ATTACK) {
      this.value += this.attackCoeff * (1.2 - this.value);
      if (this.value >= 1) {
        this.value = 1;
        this.stage = DECAY;
      }
    } else if (this.stage === DECAY) {
      this.value += this.decayCoeff * (this.sustainLevel - this.value);
      if (Math.abs(this.value - this.sustainLevel) < 1e-4) {
        this.value = this.sustainLevel;
        this.stage = SUSTAIN;
      }
    } else if (this.stage === RELEASE) {
      this.value += this.releaseCoeff * (0 - this.value);
      if (this.value < 1e-5) {
        this.value = 0;
        this.stage = IDLE;
      }
    }
    return this.value;
  }
}
