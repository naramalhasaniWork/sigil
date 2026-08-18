import type { EngineModule, EngineVoice } from '@/audio/types';
import { TuningTable } from './tuning';

interface Slot {
  voice: EngineVoice;
  index: number;
  note: number;
  age: number;
  held: boolean;
  busy: boolean;
}

/** Owns polyphony so engines never have to think about it. */
export class VoiceManager {
  readonly tuning = new TuningTable();
  private readonly slots: Slot[] = [];
  private readonly paramCount: number;
  private readonly paramValues: Float32Array;
  private counter = 0;

  constructor(engine: EngineModule, sampleRate: number, maxVoices: number) {
    this.paramCount = engine.descriptor.params.length;
    this.paramValues = new Float32Array(this.paramCount);
    for (let i = 0; i < this.paramCount; i++) {
      this.paramValues[i] = engine.descriptor.params[i]?.default ?? 0;
    }
    for (let i = 0; i < maxVoices; i++) {
      this.slots.push({
        voice: engine.allocVoice(sampleRate),
        index: i, note: -1, age: 0, held: false, busy: false,
      });
    }
  }

  get activeCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.busy) n++;
    return n;
  }

  setParam(index: number, value: number): void {
    if (index < 0 || index >= this.paramCount) return;
    this.paramValues[index] = value;
    for (const s of this.slots) s.voice.setParam(index, value);
  }

  private claim(): Slot {
    for (const s of this.slots) if (!s.busy) return s;
    let victim = this.slots[0] as Slot;
    for (const s of this.slots) {
      const better =
        (!s.held && victim.held) ||
        (s.held === victim.held && s.age < victim.age);
      if (better) victim = s;
    }
    return victim;
  }

  noteOn(midiNote: number, velocity: number): void {
    const slot = this.claim();
    for (let i = 0; i < this.paramCount; i++) {
      slot.voice.setParam(i, this.paramValues[i] as number);
    }
    slot.note = midiNote;
    slot.age = this.counter++;
    slot.held = true;
    slot.busy = true;
    slot.voice.noteOn(this.tuning.frequency(midiNote), velocity, slot.index);
  }

  noteOff(midiNote: number): void {
    for (const s of this.slots) {
      if (s.busy && s.held && s.note === midiNote) {
        s.held = false;
        s.voice.noteOff();
      }
    }
  }

  render(out: Float32Array, count: number): void {
    for (const s of this.slots) {
      if (!s.busy) continue;
      s.voice.render(out, 0, count);
      if (s.voice.isFinished()) {
        s.busy = false;
        s.note = -1;
        s.held = false;
      }
    }
  }
}
