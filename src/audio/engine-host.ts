import { packParams } from './param-transport';

/**
 * Main-thread facade over the audio graph. The UI never computes audio — it
 * sends messages and reads the analyser for visuals.
 */
export class EngineHost {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private recorder: MediaRecorder | null = null;
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  private chunks: Blob[] = [];

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

    const recordDest = ctx.createMediaStreamDestination();
    master.connect(recordDest);

    this.ctx = ctx;
    this.node = node;
    this.analyserNode = analyser;
    this.recordDest = recordDest;
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

  /** Bulk update — used by presets and by Hunt, which change everything at once. */
  setAllParams(values: Float32Array): void {
    const pairs: Array<readonly [number, number]> = [];
    for (let i = 0; i < values.length; i++) pairs.push([i, values[i] as number]);
    const data = packParams(pairs);
    this.node?.port.postMessage({ type: 'params', data }, [data.buffer]);
  }

  /** Live capture of whatever you play, as opposed to an offline patch bounce. */
  startRecording(): boolean {
    if (!this.recordDest || this.recorder) return false;
    this.chunks = [];
    const rec = new MediaRecorder(this.recordDest.stream);
    rec.ondataavailable = (e): void => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    rec.start();
    this.recorder = rec;
    return true;
  }

  async stopRecording(): Promise<Blob | null> {
    const rec = this.recorder;
    if (!rec) return null;
    const done = new Promise<void>((resolve) => {
      rec.onstop = (): void => resolve();
    });
    rec.stop();
    await done;
    this.recorder = null;
    return this.chunks.length > 0 ? new Blob(this.chunks, { type: this.chunks[0]?.type }) : null;
  }

  get isRecording(): boolean {
    return this.recorder !== null;
  }
}
