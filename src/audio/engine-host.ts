import { packParams } from './param-transport';

/** Main-thread facade. The UI never computes audio — it only sends messages. */
export class EngineHost {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;

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
    node.connect(ctx.destination);
    this.ctx = ctx;
    this.node = node;
  }

  noteOn(note: number, velocity: number): void {
    this.node?.port.postMessage({ type: 'noteOn', note, velocity });
  }

  noteOff(note: number): void {
    this.node?.port.postMessage({ type: 'noteOff', note, velocity: 0 });
  }

  setParam(index: number, value: number): void {
    const data = packParams([[index, value]]);
    this.node?.port.postMessage({ type: 'params', data }, [data.buffer]);
  }
}
