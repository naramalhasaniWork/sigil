import { describe, it, expect } from 'vitest';
import { GranularEngine } from '@/dsp/granular-voice';
import { GRANULAR_DESCRIPTOR } from '@/dsp/granular-descriptor';

const SR = 48000;
const P_DENSITY = 0;
const P_RELEASE = 10;

function rms(buf: Float32Array): number {
  let acc = 0;
  for (const s of buf) acc += s * s;
  return Math.sqrt(acc / buf.length);
}

describe('GranularVoice', () => {
  it('produces audible, finite output after note-on', () => {
    const v = GranularEngine.allocVoice(SR);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(SR);
    v.render(out, 0, SR);
    let peak = 0;
    for (const s of out) {
      expect(Number.isFinite(s)).toBe(true);
      if (Math.abs(s) > peak) peak = Math.abs(s);
    }
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(2);
  });

  it('is silent before note-on', () => {
    const v = GranularEngine.allocVoice(SR);
    const out = new Float32Array(512);
    v.render(out, 0, 512);
    for (const s of out) expect(s).toBe(0);
  });

  it('adds into the buffer rather than overwriting', () => {
    const v = GranularEngine.allocVoice(SR);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(2048);
    out.fill(1);
    v.render(out, 0, 2048);
    let changed = false;
    for (const s of out) if (s !== 1) changed = true;
    expect(changed).toBe(true);
  });

  it('respects the render offset and leaves the rest of the buffer alone', () => {
    const v = GranularEngine.allocVoice(SR);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(4096);
    v.render(out, 2048, 2048);
    for (let i = 0; i < 2048; i++) expect(out[i]).toBe(0);
  });

  it('finishes after release', () => {
    const v = GranularEngine.allocVoice(SR);
    v.setParam(P_RELEASE, 5);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(4800);
    v.render(out, 0, 4800);
    v.noteOff();
    v.render(out, 0, 4800);
    v.render(out, 0, 4800);
    expect(v.isFinished()).toBe(true);
  });

  it('is deterministic for a given voice index', () => {
    const a = GranularEngine.allocVoice(SR);
    const b = GranularEngine.allocVoice(SR);
    a.noteOn(220, 1, 3);
    b.noteOn(220, 1, 3);
    const outA = new Float32Array(8192);
    const outB = new Float32Array(8192);
    a.render(outA, 0, 8192);
    b.render(outB, 0, 8192);
    expect(Array.from(outA)).toEqual(Array.from(outB));
  });

  it('gives different voice indices different grain scatter', () => {
    const a = GranularEngine.allocVoice(SR);
    const b = GranularEngine.allocVoice(SR);
    a.noteOn(220, 1, 0);
    b.noteOn(220, 1, 7);
    const outA = new Float32Array(8192);
    const outB = new Float32Array(8192);
    a.render(outA, 0, 8192);
    b.render(outB, 0, 8192);
    let differs = false;
    for (let i = 0; i < outA.length; i++) if (outA[i] !== outB[i]) differs = true;
    expect(differs).toBe(true);
  });

  it('gets measurably louder as density rises', () => {
    const levels: number[] = [];
    for (const density of [6, 24, 96]) {
      const v = GranularEngine.allocVoice(SR);
      v.setParam(P_DENSITY, density);
      v.noteOn(220, 1, 1);
      const out = new Float32Array(SR);
      v.render(out, 0, SR);
      levels.push(rms(out));
    }
    const [low, mid, high] = levels as [number, number, number];
    expect(mid).toBeGreaterThan(low * 1.2);
    expect(high).toBeGreaterThan(mid * 1.2);
  });

  it('does not grow the heap across a sustained render', () => {
    // Without a real gc() this measures framework garbage, not the render
    // loop, and would pass while meaning nothing.
    expect(typeof global.gc, 'run vitest with --expose-gc').toBe('function');
    const v = GranularEngine.allocVoice(SR);
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
    const params = GRANULAR_DESCRIPTOR.params;
    for (let p = 0; p < params.length; p++) {
      for (const extreme of [0, 1]) {
        const d = params[p];
        if (!d) continue;
        const v = GranularEngine.allocVoice(SR);
        v.setParam(p, extreme === 0 ? d.min : d.max);
        v.noteOn(880, 1, 2);
        const out = new Float32Array(8192);
        v.render(out, 0, 8192);
        for (const s of out) {
          expect(Number.isFinite(s), `${d.id} at ${extreme === 0 ? 'min' : 'max'}`).toBe(true);
          expect(Math.abs(s), `${d.id} runaway level`).toBeLessThan(2);
        }
      }
    }
  });

  it('survives extreme note frequencies without NaN', () => {
    for (const freq of [16, 55, 4186, 12000]) {
      const v = GranularEngine.allocVoice(SR);
      v.noteOn(freq, 1, 0);
      const out = new Float32Array(4096);
      v.render(out, 0, 4096);
      for (const s of out) expect(Number.isFinite(s), `at ${freq} Hz`).toBe(true);
    }
  });

  it('runs at other sample rates', () => {
    for (const sr of [22050, 44100, 96000]) {
      const v = GranularEngine.allocVoice(sr);
      v.noteOn(220, 1, 0);
      const out = new Float32Array(sr >> 1);
      v.render(out, 0, out.length);
      let peak = 0;
      for (const s of out) {
        expect(Number.isFinite(s)).toBe(true);
        if (Math.abs(s) > peak) peak = Math.abs(s);
      }
      expect(peak, `at ${sr} Hz`).toBeGreaterThan(0.05);
    }
  });
});

describe('GRANULAR_DESCRIPTOR', () => {
  it('gives every parameter a non-empty explanation', () => {
    for (const p of GRANULAR_DESCRIPTOR.params) {
      expect(p.explain.length, `${p.id} needs an explanation`).toBeGreaterThan(20);
    }
  });

  it('has unique parameter ids', () => {
    const ids = GRANULAR_DESCRIPTOR.params.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every default inside its own range', () => {
    for (const p of GRANULAR_DESCRIPTOR.params) {
      expect(p.default).toBeGreaterThanOrEqual(p.min);
      expect(p.default).toBeLessThanOrEqual(p.max);
    }
  });

  it('assigns exactly four macros, each with a depth', () => {
    const macroed = GRANULAR_DESCRIPTOR.params.filter((p) => p.macro !== undefined);
    expect(new Set(macroed.map((p) => p.macro))).toEqual(new Set([0, 1, 2, 3]));
    expect(macroed.length).toBe(4);
    for (const p of macroed) {
      expect(p.macroDepth, `${p.id} needs a macroDepth`).toBeGreaterThan(0);
    }
  });
});
