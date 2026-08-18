import { describe, it, expect } from 'vitest';
import { AnalogEngine } from '@/dsp/analog-voice';
import { ANALOG_DESCRIPTOR } from '@/dsp/analog-descriptor';
import { denormalise, makeRng } from '@/dsp/mutation';
import { magnitudeSpectrum } from '../util/fft';

const SR = 48000;
const PARAMS = ANALOG_DESCRIPTOR.params;

function idx(id: string): number {
  const i = PARAMS.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`no such parameter: ${id}`);
  return i;
}

/** Everything that would smear a spectral measurement, switched off. */
const STEADY: Readonly<Record<string, number>> = {
  'osc-detune': 0, 'osc-drift': 0, 'filter-env': 0, 'amp-attack': 0.5,
  'amp-decay': 8000, 'amp-sustain': 1, 'filter-resonance': 0, 'drive': 0,
  'sub-level': 0, 'noise-level': 0, 'lfo-pitch': 0, 'lfo-cutoff': 0,
  'lfo-pulse-width': 0, 'lfo-amp': 0, 'filter-velocity': 0, 'amp-velocity': 0,
};

function render(
  over: Readonly<Record<string, number>>, freq: number, vel = 1, n = 16384, skip = 8192,
): Float32Array {
  const v = AnalogEngine.allocVoice(SR);
  for (let i = 0; i < PARAMS.length; i++) v.setParam(i, PARAMS[i]?.default ?? 0);
  for (const [id, value] of Object.entries(over)) v.setParam(idx(id), value);
  v.noteOn(freq, vel, 0);
  const warm = new Float32Array(skip);
  v.render(warm, 0, skip);
  const out = new Float32Array(n);
  v.render(out, 0, n);
  return out;
}

function steady(extra: Readonly<Record<string, number>>): Record<string, number> {
  return { ...STEADY, ...extra };
}

function centroid(buf: Float32Array): number {
  const spec = magnitudeSpectrum(buf);
  const binHz = SR / buf.length;
  let num = 0;
  let den = 0;
  for (let i = 1; i < spec.length; i++) {
    const m = (spec[i] as number) ** 2;
    num += m * i * binHz;
    den += m;
  }
  return den > 0 ? num / den : 0;
}

function peak(buf: Float32Array): number {
  let p = 0;
  for (const s of buf) if (Math.abs(s) > p) p = Math.abs(s);
  return p;
}

/** Rough pitch from zero crossings — enough to watch a glide move. */
function pitchOf(buf: Float32Array, from: number, to: number): number {
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    const a = buf[i - 1] as number;
    const b = buf[i] as number;
    if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) crossings++;
  }
  return (crossings / 2) * (SR / (to - from));
}

