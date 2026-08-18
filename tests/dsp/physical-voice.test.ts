import { describe, it, expect } from 'vitest';
import { PhysicalEngine, MAX_MODES } from '@/dsp/physical-voice';
import { PHYSICAL_DESCRIPTOR } from '@/dsp/physical-descriptor';
import { magnitudeSpectrum } from '../util/fft';
import { expectAudioOk } from '../util/assert-audio';

const SR = 48000;
const PARAMS = PHYSICAL_DESCRIPTOR.params;
const P = { MATERIAL: 0, STRUCTURE: 1, DECAY: 2, DAMPING: 3, POSITION: 4, AIR: 5, EXCITER: 6, GRIT: 7, HARDNESS: 8, TONE: 9, RELEASE: 10, LEVEL: 11 } as const;

type Voice = ReturnType<typeof PhysicalEngine.allocVoice>;

/** Renders in 128-sample blocks, the way the worklet does. */
function render(setup: (v: Voice) => void, seconds: number, freq = 220): Float32Array {
  const v = PhysicalEngine.allocVoice(SR);
  setup(v);
  v.noteOn(freq, 1, 0);
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i + 128 <= out.length; i += 128) v.render(out, i, 128);
  return out;
}

function peakOf(o: Float32Array): number {
  let p = 0;
  for (const s of o) { const a = Math.abs(s); if (a > p) p = a; }
  return p;
}

/** Energy in [lo, hi) Hz over the first 16384 samples. */
function band(o: Float32Array, lo: number, hi: number): number {
  const n = 16384;
  const seg = new Float32Array(n);
  seg.set(o.subarray(0, Math.min(n, o.length)));
  const sp = magnitudeSpectrum(seg);
  let e = 0;
  for (let i = 0; i < sp.length; i++) {
    const f = (i * SR) / n;
    if (f >= lo && f < hi) e += (sp[i] as number) ** 2;
  }
  return e;
}

function countModes(o: Float32Array): number {
  const n = 16384;
  const seg = new Float32Array(n);
  seg.set(o.subarray(0, n));
  const sp = magnitudeSpectrum(seg);
  let max = 0;
  for (const m of sp) if (m > max) max = m;
  const floor = max * 1e-3;
  let peaks = 0;
  for (let i = 2; i < sp.length - 2; i++) {
    const m = sp[i] as number;
    if (m > floor && m > (sp[i - 1] as number) && m >= (sp[i + 1] as number) &&
      m > (sp[i - 2] as number) && m >= (sp[i + 2] as number)) peaks++;
  }
  return peaks;
}

describe('PHYSICAL_DESCRIPTOR', () => {
  it('explains every parameter in plain language', () => {
    for (const p of PARAMS) {
      expect(p.explain.length, `${p.id} needs an explanation`).toBeGreaterThan(20);
    }
  });

  it('has unique ids and in-range defaults', () => {
    const ids = PARAMS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PARAMS) {
      expect(p.default, p.id).toBeGreaterThanOrEqual(p.min);
      expect(p.default, p.id).toBeLessThanOrEqual(p.max);
    }
  });

  it('assigns exactly four macros, one each, all with a depth', () => {
    const assigned = PARAMS.filter((p) => p.macro !== undefined);
    expect(assigned.map((p) => p.macro).sort()).toEqual([0, 1, 2, 3]);
    for (const p of assigned) {
      expect(p.macroDepth, `${p.id} needs a macroDepth`).toBeGreaterThan(0);
    }
    expect(PHYSICAL_DESCRIPTOR.macroNames).toEqual(['Body', 'Air', 'Grit', 'Motion']);
  });
});

