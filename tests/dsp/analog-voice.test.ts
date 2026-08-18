import { describe, it, expect } from 'vitest';
import { AnalogEngine } from '@/dsp/analog-voice';

const SR = 48000;

describe('AnalogVoice', () => {
  it('produces audible, finite output after note-on', () => {
    const v = AnalogEngine.allocVoice(SR);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(4800);
    v.render(out, 0, 4800);
    let peak = 0;
    for (const s of out) {
      expect(Number.isFinite(s)).toBe(true);
      if (Math.abs(s) > peak) peak = Math.abs(s);
    }
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(2);
  });

  it('is silent before note-on', () => {
    const v = AnalogEngine.allocVoice(SR);
    const out = new Float32Array(256);
    v.render(out, 0, 256);
    for (const s of out) expect(s).toBe(0);
  });

  it('adds into the buffer rather than overwriting', () => {
    const v = AnalogEngine.allocVoice(SR);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(256);
    out.fill(1);
    v.render(out, 0, 256);
    let changed = false;
    for (const s of out) if (s !== 1) changed = true;
    expect(changed).toBe(true);
  });

  it('finishes after release', () => {
    const v = AnalogEngine.allocVoice(SR);
    v.setParam(8, 5);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(4800);
    v.render(out, 0, 4800);
    v.noteOff();
    v.render(out, 0, 4800);
    v.render(out, 0, 4800);
    expect(v.isFinished()).toBe(true);
  });

  it('does not grow the heap across a sustained render', () => {
    // Without a real gc() this test would measure framework garbage rather
    // than the render loop, and silently mean nothing.
    expect(typeof global.gc, 'run vitest with --expose-gc').toBe('function');
    const v = AnalogEngine.allocVoice(SR);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(128);
    for (let i = 0; i < 500; i++) { out.fill(0); v.render(out, 0, 128); }
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 4000; i++) { out.fill(0); v.render(out, 0, 128); }
    global.gc?.();
    const after = process.memoryUsage().heapUsed;
    expect(after - before).toBeLessThan(64 * 1024);
  });

  it('survives every parameter at both extremes without NaN', () => {
    const params = AnalogEngine.descriptor.params;
    for (let p = 0; p < params.length; p++) {
      for (const extreme of [0, 1]) {
        const d = params[p];
        if (!d) continue;
        const v = AnalogEngine.allocVoice(SR);
        v.setParam(p, extreme === 0 ? d.min : d.max);
        v.noteOn(880, 1, 0);
        const out = new Float32Array(2048);
        v.render(out, 0, 2048);
        for (const s of out) {
          expect(Number.isFinite(s), `${d.id} at ${extreme === 0 ? 'min' : 'max'}`).toBe(true);
        }
      }
    }
  });
});
