import { describe, it, expect } from 'vitest';
import { WavetableEngine } from '@/dsp/wavetable-voice';
import { WAVETABLE_DESCRIPTOR } from '@/dsp/wavetable-descriptor';
import { magnitudeSpectrum } from '../util/fft';

const SR = 48000;

function idx(id: string): number {
  const i = WAVETABLE_DESCRIPTOR.params.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`no such param: ${id}`);
  return i;
}

/** Hann-windowed spectrum; without a window the edges smear every bin. */
function windowedSpectrum(buf: Float32Array): Float32Array {
  const win = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    win[i] = (buf[i] as number) * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (buf.length - 1)));
  }
  return magnitudeSpectrum(win);
}

/** Amplitude-weighted mean frequency — a single number for "how bright". */
function spectralCentroid(buf: Float32Array): number {
  const spec = windowedSpectrum(buf);
  const binHz = SR / buf.length;
  let weighted = 0;
  let total = 0;
  for (let i = 1; i < spec.length; i++) {
    const m = spec[i] as number;
    weighted += i * binHz * m;
    total += m;
  }
  return total > 0 ? weighted / total : 0;
}

/**
 * Share of spectral energy that does NOT sit near an integer multiple of f0.
 * Harmonic playback keeps this near zero; aliasing folds partials down onto
 * frequencies unrelated to the note, which is exactly what this measures.
 */
function inharmonicRatio(buf: Float32Array, f0: number): number {
  const spec = windowedSpectrum(buf);
  const binHz = SR / buf.length;
  const f0Bins = f0 / binHz;
  let inharm = 0;
  let total = 0;
  for (let i = 1; i < spec.length; i++) {
    const e = (spec[i] as number) * (spec[i] as number);
    total += e;
    const nearest = Math.round(i / f0Bins) * f0Bins;
    if (Math.abs(i - nearest) > 4) inharm += e;
  }
  return total > 0 ? inharm / total : 0;
}

/** A steady-state render: short attack, full sustain, transient skipped. */
function steadyRender(freq: number, position: number, samples: number): Float32Array {
  const v = WavetableEngine.allocVoice(SR);
  v.setParam(idx('table-position'), position);
  // Detune defaults to 0.07 semitones, so oscillator two beats against
  // oscillator one and drops partials BETWEEN the harmonics of f0. Measured as
  // "inharmonic energy" that reads as aliasing when it is really the engine
  // doing exactly what it is supposed to. Aliasing tests need one oscillator.
  v.setParam(idx('osc-detune'), 0);
  v.setParam(idx('position-env'), 0);
  v.setParam(idx('drive'), 0);
  v.setParam(idx('filter-cutoff'), 18000);
  v.setParam(idx('filter-resonance'), 0);
  v.setParam(idx('filter-env'), 0);
  v.setParam(idx('filter-keytrack'), 0);
  v.setParam(idx('amp-attack'), 0.5);
  v.setParam(idx('amp-sustain'), 1);
  v.noteOn(freq, 1, 0);
  const skip = new Float32Array(9600);
  v.render(skip, 0, 9600);
  const out = new Float32Array(samples);
  v.render(out, 0, samples);
  return out;
}

describe('WAVETABLE_DESCRIPTOR', () => {
  it('explains every parameter in plain language', () => {
    for (const p of WAVETABLE_DESCRIPTOR.params) {
      expect(p.explain.length, `${p.id} needs an explanation`).toBeGreaterThan(20);
    }
  });

  it('has unique ids and in-range defaults', () => {
    const ids = WAVETABLE_DESCRIPTOR.params.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of WAVETABLE_DESCRIPTOR.params) {
      expect(p.default).toBeGreaterThanOrEqual(p.min);
      expect(p.default).toBeLessThanOrEqual(p.max);
    }
  });

  it('assigns exactly four macros, one parameter each', () => {
    const carriers = WAVETABLE_DESCRIPTOR.params.filter((p) => p.macro !== undefined);
    expect(carriers.map((p) => p.macro).sort()).toEqual([0, 1, 2, 3]);
    for (const p of carriers) expect(p.macroDepth).toBeGreaterThan(0);
  });
});

describe('WavetableVoice', () => {
  it('produces audible, finite output after note-on', () => {
    const v = WavetableEngine.allocVoice(SR);
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
    const v = WavetableEngine.allocVoice(SR);
    const out = new Float32Array(256);
    v.render(out, 0, 256);
    for (const s of out) expect(s).toBe(0);
  });

  it('adds into the buffer rather than overwriting', () => {
    const v = WavetableEngine.allocVoice(SR);
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
    const v = WavetableEngine.allocVoice(SR);
    v.setParam(idx('amp-release'), 2);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(4800);
    v.render(out, 0, 4800);
    expect(v.isFinished()).toBe(false);
    v.noteOff();
    v.render(out, 0, 4800);
    v.render(out, 0, 4800);
    expect(v.isFinished()).toBe(true);
  });

  it('does not grow the heap across a sustained render', () => {
    // Without a real gc() this test would measure framework garbage rather
    // than the render loop, and silently mean nothing.
    expect(typeof global.gc, 'run vitest with --expose-gc').toBe('function');
    const v = WavetableEngine.allocVoice(SR);
    v.setParam(idx('position-env'), 1);
    v.setParam(idx('drive'), 0.6);
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
    const params = WAVETABLE_DESCRIPTOR.params;
    for (let p = 0; p < params.length; p++) {
      const d = params[p];
      if (!d) continue;
      for (const extreme of [0, 1]) {
        const v = WavetableEngine.allocVoice(SR);
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

  it('table position audibly changes the spectrum', () => {
    // Position 0 is a pure sine; position 1 is the metallic table. If the
    // scan works, the far end must be dramatically brighter than the start.
    const dark = spectralCentroid(steadyRender(220, 0, 8192));
    const bright = spectralCentroid(steadyRender(220, 1, 8192));
    expect(dark).toBeGreaterThan(0);
    expect(bright).toBeGreaterThan(dark * 2);
  });

  it('stays band-limited at high pitch where a naive table aliases badly', () => {
    const f0 = 3217;
    // The naive comparison: one full-resolution sawtooth table played back
    // with no band-limiting at all, the textbook wavetable mistake.
    const N = 2048;
    const naiveTable = new Float32Array(N + 1);
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let n = 1; n <= 512; n++) s += Math.sin((2 * Math.PI * n * i) / N) / n;
      naiveTable[i] = s * 0.5;
    }
    naiveTable[N] = naiveTable[0] as number;
    const naive = new Float32Array(8192);
    let ph = 0;
    const inc = f0 / SR;
    for (let i = 0; i < 8192; i++) {
      const x = ph * N;
      const i0 = x | 0;
      const fr = x - i0;
      naive[i] = (naiveTable[i0] as number)
        + ((naiveTable[i0 + 1] as number) - (naiveTable[i0] as number)) * fr;
      ph += inc; if (ph >= 1) ph -= 1;
    }

    // Engine at the pure saw table (position 4 of 0..7).
    const engine = steadyRender(f0, 4 / 7, 8192);

    const naiveRatio = inharmonicRatio(naive, f0);
    const engineRatio = inharmonicRatio(engine, f0);
    // The naive table folds most of its top octaves back as noise.
    expect(naiveRatio).toBeGreaterThan(0.05);
    // The mipmapped engine keeps inharmonic junk well below that.
    expect(engineRatio).toBeLessThan(naiveRatio * 0.25);
    expect(engineRatio).toBeLessThan(0.03);
  });
});
