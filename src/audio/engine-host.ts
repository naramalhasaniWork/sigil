import { packParams } from './param-transport';

/**
 * Main-thread facade over the audio graph. The UI never computes audio — it
 * sends messages and reads the analyser for visuals.
 */
export interface CaptureResult {
  /** Mono float samples of exactly what was heard. */
  data: Float32Array;
  sampleRate: number;
  /** True when recording stopped because it reached the 60 second ceiling. */
  hitLimit: boolean;
}

export class EngineHost {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  /** Resolver for the in-flight capture, settled when the worklet posts back. */
  private capturePending: ((r: CaptureResult) => void) | null = null;
  private capturingFlag = false;

  /** Exposed so sample decoding can reuse the live context instead of opening another. */
  get context(): AudioContext | null {
    return this.ctx;
  }

  get analyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  async start(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule('/worklet/sigil-processor.js');

    const node = new AudioWorkletNode(ctx, 'sigil-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.7;

    const master = ctx.createGain();
    master.gain.value = 0.9;

    node.connect(analyser);
    analyser.connect(master);
    master.connect(ctx.destination);

    node.port.onmessage = (e: MessageEvent<unknown>): void => {
      const msg = e.data;
      if (
        typeof msg !== 'object' || msg === null ||
        (msg as { type?: unknown }).type !== 'recording'
      ) return;
      const r = msg as { data: Float32Array; sampleRate: number; hitLimit: boolean };
      this.capturingFlag = false;
      const resolve = this.capturePending;
      this.capturePending = null;
      resolve?.({ data: r.data, sampleRate: r.sampleRate, hitLimit: r.hitLimit });
    };

    this.ctx = ctx;
    this.node = node;
    this.analyserNode = analyser;
  }

  noteOn(note: number, velocity: number): void {
    this.node?.port.postMessage({ type: 'noteOn', note, velocity });
  }

  noteOff(note: number): void {
    this.node?.port.postMessage({ type: 'noteOff', note });
  }

  allNotesOff(): void {
    this.node?.port.postMessage({ type: 'allNotesOff' });
  }

  setEngine(engineId: string): void {
    this.node?.port.postMessage({ type: 'setEngine', engineId });
  }

  setTuning(divisions: number, refNote: number, refHz: number): void {
    this.node?.port.postMessage({ type: 'tuning', divisions, refNote, refHz });
  }

  setParam(index: number, value: number): void {
    const data = packParams([[index, value]]);
    this.node?.port.postMessage({ type: 'params', data }, [data.buffer]);
  }

  /**
   * Hands sample audio to the worklet. The buffer is transferred rather than
   * copied, so `data` becomes unusable on this side afterwards — pass a copy if
   * the caller still needs it.
   */
  loadSample(data: Float32Array, sampleRate: number, rootHz: number): void {
    this.node?.port.postMessage(
      { type: 'loadSample', data, sampleRate, rootHz },
      [data.buffer],
    );
  }

  /** Bulk update — used by presets and by Hunt, which change everything at once. */
  setAllParams(values: Float32Array): void {
    const pairs: Array<readonly [number, number]> = [];
    for (let i = 0; i < values.length; i++) pairs.push([i, values[i] as number]);
    const data = packParams(pairs);
    this.node?.port.postMessage({ type: 'params', data }, [data.buffer]);
  }

  /**
   * Live capture of what you actually play, as opposed to an offline patch
   * bounce. The worklet records its own output and hands back raw samples, so
   * the result can be encoded as a true WAV — MediaRecorder only ever produces
   * WebM or MP4 and could never serve the KO II workflow.
   */
  startCapture(): boolean {
    if (!this.node || this.capturingFlag) return false;
    this.capturingFlag = true;
    this.node.port.postMessage({ type: 'recordStart' });
    return true;
  }

  stopCapture(): Promise<CaptureResult | null> {
    const node = this.node;
    if (!node || !this.capturingFlag) return Promise.resolve(null);
    return new Promise<CaptureResult | null>((resolve) => {
      this.capturePending = resolve;
      node.port.postMessage({ type: 'recordStop' });
    });
  }

  get isRecording(): boolean {
    return this.capturingFlag;
  }
}
