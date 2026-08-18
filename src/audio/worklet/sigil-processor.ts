import { VoiceManager } from '@/dsp/voice-manager';
import { ENGINES, DEFAULT_ENGINE_ID } from '@/dsp/registry';
import { forEachParam } from '@/audio/param-transport';

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
type InboundMessage =
  | NoteOnMessage
  | NoteOffMessage
  | ParamMessage
  | EngineMessage
  | TuningMessage
  | AllNotesOffMessage;

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

  constructor(options?: { processorOptions?: Record<string, unknown> }) {
    super(options);

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
          forEachParam(msg.data, (i, v) => { this.active.setParam(i, v); });
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
      }
    };
  }

  private releaseAtSample = -1;
  private readonly bounceNotes: number[] = [];
  private samplesRendered = 0;

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output) return true;
    const left = output[0];
    if (!left) return true;

    left.fill(0);
    this.active.render(left, left.length);

    if (this.releaseAtSample >= 0 && this.bounceNotes.length > 0) {
      this.samplesRendered += left.length;
      if (this.samplesRendered >= this.releaseAtSample) {
        for (const n of this.bounceNotes) this.active.noteOff(n);
        this.bounceNotes.length = 0;
      }
    }

    for (let ch = 1; ch < output.length; ch++) {
      output[ch]?.set(left);
    }
    return true;
  }
}

registerProcessor('sigil-processor', SigilProcessor);
