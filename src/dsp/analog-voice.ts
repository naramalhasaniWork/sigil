import type { EngineModule, EngineVoice } from '@/audio/types';
import { ANALOG_DESCRIPTOR } from './analog-descriptor';
import { SawOscillator } from './blep';
import { LadderFilter } from './ladder';
import { Envelope } from './envelope';
import { Smoother } from './smoothing';

const P_DETUNE = 0;
const P_DRIFT = 1;
const P_CUTOFF = 2;
const P_RES = 3;
const P_FILTER_ENV = 4;
const P_ATTACK = 5;
const P_DECAY = 6;
const P_SUSTAIN = 7;
const P_RELEASE = 8;
const P_DRIVE = 9;

function saturate(x: number): number {
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

class AnalogVoice implements EngineVoice {
  private readonly osc1: SawOscillator;
  private readonly osc2: SawOscillator;
  private readonly filter: LadderFilter;
  private readonly ampEnv: Envelope;
  private readonly filterEnv: Envelope;
  private readonly cutoffSmooth: Smoother;

  private readonly params = new Float32Array(ANALOG_DESCRIPTOR.params.length);
  private baseFreq = 220;
  private velocity = 1;
  private active = false;

  private driftPhase = 0;
  private readonly driftInc: number;

  constructor(sampleRate: number) {
    this.osc1 = new SawOscillator(sampleRate);
    this.osc2 = new SawOscillator(sampleRate);
    this.filter = new LadderFilter(sampleRate);
    this.ampEnv = new Envelope(sampleRate);
    this.filterEnv = new Envelope(sampleRate);
    this.cutoffSmooth = new Smoother(sampleRate, 8);
    this.driftInc = 0.13 / sampleRate;
    for (let i = 0; i < ANALOG_DESCRIPTOR.params.length; i++) {
      this.params[i] = ANALOG_DESCRIPTOR.params[i]?.default ?? 0;
    }
    this.cutoffSmooth.snap(this.params[P_CUTOFF] as number);
  }

  setParam(index: number, value: number): void {
    if (index < 0 || index >= this.params.length) return;
    this.params[index] = value;
    if (
      index === P_ATTACK || index === P_DECAY ||
      index === P_SUSTAIN || index === P_RELEASE
    ) {
      this.applyEnvelopes();
    }
  }

  private applyEnvelopes(): void {
    this.ampEnv.set(
      this.params[P_ATTACK] as number,
      this.params[P_DECAY] as number,
      this.params[P_SUSTAIN] as number,
      this.params[P_RELEASE] as number,
    );
    this.filterEnv.set(
      this.params[P_ATTACK] as number,
      (this.params[P_DECAY] as number) * 0.8,
      (this.params[P_SUSTAIN] as number) * 0.5,
      this.params[P_RELEASE] as number,
    );
  }

  noteOn(freq: number, velocity: number, voiceIndex: number): void {
    this.baseFreq = freq;
    this.velocity = velocity;
    this.active = true;
    this.driftPhase = (voiceIndex * 0.37) % 1;
    this.filter.reset();
    this.applyEnvelopes();
    this.ampEnv.trigger();
    this.filterEnv.trigger();
    this.cutoffSmooth.snap(this.params[P_CUTOFF] as number);
  }

  noteOff(): void {
    this.ampEnv.release();
    this.filterEnv.release();
  }

  /**
   * True only once a note has been triggered and its amp envelope has run out.
   * A freshly allocated voice reports false; VoiceManager only asks about
   * slots it has marked busy, so that is correct but worth knowing.
   */
  isFinished(): boolean {
    return this.active && this.ampEnv.isFinished();
  }

  render(out: Float32Array, offset: number, count: number): void {
    if (!this.active) return;

    const detuneRatio = Math.pow(2, (this.params[P_DETUNE] as number) / 12);
    const driftAmt = this.params[P_DRIFT] as number;
    const envAmt = this.params[P_FILTER_ENV] as number;
    const drive = 1 + (this.params[P_DRIVE] as number) * 6;
    const driveComp = 1 / Math.sqrt(drive);

    this.filter.setResonance(this.params[P_RES] as number);
    this.cutoffSmooth.setTarget(this.params[P_CUTOFF] as number);

    for (let i = 0; i < count; i++) {
      this.driftPhase += this.driftInc;
      if (this.driftPhase > 1) this.driftPhase -= 1;
      const drift = Math.sin(this.driftPhase * 6.283185307) * driftAmt * 0.012;

      this.osc1.setFrequency(this.baseFreq * (1 + drift));
      this.osc2.setFrequency(this.baseFreq * detuneRatio * (1 - drift));

      let sig = (this.osc1.next() + this.osc2.next()) * 0.4;
      sig = saturate(sig * drive) * driveComp;

      const fenv = this.filterEnv.next();
      this.filter.setCutoff(this.cutoffSmooth.next() * (1 + envAmt * fenv * 6));

      const y = this.filter.process(sig) * this.ampEnv.next() * this.velocity * 0.35;
      out[offset + i] = (out[offset + i] as number) + (y === y ? y : 0);
    }
  }
}

export const AnalogEngine: EngineModule = {
  descriptor: ANALOG_DESCRIPTOR,
  allocVoice: (sampleRate: number): EngineVoice => new AnalogVoice(sampleRate),
};
