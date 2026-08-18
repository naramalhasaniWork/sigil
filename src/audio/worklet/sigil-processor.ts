import { VoiceManager } from '@/dsp/voice-manager';
import { AnalogEngine } from '@/dsp/analog-voice';
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
type InboundMessage = NoteOnMessage | NoteOffMessage | ParamMessage;

declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor,
): void;

class SigilProcessor extends AudioWorkletProcessor {
  private readonly vm = new VoiceManager(AnalogEngine, sampleRate, 16);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<InboundMessage>): void => {
      const msg = e.data;
      if (msg.type === 'noteOn') this.vm.noteOn(msg.note, msg.velocity);
      else if (msg.type === 'noteOff') this.vm.noteOff(msg.note);
      else forEachParam(msg.data, (i, v) => { this.vm.setParam(i, v); });
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output) return true;
    const left = output[0];
    if (!left) return true;

    left.fill(0);
    this.vm.render(left, left.length);

    for (let ch = 1; ch < output.length; ch++) {
      output[ch]?.set(left);
    }
    return true;
  }
}

registerProcessor('sigil-processor', SigilProcessor);