describe('AnalogVoice', () => {
  it('produces audible, finite output after note-on', () => {
    const v = AnalogEngine.allocVoice(SR);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(4800);
    v.render(out, 0, 4800);
    for (const s of out) expect(Number.isFinite(s)).toBe(true);
    expect(peak(out)).toBeGreaterThan(0.05);
    expect(peak(out)).toBeLessThan(2);
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
    v.setParam(idx('amp-release'), 5);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(4800);
    v.render(out, 0, 4800);
    v.noteOff();
    v.render(out, 0, 4800);
    v.render(out, 0, 4800);
    expect(v.isFinished()).toBe(true);
  });

  it('renders the same signal whatever the block size', () => {
    // Modulation runs on an internal 8-sample grid; that grid must not move
    // when the host hands over an awkward block length.
    const one = AnalogEngine.allocVoice(SR);
    const many = AnalogEngine.allocVoice(SR);
    one.noteOn(220, 0.8, 2);
    many.noteOn(220, 0.8, 2);
    const a = new Float32Array(2000);
    const b = new Float32Array(2000);
    one.render(a, 0, 2000);
    for (let i = 0; i < 2000; i += 5) many.render(b, i, 5);
    for (let i = 0; i < 2000; i++) expect(b[i], `sample ${i}`).toBeCloseTo(a[i] as number, 7);
  });

  it('does not grow the heap across a sustained render', () => {
    // Without a real gc() this test would measure framework garbage rather
    // than the render loop, and silently mean nothing.
    expect(typeof global.gc, 'run vitest with --expose-gc').toBe('function');
    const v = AnalogEngine.allocVoice(SR);
    v.setParam(idx('unison-voices'), 4);
    v.setParam(idx('noise-level'), 0.4);
    v.setParam(idx('sub-level'), 0.4);
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
    for (let p = 0; p < PARAMS.length; p++) {
      for (const extreme of [0, 1]) {
        const d = PARAMS[p];
        if (!d) continue;
        const v = AnalogEngine.allocVoice(SR);
        v.setParam(p, extreme === 0 ? d.min : d.max);
        v.noteOn(880, 1, 0);
        const out = new Float32Array(4096);
        v.render(out, 0, 4096);
        for (const s of out) {
          expect(Number.isFinite(s), `${d.id} at ${extreme === 0 ? 'min' : 'max'}`).toBe(true);
          expect(Math.abs(s), `${d.id} bounded`).toBeLessThan(4.1);
        }
      }
    }
  });

  it('survives randomised parameter combinations', () => {
    const rng = makeRng(0xc0ffee);
    for (let trial = 0; trial < 60; trial++) {
      const v = AnalogEngine.allocVoice(SR);
      for (let p = 0; p < PARAMS.length; p++) {
        const d = PARAMS[p];
        if (d) v.setParam(p, denormalise(rng(), d));
      }
      v.noteOn(55 + rng() * 3000, rng(), trial % 8);
      const out = new Float32Array(2048);
      v.render(out, 0, 2048);
      v.noteOff();
      v.render(out, 0, 2048);
      for (const s of out) {
        expect(Number.isFinite(s), `trial ${trial}`).toBe(true);
        expect(Math.abs(s), `trial ${trial}`).toBeLessThan(4.1);
      }
    }
  });

  it('lands stepped parameters exactly on their steps', () => {
    const rng = makeRng(7);
    for (const d of PARAMS) {
      if (d.curve !== 'stepped') continue;
      expect(d.steps, `${d.id} needs a step count`).toBeGreaterThanOrEqual(2);
      for (let t = 0; t < 40; t++) {
        const v = denormalise(rng(), d);
        expect(v, `${d.id}`).toBeCloseTo(Math.round(v), 9);
        expect(v).toBeGreaterThanOrEqual(d.min);
        expect(v).toBeLessThanOrEqual(d.max);
      }
    }
  });
});

describe('AnalogVoice key tracking', () => {
  /**
   * Harmonic energy above the fundamental, relative to the fundamental itself.
   * This is what "bright" means to a listener, and unlike a spectral centroid
   * it is not swamped by the fundamental of a heavily filtered note.
   */
  function brightness(buf: Float32Array, f0: number): number {
    const spec = magnitudeSpectrum(buf);
    const binHz = SR / buf.length;
    let above = 0;
    let below = 0;
    for (let i = 1; i < spec.length; i++) {
      const power = (spec[i] as number) ** 2;
      if (i * binHz > f0 * 1.5) above += power;
      else below += power;
    }
    return below > 0 ? above / below : 0;
  }

  // Both land exactly on FFT bins three octaves apart, so nothing leaks.
  const LOW = 117.1875;
  const HIGH = 937.5;

  function ratioAt(keytrack: number): number {
    const patch = steady({ 'filter-cutoff': 900, 'filter-keytrack': keytrack });
    const low = brightness(render(patch, LOW), LOW);
    const high = brightness(render(patch, HIGH), HIGH);
    return high / low;
  }

  it('keeps a high note as bright as a low one, proportionally', () => {
    const tracked = ratioAt(1);
    const half = ratioAt(0.5);
    const fixed = ratioAt(0);

    // Full tracking: the filter moves with the pitch, so the two notes carry
    // the same harmonic content relative to their own fundamentals.
    expect(tracked).toBeGreaterThan(0.7);
    expect(tracked).toBeLessThan(1.4);
    // A fixed cutoff leaves the high note choked down to nearly a sine.
    expect(fixed).toBeLessThan(0.1);
    expect(tracked).toBeGreaterThan(fixed * 8);
    // And the control is monotonic in between, not a switch.
    expect(half).toBeGreaterThan(fixed * 2);
    expect(half).toBeLessThan(tracked);
  });
});