describe('PhysicalVoice', () => {
  it('produces audible, finite output after note-on', () => {
    const out = render(() => {}, 1);
    expectAudioOk(out, Infinity, 'finite output');
    const peak = peakOf(out);
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(1);
  });

  it('is silent before note-on', () => {
    const v = PhysicalEngine.allocVoice(SR);
    const out = new Float32Array(256);
    v.render(out, 0, 256);
    for (const s of out) expect(s).toBe(0);
  });

  it('adds into the buffer rather than overwriting', () => {
    const v = PhysicalEngine.allocVoice(SR);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(256).fill(1);
    v.render(out, 0, 256);
    let changed = false;
    for (const s of out) if (s !== 1) changed = true;
    expect(changed).toBe(true);
  });

  it('does not grow the heap across a sustained render', () => {
    expect(typeof global.gc, 'run vitest with --expose-gc').toBe('function');
    const v = PhysicalEngine.allocVoice(SR);
    v.setParam(P.EXCITER, 2);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(128);
    for (let i = 0; i < 500; i++) { out.fill(0); v.render(out, 0, 128); }
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 4000; i++) { out.fill(0); v.render(out, 0, 128); }
    global.gc?.();
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024);
  });
});

describe('PhysicalVoice stability', () => {
  it('survives every parameter at both extremes, for every exciter', () => {
    for (let type = 0; type <= 2; type++) {
      for (let p = 0; p < PARAMS.length; p++) {
        const d = PARAMS[p];
        if (!d) continue;
        for (const value of [d.min, d.max]) {
          const out = render((v) => { v.setParam(P.EXCITER, type); v.setParam(p, value); }, 0.5);
          const peak = peakOf(out);
          expect(Number.isFinite(peak), `${d.id}=${value} exciter ${type}`).toBe(true);
          expect(peak, `${d.id}=${value} exciter ${type}`).toBeLessThan(1);
        }
      }
    }
  });

  it('stays bounded for randomised parameter combinations across the range', () => {
    let rng = 12345;
    const rand = (): number => {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng / 0x7fffffff;
    };
    for (let trial = 0; trial < 200; trial++) {
      const out = render((v) => {
        for (let p = 0; p < PARAMS.length; p++) {
          const d = PARAMS[p];
          if (d) v.setParam(p, d.min + rand() * (d.max - d.min));
        }
      }, 0.25, 30 + rand() * 4000);
      for (const s of out) {
        if (!Number.isFinite(s) || Math.abs(s) > 1) {
          throw new Error(`unbounded output ${s} on trial ${trial}`);
        }
      }
    }
  });

  it('ignores out-of-range parameter indices', () => {
    const v = PhysicalEngine.allocVoice(SR);
    v.setParam(-1, 5);
    v.setParam(999, 5);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(1024);
    v.render(out, 0, 1024);
    expect(Number.isFinite(peakOf(out))).toBe(true);
  });

  it('rings down to exact zero, so state cannot sit in denormals', () => {
    const v = PhysicalEngine.allocVoice(SR);
    v.setParam(P.DECAY, 100);
    v.setParam(P.DAMPING, 1);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(4096);
    for (let i = 0; i < 60; i++) { out.fill(0); v.render(out, 0, 4096); }
    for (const s of out) expect(s).toBe(0);
  });
});

