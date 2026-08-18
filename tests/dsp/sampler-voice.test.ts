import { describe, it, expect } from 'vitest';
import type { EngineVoice } from '@/audio/types';
import { SamplerEngine, setActiveSample } from '@/dsp/sampler-voice';
import { SAMPLER_DESCRIPTOR } from '@/dsp/sampler-descriptor';

const SR = 48000;
const P_START = 0, P_END = 1, P_LOOP_MODE = 2, P_LOOP_START = 3, P_LOOP_LENGTH = 4;
const P_XFADE = 5, P_REVERSE = 6, P_CUTOFF = 9, P_ATTACK = 12, P_DECAY = 13;
const P_SUSTAIN = 14, P_RELEASE = 15, P_DRIVE = 16;

const TEST_ROOT = 250;
const TEST_FRAMES = 24000;

/** A plain 1 kHz sine: loud everywhere, so "still playing" is easy to measure. */
function testTone(): Float32Array {
  const d = new Float32Array(TEST_FRAMES);
  for (let i = 0; i < TEST_FRAMES; i++) d[i] = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.9;
  return d;
}

function useTestSample(): void { setActiveSample(testTone(), SR, TEST_ROOT); }

function peakOf(buf: Float32Array): number {
  let peak = 0;
  for (const s of buf) if (Math.abs(s) > peak) peak = Math.abs(s);
  return peak;
}

/** Index of the last sample loud enough to count as still sounding. */
function lastAudible(buf: Float32Array, floor = 0.02): number {
  for (let i = buf.length - 1; i >= 0; i--) if (Math.abs(buf[i] as number) > floor) return i;
  return -1;
}

/** Index of the first non-finite or runaway sample, or -1 if there is none. */
function firstBad(buf: Float32Array): number {
  for (let i = 0; i < buf.length; i++) {
    const y = buf[i] as number;
    if (!(y > -2 && y < 2)) return i;
  }
  return -1;
}

/** A one-shot with the envelope out of the way, so length is set by playback. */
function flatVoice(): EngineVoice {
  useTestSample();
  const v = SamplerEngine.allocVoice(SR);
  v.setParam(P_ATTACK, 0.5); v.setParam(P_DECAY, 8000); v.setParam(P_SUSTAIN, 1);
  v.setParam(P_DRIVE, 0); v.setParam(P_CUTOFF, 18000);
  return v;
}