describe('AnalogVoice oscillators', () => {
  // 187.5 Hz puts every harmonic exactly on an FFT bin at this length.
  const F = 187.5;
  const N = 16384;
  const BIN = N / (SR / F);

  function harmonics(buf: Float32Array, count: number): Float32Array {
    const spec = magnitudeSpectrum(buf);
    const out = new Float32Array(count + 1);
    for (let h = 1; h <= count; h++) out[h] = spec[Math.round(h * BIN)] as number;
    return out;
  }

  function evenOddRatio(pw: number): number {
    const buf = render(
      steady({ 'osc1-wave': 1, 'osc-mix': 0, 'osc-pulse-width': pw, 'filter-cutoff': 18000 }),
      F, 1, N,
    );
    const h = harmonics(buf, 16);
    let even = 0;
    let odd = 0;
    for (let i = 1; i <= 16; i++) {
      if (i % 2 === 0) even += (h[i] as number) ** 2;
      else odd += (h[i] as number) ** 2;
    }
    return even / odd;
  }

  it('suppresses even harmonics at 50% pulse width', () => {
    const square = evenOddRatio(0.5);
    const narrow = evenOddRatio(0.3);
    // A 50% pulse has half-wave symmetry, so its even harmonics cancel.
    expect(square).toBeLessThan(0.01);
    expect(narrow).toBeGreaterThan(0.15);
    expect(square).toBeLessThan(narrow * 0.05);
  });

  it('moves pulse width when the LFO is routed to it', () => {
    const still = render(
      steady({ 'osc1-wave': 1, 'osc-mix': 0, 'filter-cutoff': 18000 }), F, 1, N,
    );
    const moving = render(
      steady({
        'osc1-wave': 1, 'osc-mix': 0, 'filter-cutoff': 18000,
        'lfo-pulse-width': 0.9, 'lfo-rate': 3, 'lfo-delay': 0,
      }),
      F, 1, N,
    );
    const a = harmonics(still, 8);
    const b = harmonics(moving, 8);
    // PWM's signature is even harmonics appearing and swinging in level.
    expect((b[2] as number)).toBeGreaterThan((a[2] as number) * 20);
  });

  it('puts energy an octave below the note when the sub is on', () => {
    const off = render(steady({ 'sub-level': 0, 'filter-cutoff': 18000 }), F * 2, 1, N);
    const on = render(
      steady({ 'sub-level': 0.8, 'sub-mode': 0, 'filter-cutoff': 18000 }), F * 2, 1, N,
    );
    const bin = Math.round(BIN);
    expect(magnitudeSpectrum(on)[bin] as number)
      .toBeGreaterThan((magnitudeSpectrum(off)[bin] as number) * 20);
  });

  it('puts energy two octaves below the note on the deeper sub setting', () => {
    const off = render(steady({ 'sub-level': 0, 'filter-cutoff': 18000 }), F * 4, 1, N);
    const on = render(
      steady({ 'sub-level': 0.8, 'sub-mode': 1, 'filter-cutoff': 18000 }), F * 4, 1, N,
    );
    const bin = Math.round(BIN);
    expect(magnitudeSpectrum(on)[bin] as number)
      .toBeGreaterThan((magnitudeSpectrum(off)[bin] as number) * 20);
  });

  it('spreads unison copies around the fundamental without changing level', () => {
    const single = render(steady({ 'unison-voices': 1, 'filter-cutoff': 18000 }), F, 1, N);
    const stack = render(
      steady({ 'unison-voices': 4, 'unison-detune': 1, 'filter-cutoff': 18000 }), F, 1, N,
    );
    const around = (buf: Float32Array): number => {
      const spec = magnitudeSpectrum(buf);
      const c = Math.round(BIN);
      let e = 0;
      for (let i = c - 6; i <= c + 6; i++) if (i !== c) e += (spec[i] as number) ** 2;
      return e;
    };
    expect(around(stack)).toBeGreaterThan(around(single) * 10);
    // Gain compensation: four copies must not be four times louder.
    expect(peak(stack)).toBeLessThan(peak(single) * 1.8);
    expect(peak(stack)).toBeGreaterThan(peak(single) * 0.4);
  });

  it('changes the sound when the filter model changes', () => {
    const patch = steady({ 'filter-cutoff': 700, 'filter-resonance': 0.75 });
    const spectra = [0, 1, 2].map((m) => centroid(render({ ...patch, 'filter-model': m }, 110)));
    expect(spectra[0]).not.toBeCloseTo(spectra[1] as number, 0);
    expect(spectra[1]).not.toBeCloseTo(spectra[2] as number, 0);
  });
});

