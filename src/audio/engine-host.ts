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

/**
 * How hard the audio thread is being pushed.
 *
 * `latencyHint` can only be set when an AudioContext is CONSTRUCTED, so
 * changing this means tearing the graph down and building a new one — which is
 * exactly what `dispose()` exists for. The values are the Web Audio categories
 * rather than raw seconds because the browser knows the device better than a
 * number picked here does; a fixed buffer that is right on one machine is a
 * crackle or a lag on another.
 */
export type LatencyProfile = 'responsive' | 'balanced' | 'stable';

const LATENCY_HINT: Readonly<Record<LatencyProfile, AudioContextLatencyCategory>> = {
  responsive: 'interactive',
  balanced: 'balanced',
  stable: 'playback',
};

export interface LatencyReadout {
  /** What the graph adds before the samples reach the device, in ms. */
  readonly baseMs: number;
  /** What the device adds after that, in ms. Zero where unreported. */
  readonly outputMs: number;
  /** The number to put in a DAW's track delay. */
  readonly totalMs: number;
  /** False when the browser does not report latency at all — do not show 0.0. */
  readonly reported: boolean;
}

export class EngineHost {
  private ctx: AudioContext | null = null;
  private profile: LatencyProfile = 'responsive';
  private node: AudioWorkletNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  /** Resolver for the in-flight capture, settled when the worklet posts back. */
  /** Resolves with null when a capture is abandoned — see dispose(). */
  private capturePending: ((r: CaptureResult | null) => void) | null = null;
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

  get latencyProfile(): LatencyProfile {
    return this.profile;
  }

  /**
   * Round-trip latency, for a DAW's track delay.
   *
   * `baseLatency` is what the graph adds; `outputLatency` is what the device
   * adds after it. Both are optional in the spec and Firefox has historically
   * reported neither, so `reported` exists to stop the UI showing a confident
   * 0.0 ms that is really "no idea" — a wrong number here is worse than no
   * number, because someone will type it into Live and trust it.
   */
  get latency(): LatencyReadout {
    const ctx = this.ctx;
    if (ctx === null) return { baseMs: 0, outputMs: 0, totalMs: 0, reported: false };
    const base = typeof ctx.baseLatency === 'number' ? ctx.baseLatency : Number.NaN;
    const out = typeof ctx.outputLatency === 'number' ? ctx.outputLatency : Number.NaN;
    const reported = Number.isFinite(base) || Number.isFinite(out);
    const baseMs = Number.isFinite(base) ? base * 1000 : 0;
    const outputMs = Number.isFinite(out) ? out * 1000 : 0;
    return { baseMs, outputMs, totalMs: baseMs + outputMs, reported };
  }

  /**
   * Switch buffer profile. Rebuilds the graph, because latencyHint is fixed at
   * construction. Audio stops for the moment it takes, which is why this is a
   * setup-panel control and not something to reach for mid-take.
   */
  async setLatencyProfile(profile: LatencyProfile): Promise<void> {
    if (profile === this.profile && this.ctx !== null) return;
    const wasRunning = this.ctx !== null;
    await this.dispose();
    this.profile = profile;
    if (wasRunning) await this.start(profile);
  }

  /**
   * Tear the whole graph down and release the audio device.
   *
   * Without this, every remount of the controlling hook built a SECOND
   * AudioWorkletNode onto the same destination while the first kept running.
   * Two engines summing into one output comb-filter each other, which does not
   * sound like a crash — it sounds like the instrument lost its clarity, and
   * Panic cannot clear it because Panic only reaches the host the UI is
   * currently holding. In development, editing this hook was enough to trigger
   * it; a plugin host that instantiates and destroys editors would hit the same
   * thing.
   *
   * Safe to call twice, and safe to call before start().
   */
  async dispose(): Promise<void> {
    // Silence first: releasing voices before the graph goes away avoids a
    // buffer of half-finished notes being cut mid-cycle, which clicks.
    this.node?.port.postMessage({ type: 'allNotesOff' });

    // A pending capture will never resolve once the node is gone. Settle it
    // rather than leaving an await hanging forever.
    const pending = this.capturePending;
    this.capturePending = null;
    this.capturingFlag = false;
    pending?.(null);

    if (this.node !== null) {
      this.node.port.onmessage = null;
      this.node.port.close();
      this.node.disconnect();
    }
    this.analyserNode?.disconnect();

    const ctx = this.ctx;
    this.node = null;
    this.analyserNode = null;
    this.ctx = null;
    // Closing releases the hardware device; browsers cap how many contexts a
    // page may hold, so leaking them eventually fails to start audio at all.
    if (ctx !== null && ctx.state !== 'closed') await ctx.close();
  }

  async start(profile: LatencyProfile = this.profile): Promise<void> {
    if (this.ctx) {
      // Already running. A profile change cannot be applied to a live context,
      // so it is the caller's job to restart — see setLatencyProfile.
      await this.ctx.resume();
      return;
    }
    this.profile = profile;
    const ctx = new AudioContext({ latencyHint: LATENCY_HINT[profile] });
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
