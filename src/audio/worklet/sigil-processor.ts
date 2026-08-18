import { VoiceManager } from '@/dsp/voice-manager';
import { ENGINES, DEFAULT_ENGINE_ID } from '@/dsp/registry';
import { forEachParam } from '@/audio/param-transport';
import { sectionOf } from '@/audio/param-space';
import { FxChain } from '@/dsp/fx';
import { MagicChain } from '@/dsp/fx-magic';
import { setActiveSample } from '@/dsp/sampler-voice';

interface NoteOnMessage {
  type: 'noteOn';
  note: number;
  velocity: number;
}
interface NoteOffMessage {
  type: 'noteOff';
  note: number;
}
interface ParamMessage {
  type: 'params';
  data: Float32Array;
}
interface EngineMessage {
  type: 'setEngine';
  engineId: string;
}
interface TuningMessage {
  type: 'tuning';
  divisions: number;
  refNote: number;
  refHz: number;
}
interface AllNotesOffMessage {
  type: 'allNotesOff';
}
/**
 * Live capture. MediaRecorder can only give WebM or MP4, so a performance could
 * never leave as a WAV. Recording the worklet's own output means the bytes we
 * encode are exactly what was heard, at the context's sample rate.
 */
interface RecordStartMessage {
  type: 'recordStart';
}
interface RecordStopMessage {
  type: 'recordStop';
}
/**
 * Sample audio must cross the realm boundary explicitly. The worklet is bundled
 * separately, so it holds its OWN copy of every module — calling setActiveSample
 * on the main thread mutates a different instance entirely and the worklet never
 * sees it. This message is the only way a sample reaches the sampler.
 */
interface LoadSampleMessage {
  type: 'loadSample';
  data: Float32Array;
  sampleRate: number;
  rootHz: number;
}
type InboundMessage =
  | NoteOnMessage
  | NoteOffMessage
  | ParamMessage
  | EngineMessage
  | TuningMessage
  | AllNotesOffMessage
  | LoadSampleMessage
  | RecordStartMessage
  | RecordStopMessage;

declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: Record<string, unknown> });
}
declare function registerProcessor(
  name: string,
  ctor: new (options?: { processorOptions?: Record<string, unknown> }) => AudioWorkletProcessor,
): void;

/**
 * One VoiceManager per engine, all built up front. Switching engines is then a
 * pointer swap rather than an allocation on the audio thread.
 */
class SigilProcessor extends AudioWorkletProcessor {
  private readonly managers = new Map<string, VoiceManager>();
  private active: VoiceManager;
  private readonly fx: FxChain;
  private readonly magic: MagicChain;
  /**
   * Capture buffer, preallocated so process() never allocates. 60 seconds is a
   * deliberate ceiling: at 48kHz this is ~11.5MB resident, which is fine on a
   * desktop and still safe on a phone. Recording stops itself at the limit and
   * says so rather than silently truncating.
   */
  private readonly captureBuf: Float32Array;
  private capturing = false;
  private captureLen = 0;

  constructor(options?: { processorOptions?: Record<string, unknown> }) {
    super(options);

    this.fx = new FxChain(sampleRate);
    this.magic = new MagicChain(sampleRate);
    this.captureBuf = new Float32Array(Math.floor(sampleRate * 60));

    for (const engine of ENGINES) {
      this.managers.set(engine.descriptor.id, new VoiceManager(engine, sampleRate, 16));
    }
    const fallback = this.managers.get(DEFAULT_ENGINE_ID);
    if (!fallback) throw new Error('default engine missing from registry');
    this.active = fallback;

    // Offline rendering never delivers postMessage before it finishes, so the
    // bounce path configures the processor here instead. This mirrors
    // BounceProcessorOptions in src/audio/bounce.ts — keep them in step.
    const opts = options?.processorOptions;
    if (opts && opts['mode'] === 'bounce') {
      const engineId = opts['engineId'];
      if (typeof engineId === 'string') {
        const vm = this.managers.get(engineId);
        if (vm) this.active = vm;
      }
      const values = opts['patchParams'];
      if (values instanceof Float32Array) {
        for (let i = 0; i < values.length; i++) {
          this.active.setParam(i, values[i] as number);
        }
      }
      const releaseFrame = opts['releaseFrame'];
      if (typeof releaseFrame === 'number') this.releaseAtSample = releaseFrame;

      const velocityOpt = opts['velocity'];
      const velocity = typeof velocityOpt === 'number' ? velocityOpt : 1;
      const notes = opts['midiNotes'];
      if (Array.isArray(notes)) {
        for (const n of notes) {
          if (typeof n === 'number') {
            this.active.noteOn(n, velocity);
            this.bounceNotes.push(n);
          }
        }
      }
    }

    this.port.onmessage = (e: MessageEvent<InboundMessage>): void => {
      const msg = e.data;
      switch (msg.type) {
        case 'noteOn':
          this.active.noteOn(msg.note, msg.velocity);
          break;
        case 'noteOff':
          this.active.noteOff(msg.note);
          break;
        case 'params':
          forEachParam(msg.data, (address, v) => {
            const { section, index } = sectionOf(address);
            if (section === 'fx') this.fx.setParam(index, v);
            else if (section === 'magic') this.magic.setParam(index, v);
            else this.active.setParam(index, v);
          });
          break;
        case 'setEngine': {
          const next = this.managers.get(msg.engineId);
          if (next && next !== this.active) {
            this.active.allNotesOff();
            this.active = next;
          }
          break;
        }
        case 'tuning':
          for (const vm of this.managers.values()) {
            vm.tuning.setEqualDivisions(msg.divisions);
            vm.tuning.setReference(msg.refNote, msg.refHz);
          }
          break;
        case 'allNotesOff':
          this.active.allNotesOff();
          break;
        case 'loadSample':
          setActiveSample(msg.data, msg.sampleRate, msg.rootHz);
          break;
        case 'recordStart':
          this.captureLen = 0;
          this.capturing = true;
          break;
        case 'recordStop':
          this.finishCapture(false);
          break;
      }
    };
  }

  private releaseAtSample = -1;
  private readonly bounceNotes: number[] = [];
  private samplesRendered = 0;

  /** Hands the captured audio back. The one allocation here happens on stop. */
  private finishCapture(hitLimit: boolean): void {
    if (!this.capturing) return;
    this.capturing = false;
    const data = this.captureBuf.slice(0, this.captureLen);
    this.port.postMessage(
      { type: 'recording', data, sampleRate, frames: this.captureLen, hitLimit },
      [data.buffer],
    );
    this.captureLen = 0;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output) return true;
    const left = output[0];
    if (!left) return true;

    left.fill(0);
    this.active.render(left, left.length);
    this.fx.process(left, left.length);
    this.magic.process(left, left.length);

    if (this.releaseAtSample >= 0 && this.bounceNotes.length > 0) {
      this.samplesRendered += left.length;
      if (this.samplesRendered >= this.releaseAtSample) {
        for (const n of this.bounceNotes) this.active.noteOff(n);
        this.bounceNotes.length = 0;
      }
    }

    if (this.capturing) {
      const room = this.captureBuf.length - this.captureLen;
      const n = left.length < room ? left.length : room;
      for (let i = 0; i < n; i++) {
        this.captureBuf[this.captureLen + i] = left[i] as number;
      }
      this.captureLen += n;
      if (this.captureLen >= this.captureBuf.length) this.finishCapture(true);
    }

    for (let ch = 1; ch < output.length; ch++) {
      output[ch]?.set(left);
    }
    return true;
  }
}

registerProcessor('sigil-processor', SigilProcessor);
