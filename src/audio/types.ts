export type ParamUnit = 'hz' | 'db' | 'ms' | 'ratio' | 'pct' | 'semitones' | 'none';
export type ParamCurve = 'linear' | 'exp' | 'log' | 'stepped';

export interface ParamDescriptor {
  id: string;
  name: string;
  group: string;
  unit: ParamUnit;
  min: number;
  max: number;
  default: number;
  curve: ParamCurve;
  steps?: number;
  macro?: 0 | 1 | 2 | 3;
  macroDepth?: number;
  /** How mutable this parameter is during Hunt, 0..1. Defaults to 0.5. */
  mutability?: number;
  /** Required. Plain language: what it does and why it matters. */
  explain: string;
}

export interface EngineDescriptor {
  id: string;
  name: string;
  colour: string;
  macroNames: readonly [string, string, string, string];
  params: readonly ParamDescriptor[];
}

export interface EngineVoice {
  noteOn(freq: number, velocity: number, voiceIndex: number): void;
  noteOff(): void;
  setParam(index: number, value: number): void;
  /** Additive into `out`. Must not allocate. */
  render(out: Float32Array, offset: number, count: number): void;
  isFinished(): boolean;
}

export interface EngineModule {
  readonly descriptor: EngineDescriptor;
  allocVoice(sampleRate: number): EngineVoice;
}