describe('SamplerVoice', () => {
  // Runs first, before any test swaps the module-level buffer.
  it('sounds with the built-in sample before anything is loaded', () => {
    const v = SamplerEngine.allocVoice(SR);
    v.noteOn(261.63, 1, 0);
    const out = new Float32Array(SR >> 1);
    v.render(out, 0, out.length);
    expect(firstBad(out)).toBe(-1);
    expect(peakOf(out)).toBeGreaterThan(0.05);
  });

  it('produces audible, finite output after note-on', () => {
    const v = flatVoice();
    v.noteOn(TEST_ROOT, 1, 0);
    const out = new Float32Array(8192);
    v.render(out, 0, out.length);
    expect(firstBad(out)).toBe(-1);
    expect(peakOf(out)).toBeGreaterThan(0.05);
  });

  it('is silent before note-on', () => {
    useTestSample();
    const v = SamplerEngine.allocVoice(SR);
    const out = new Float32Array(512);
    v.render(out, 0, 512);
    for (const s of out) expect(s).toBe(0);
  });

  it('adds into the buffer rather than overwriting', () => {
    const v = flatVoice();
    v.noteOn(TEST_ROOT, 1, 0);
    const out = new Float32Array(2048);
    out.fill(1);
    v.render(out, 0, 2048);
    let changed = false;
    for (const s of out) if (s !== 1) changed = true;
    expect(changed).toBe(true);
  });

  it('respects the render offset and leaves the rest of the buffer alone', () => {
    const v = flatVoice();
    v.noteOn(TEST_ROOT, 1, 0);
    const out = new Float32Array(4096);
    v.render(out, 2048, 2048);
    for (let i = 0; i < 2048; i++) expect(out[i]).toBe(0);
  });

  it('finishes after release', () => {
    const v = flatVoice();
    v.setParam(P_LOOP_MODE, 1); v.setParam(P_RELEASE, 5);
    v.noteOn(TEST_ROOT, 1, 0);
    const out = new Float32Array(4800);
    v.render(out, 0, 4800);
    expect(v.isFinished()).toBe(false);
    v.noteOff();
    v.render(out, 0, 4800);
    v.render(out, 0, 4800);
    expect(v.isFinished()).toBe(true);
  });



  it('finishes when a one-shot runs off the end of the sample', () => {
    const v = flatVoice();
    v.noteOn(TEST_ROOT, 1, 0);
    const out = new Float32Array(TEST_FRAMES + 4096);
    v.render(out, 0, out.length);
    expect(v.isFinished()).toBe(true);
  });

  it('reads through the buffer at twice the rate an octave up', () => {
    const lengths: number[] = [];
    for (const freq of [TEST_ROOT, TEST_ROOT * 2]) {
      const v = flatVoice();
      v.noteOn(freq, 1, 0);
      const out = new Float32Array(TEST_FRAMES * 2);
      v.render(out, 0, out.length);
      lengths.push(lastAudible(out));
    }
    const [low, high] = lengths as [number, number];
    expect(low).toBeGreaterThan(TEST_FRAMES * 0.9);
    expect(low / high).toBeGreaterThan(1.9);
    expect(low / high).toBeLessThan(2.1);
  });

  it('keeps looping past the point a one-shot would have stopped', () => {
    const v = flatVoice();
    v.setParam(P_LOOP_MODE, 1);
    v.noteOn(TEST_ROOT, 1, 0);
    const out = new Float32Array(TEST_FRAMES * 3);
    v.render(out, 0, out.length);
    expect(lastAudible(out)).toBeGreaterThan(TEST_FRAMES * 2.5);
    expect(v.isFinished()).toBe(false);
  });
  it('crossfades a loop whose ends do not line up', () => {
    // Loop start 6012, length 6024 frames: the 1 kHz tone is at its positive
    // peak where the loop starts and its negative peak where it ends, so the
    // wrap is a full-scale step. That step is the click a crossfade exists for.
    const jumps: number[] = [];
    for (const fadeMs of [0, 20]) {
      const v = flatVoice();
      v.setParam(P_LOOP_MODE, 1); v.setParam(P_XFADE, fadeMs);
      v.setParam(P_LOOP_START, 6012 / 24000); v.setParam(P_LOOP_LENGTH, 6024 / 17988);
      v.noteOn(TEST_ROOT, 1, 0);
      const out = new Float32Array(TEST_FRAMES * 2);
      v.render(out, 0, out.length);
      let maxJump = 0;
      for (let i = 1; i < out.length; i++) {
        const jump = Math.abs((out[i] as number) - (out[i - 1] as number));
        if (jump > maxJump) maxJump = jump;
      }
      jumps.push(maxJump);
    }
    const [hard, faded] = jumps as [number, number];
    // One sample of a 1 kHz sine at this level steps by about 0.1.
    expect(hard).toBeGreaterThan(0.4);
    expect(faded).toBeLessThan(0.2);
  });

  it('ping-pong keeps the voice inside the loop and finite', () => {
    const v = flatVoice();
    v.setParam(P_LOOP_MODE, 2); v.setParam(P_LOOP_LENGTH, 0.25);
    v.noteOn(TEST_ROOT * 1.5, 1, 0);
    const out = new Float32Array(TEST_FRAMES * 2);
    v.render(out, 0, out.length);
    expect(firstBad(out)).toBe(-1);
    expect(lastAudible(out)).toBeGreaterThan(TEST_FRAMES);
  });

  it('reverse plays a different waveform of the same length', () => {
    const forward = new Float32Array(TEST_FRAMES + 512);
    const backward = new Float32Array(TEST_FRAMES + 512);
    const a = flatVoice();
    a.noteOn(TEST_ROOT, 1, 0);
    a.render(forward, 0, forward.length);
    const b = flatVoice();
    b.setParam(P_REVERSE, 1);
    b.noteOn(TEST_ROOT, 1, 0);
    b.render(backward, 0, backward.length);
    let differs = false;
    for (let i = 0; i < forward.length; i++) if (forward[i] !== backward[i]) differs = true;
    expect(differs).toBe(true);
    expect(Math.abs(lastAudible(forward) - lastAudible(backward))).toBeLessThan(256);
  });
  it('start and end trim shorten what plays', () => {
    const v = flatVoice();
    v.setParam(P_START, 0.25); v.setParam(P_END, 0.75);
    v.noteOn(TEST_ROOT, 1, 0);
    const out = new Float32Array(TEST_FRAMES * 2);
    v.render(out, 0, out.length);
    const last = lastAudible(out);
    expect(last).toBeGreaterThan(TEST_FRAMES * 0.4);
    expect(last).toBeLessThan(TEST_FRAMES * 0.6);
  });

  it('does not grow the heap across a sustained render', () => {
    // Without a real gc() this measures framework garbage, not the render loop.
    expect(typeof global.gc, 'run vitest with --expose-gc').toBe('function');
    const v = flatVoice();
    v.setParam(P_LOOP_MODE, 1);
    v.noteOn(TEST_ROOT, 1, 0);
    const out = new Float32Array(128);
    for (let i = 0; i < 500; i++) { out.fill(0); v.render(out, 0, 128); }
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 4000; i++) { out.fill(0); v.render(out, 0, 128); }
    global.gc?.();
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024);
  });

  it('survives every parameter at both extremes without NaN', () => {
    useTestSample();
    const params = SAMPLER_DESCRIPTOR.params;
    for (let p = 0; p < params.length; p++) {
      const d = params[p];
      if (!d) continue;
      for (const value of [d.min, d.max]) {
        const v = SamplerEngine.allocVoice(SR);
        v.setParam(p, value);
        v.noteOn(880, 1, 2);
        const out = new Float32Array(12288);
        v.render(out, 0, out.length);
        expect(firstBad(out), `${d.id} at ${value}`).toBe(-1);
      }
    }
  });

  it('survives extreme note frequencies without NaN', () => {
    for (const freq of [16, 55, 4186, 12000]) {
      const v = flatVoice();
      v.setParam(P_LOOP_MODE, 1);
      v.noteOn(freq, 1, 0);
      const out = new Float32Array(8192);
      v.render(out, 0, out.length);
      expect(firstBad(out), `at ${freq} Hz`).toBe(-1);
    }
  });

  it('runs at other sample rates', () => {
    for (const sr of [22050, 44100, 96000]) {
      useTestSample();
      const v = SamplerEngine.allocVoice(sr);
      v.setParam(P_DRIVE, 0);
      v.noteOn(TEST_ROOT, 1, 0);
      const out = new Float32Array(sr >> 3);
      v.render(out, 0, out.length);
      expect(firstBad(out), `at ${sr} Hz`).toBe(-1);
      expect(peakOf(out), `at ${sr} Hz`).toBeGreaterThan(0.05);
    }
  });

  it('ignores a sample swap that is obviously broken', () => {
    useTestSample();
    setActiveSample(new Float32Array(4), 0, 0);
    const v = SamplerEngine.allocVoice(SR);
    v.noteOn(TEST_ROOT, 1, 0);
    const out = new Float32Array(4096);
    v.render(out, 0, out.length);
    expect(peakOf(out)).toBeGreaterThan(0.05);
  });
});

describe('SAMPLER_DESCRIPTOR', () => {
  it('gives every parameter a non-empty explanation', () => {
    for (const p of SAMPLER_DESCRIPTOR.params) {
      expect(p.explain.length, `${p.id} needs an explanation`).toBeGreaterThan(20);
    }
  });

  it('has unique parameter ids and defaults inside their own range', () => {
    const ids = SAMPLER_DESCRIPTOR.params.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of SAMPLER_DESCRIPTOR.params) {
      expect(p.default, p.id).toBeGreaterThanOrEqual(p.min);
      expect(p.default, p.id).toBeLessThanOrEqual(p.max);
    }
  });

  it('assigns exactly four macros, each with a depth', () => {
    const macroed = SAMPLER_DESCRIPTOR.params.filter((p) => p.macro !== undefined);
    expect(new Set(macroed.map((p) => p.macro))).toEqual(new Set([0, 1, 2, 3]));
    expect(macroed.length).toBe(4);
    for (const p of macroed) {
      expect(p.macroDepth, `${p.id} needs a macroDepth`).toBeGreaterThan(0);
    }
  });
});
