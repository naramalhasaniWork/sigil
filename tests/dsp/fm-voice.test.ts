import { describe, it, expect } from 'vitest';
import { FmEngine } from '@/dsp/fm-voice';
import { FM_DESCRIPTOR } from '@/dsp/fm-descriptor';
import { magnitudeSpectrum } from '../util/fft';

const SR = 48000;

function idx(id: string): number {
  const i = FM_DESCRIPTOR.params.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`no such param: ${id}`);
  return i;
}

/**
 * Share of the spectrum sitting above `fromHz`. Hann-windowed first: without a
 * window the rectangular edges smear a pure sine across every bin, which would
 * make a plain tone look almost as bright as a rich one.
 */
function highBandRatio(buf: Float32Array, fromHz: number): number {
  const win = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    win[i] = (buf[i] as number) * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (buf.length - 1)));
  }
  const spec = magnitudeSpectrum(win);
  const binHz = SR / buf.length;
  let high = 0;
  let total = 0;
  for (let i = 1; i < spec.length; i++) {
    const m = spec[i] as number;
    total += m;
    if (i * binHz >= fromHz) high += m;
  }
  return total > 0 ? high / total : 0;
}

describe('FM_DESCRIPTOR', () => {
  it('explains every parameter in plain language', () => {
    for (const p of FM_DESCRIPTOR.params) {
      expect(p.explain.length, `${p.id} needs an explanation`).toBeGreaterThan(20);
    }
  });

  it('has unique ids and in-range defaults', () => {
    const ids = FM_DESCRIPTOR.params.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of FM_DESCRIPTOR.params) {
      expect(p.default).toBeGreaterThanOrEqual(p.min);
      expect(p.default).toBeLessThanOrEqual(p.max);
    }
  });

  it('assigns exactly four macros, one parameter each', () => {
    const carriers = FM_DESCRIPTOR.params.filter((p) => p.macro !== undefined);
    expect(carriers.map((p) => p.macro).sort()).toEqual([0, 1, 2, 3]);
    for (const p of carriers) expect(p.macroDepth).toBeGreaterThan(0);
  });
});

describe('FmVoice', () => {
  it('produces audible, finite output after note-on', () => {
    const v = FmEngine.allocVoice(SR);
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
    const v = FmEngine.allocVoice(SR);
    const out = new Float32Array(256);
    v.render(out, 0, 256);
    for (const s of out) expect(s).toBe(0);
  });

  it('adds into the buffer rather than overwriting', () => {
    const v = FmEngine.allocVoice(SR);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(256);
    out.fill(1);
    v.render(out, 0, 256);
    let changed = false;
    let cleared = false;
    for (const s of out) {
      if (s !== 1) changed = true;
      if (s === 0) cleared = true;
    }
    expect(changed).toBe(true);
    expect(cleared).toBe(false);
  });

  it('finishes after release', () => {
    const v = FmEngine.allocVoice(SR);
    v.setParam(idx('amp-release'), 2);
    v.setParam(idx('mod-release'), 2);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(4800);
    v.render(out, 0, 4800);
    expect(v.isFinished()).toBe(false);
    v.noteOff();
    v.render(out, 0, 4800);
    v.render(out, 0, 4800);
    expect(v.isFinished()).toBe(true);
  });

  it('survives every parameter at both extremes without NaN', () => {
    const params = FM_DESCRIPTOR.params;
    for (let p = 0; p < params.length; p++) {
      const d = params[p];
      if (!d) continue;
      for (const extreme of [0, 1]) {
        const v = FmEngine.allocVoice(SR);
        v.setParam(p, extreme === 0 ? d.min : d.max);
        v.noteOn(880, 1, 0);
        const out = new Float32Array(2048);
        v.render(out, 0, 2048);
        for (const s of out) {
          const label = `${d.id} at ${extreme === 0 ? 'min' : 'max'}`;
          expect(Number.isFinite(s), label).toBe(true);
          expect(Math.abs(s), label).toBeLessThan(2);
        }
      }
    }
  });

  it('keeps every algorithm audible and bounded', () => {
    const algo = idx('algorithm');
    for (let a = 0; a <= 4; a++) {
      const v = FmEngine.allocVoice(SR);
      v.setParam(algo, a);
      v.setParam(idx('feedback'), 1);
      v.noteOn(220, 1, 0);
      const out = new Float32Array(4096);
      v.render(out, 0, 4096);
      let peak = 0;
      for (const s of out) {
        expect(Number.isFinite(s), `algorithm ${a}`).toBe(true);
        if (Math.abs(s) > peak) peak = Math.abs(s);
      }
      expect(peak, `algorithm ${a} silent`).toBeGreaterThan(0.02);
      expect(peak, `algorithm ${a} blew up`).toBeLessThan(2);
    }
  });

  it('raising the index adds high-frequency energy', () => {
    const render = (index: number): Float32Array => {
      const v = FmEngine.allocVoice(SR);
      v.setParam(idx('key-scale'), 0);
      v.setParam(idx('amp-sustain'), 1);
      v.setParam(idx('mod-sustain'), 1);
      v.setParam(idx('feedback'), 0);
      v.setParam(idx('index'), index);
      v.noteOn(220, 1, 0);
      const warm = new Float32Array(4096);
      v.render(warm, 0, 4096);
      const tail = new Float32Array(4096);
      v.render(tail, 0, 4096);
      return tail;
    };
    const dull = highBandRatio(render(0), 1500);
    const bright = highBandRatio(render(9), 1500);
    expect(bright).toBeGreaterThan(dull * 20);
    expect(bright).toBeGreaterThan(0.1);
  });

  it('scales the index down as pitch rises, so high notes stay musical', () => {
    const brightnessAt = (freq: number, keyScale: number): number => {
      const v = FmEngine.allocVoice(SR);
      v.setParam(idx('key-scale'), keyScale);
      v.setParam(idx('amp-sustain'), 1);
      v.setParam(idx('mod-sustain'), 1);
      v.setParam(idx('feedback'), 0);
      v.setParam(idx('index'), 9);
      v.noteOn(freq, 1, 0);
      const warm = new Float32Array(4096);
      v.render(warm, 0, 4096);
      const tail = new Float32Array(4096);
      v.render(tail, 0, 4096);
      // Measured relative to the note's own fundamental, not a fixed band.
      return highBandRatio(tail, freq * 8);
    };
    // Same patch, same note: key scaling must pull the overtones back.
    expect(brightnessAt(1760, 1)).toBeLessThan(brightnessAt(1760, 0) * 0.7);
    // And it must barely touch the bass end, where the brightness belongs.
    expect(brightnessAt(110, 1)).toBeGreaterThan(brightnessAt(110, 0) * 0.9);
  });

  it('does not grow the heap across a sustained render', () => {
    expect(typeof global.gc, 'run vitest with --expose-gc').toBe('function');
    const v = FmEngine.allocVoice(SR);
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
});