describe('PhysicalVoice modal bank', () => {
  it('offers at least sixteen tuned modes', () => {
    expect(MAX_MODES).toBeGreaterThanOrEqual(16);
    const out = render((v) => {
      v.setParam(P.MATERIAL, 1);
      v.setParam(P.STRUCTURE, 0);
      v.setParam(P.DAMPING, 0);
      v.setParam(P.DECAY, 3000);
      v.setParam(P.AIR, 1);
      v.setParam(P.POSITION, 0.13);
      v.setParam(P.HARDNESS, 0.2);
    }, 0.4, 55);
    expect(countModes(out)).toBeGreaterThanOrEqual(16);
  });

  it('gives each material its own voice, from dull wood to bright glass', () => {
    const bright: number[] = [];
    for (let m = 0; m < 4; m++) {
      const out = render((v) => { v.setParam(P.MATERIAL, m / 3); v.setParam(P.STRUCTURE, 0); }, 1);
      expect(peakOf(out), `material ${m}`).toBeGreaterThan(0.05);
      bright.push(band(out, 800, 8000) / band(out, 0, 800));
    }
    // membrane, wood, metal, glass — wood is the dullest, glass the brightest.
    expect(bright[1] as number).toBeLessThan(bright[0] as number);
    expect(bright[2] as number).toBeGreaterThan(bright[1] as number);
    expect(bright[3] as number).toBeGreaterThan(bright[2] as number);
  });

  it('damps high modes far faster than low ones', () => {
    const open = render((v) => { v.setParam(P.DAMPING, 0); v.setParam(P.DECAY, 2000); }, 1);
    const muted = render((v) => { v.setParam(P.DAMPING, 1); v.setParam(P.DECAY, 2000); }, 1);
    const lowRatio = band(muted, 0, 500) / band(open, 0, 500);
    const highRatio = band(muted, 2000, 12000) / band(open, 2000, 12000);
    expect(highRatio).toBeLessThan(lowRatio * 0.2);
  });

  it('re-weights the excited modes as strike position moves', () => {
    // Glass is near-harmonic, so striking at the halfway point should sit on
    // the node of the second partial and starve it.
    const nodal = render((v) => { v.setParam(P.MATERIAL, 1); v.setParam(P.STRUCTURE, 0); v.setParam(P.POSITION, 0.5); }, 1);
    const off = render((v) => { v.setParam(P.MATERIAL, 1); v.setParam(P.STRUCTURE, 0); v.setParam(P.POSITION, 0.25); }, 1);
    expect(band(nodal, 400, 480)).toBeLessThan(band(off, 400, 480) * 0.5);
  });

  it('raises high-frequency content as Air opens the bank', () => {
    const dark = render((v) => { v.setParam(P.AIR, 0); v.setParam(P.HARDNESS, 0.2); }, 1);
    const airy = render((v) => { v.setParam(P.AIR, 1); v.setParam(P.HARDNESS, 0.2); }, 1);
    expect(band(airy, 1500, 12000)).toBeGreaterThan(band(dark, 1500, 12000) * 4);
  });
});

describe('PhysicalVoice exciters and voice lifetime', () => {
  it('makes sound with every exciter type', () => {
    for (let type = 0; type <= 2; type++) {
      expect(peakOf(render((v) => v.setParam(P.EXCITER, type), 1)), `exciter ${type}`)
        .toBeGreaterThan(0.05);
    }
  });

  it('sustains while bowed but decays when struck', () => {
    const bow = render((v) => { v.setParam(P.EXCITER, 2); v.setParam(P.DECAY, 400); }, 2);
    const hit = render((v) => { v.setParam(P.EXCITER, 0); v.setParam(P.DECAY, 400); }, 2);
    const late = (o: Float32Array): number => peakOf(o.subarray(SR, 2 * SR));
    expect(late(bow)).toBeGreaterThan(0.02);
    expect(late(hit)).toBeLessThan(late(bow) * 0.5);
  });

  it('reports finished once a struck note has rung out, even at maximum decay', () => {
    const v = PhysicalEngine.allocVoice(SR);
    v.setParam(P.MATERIAL, 1);
    v.setParam(P.DECAY, 3000);
    v.setParam(P.DAMPING, 0);
    v.setParam(P.AIR, 1);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(4800);
    let finishedAfter = -1;
    for (let b = 0; b < 100 && finishedAfter < 0; b++) {
      out.fill(0);
      v.render(out, 0, 4800);
      if (v.isFinished()) finishedAfter = b;
    }
    expect(finishedAfter).toBeGreaterThan(0);
    expect(finishedAfter / 10).toBeLessThan(8);
  });

  it('keeps a bowed note alive while held and frees it after release', () => {
    const v = PhysicalEngine.allocVoice(SR);
    v.setParam(P.EXCITER, 2);
    v.setParam(P.DECAY, 3000);
    v.setParam(P.DAMPING, 0);
    v.setParam(P.RELEASE, 50);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(4800);
    for (let b = 0; b < 40; b++) { out.fill(0); v.render(out, 0, 4800); }
    expect(v.isFinished()).toBe(false);
    v.noteOff();
    let freed = false;
    for (let b = 0; b < 100 && !freed; b++) {
      out.fill(0);
      v.render(out, 0, 4800);
      if (v.isFinished()) freed = true;
    }
    expect(freed).toBe(true);
  });

  it('never reports finished before it has been played', () => {
    expect(PhysicalEngine.allocVoice(SR).isFinished()).toBe(false);
  });
});