describe('AnalogVoice velocity and glide', () => {
  it('plays softer notes quieter and darker', () => {
    const patch = steady({
      'filter-cutoff': 2400, 'amp-velocity': 0.6, 'filter-velocity': 0.5,
    });
    const hard = render(patch, 220, 1);
    const soft = render(patch, 220, 0.2);
    expect(peak(soft)).toBeLessThan(peak(hard) * 0.6);
    expect(centroid(soft)).toBeLessThan(centroid(hard) * 0.8);
  });

  it('slides between notes instead of jumping when glide is set', () => {
    const patch = {
      ...STEADY, 'osc1-wave': 3, 'osc2-wave': 3, 'osc-mix': 0,
      'filter-cutoff': 18000, 'glide': 400,
    };
    const v = AnalogEngine.allocVoice(SR);
    for (let i = 0; i < PARAMS.length; i++) v.setParam(i, PARAMS[i]?.default ?? 0);
    for (const [id, value] of Object.entries(patch)) v.setParam(idx(id), value);

    v.noteOn(200, 1, 0);
    const first = new Float32Array(9600);
    v.render(first, 0, 9600);
    expect(pitchOf(first, 4800, 9600)).toBeGreaterThan(180);
    expect(pitchOf(first, 4800, 9600)).toBeLessThan(220);

    v.noteOn(800, 1, 0);
    const after = new Float32Array(48000);
    v.render(after, 0, 48000);
    const early = pitchOf(after, 0, 2400);
    const mid = pitchOf(after, 4800, 7200);
    const late = pitchOf(after, 43200, 48000);

    expect(early).toBeLessThan(400);           // has not jumped
    expect(mid).toBeGreaterThan(early + 40);   // is climbing
    expect(late).toBeGreaterThan(760);         // arrives
    expect(late).toBeLessThan(840);
  });

  it('jumps immediately when glide is zero', () => {
    const v = AnalogEngine.allocVoice(SR);
    for (let i = 0; i < PARAMS.length; i++) v.setParam(i, PARAMS[i]?.default ?? 0);
    for (const [id, value] of Object.entries(
      { ...STEADY, 'osc1-wave': 3, 'osc2-wave': 3, 'osc-mix': 0, 'filter-cutoff': 18000, 'glide': 0 },
    )) v.setParam(idx(id), value);
    v.noteOn(200, 1, 0);
    const a = new Float32Array(4800);
    v.render(a, 0, 4800);
    v.noteOn(800, 1, 0);
    const b = new Float32Array(4800);
    v.render(b, 0, 4800);
    expect(pitchOf(b, 0, 2400)).toBeGreaterThan(760);
  });
});

describe('AnalogVoice envelope curvature', () => {
  it('makes a low curve decay faster than a high one', () => {
    const patch = {
      ...STEADY, 'amp-decay': 600, 'amp-sustain': 0, 'amp-attack': 0.5,
      'filter-cutoff': 18000,
    };
    const level = (curve: number): number => {
      const buf = render({ ...patch, 'env-curve': curve }, 220, 1, 4096, 6000);
      return peak(buf);
    };
    const snappy = level(0);
    const even = level(1);
    expect(snappy).toBeLessThan(even * 0.6);
  });
});
