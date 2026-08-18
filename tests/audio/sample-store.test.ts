import { describe, it, expect } from 'vitest';
import {
  decodeAudioFile, toMono, normaliseSample, findZeroCrossing, detectPitchHz,
  saveSample, listSamples, loadSample, deleteSample, lastSampleStoreError,
  type StoredSample,
} from '@/audio/sample-store';

const SR = 48000;

function sine(hz: number, frames: number, sr = SR, amp = 0.5): Float32Array {
  const d = new Float32Array(frames);
  for (let i = 0; i < frames; i++) d[i] = Math.sin((2 * Math.PI * hz * i) / sr) * amp;
  return d;
}

function noise(frames: number): Float32Array {
  const d = new Float32Array(frames);
  let x = 0x9e3779b9;
  for (let i = 0; i < frames; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    d[i] = (x / 4294967296) * 2 - 1;
  }
  return d;
}

/** A stand-in AudioBuffer: enough surface for decodeAudioFile, nothing more. */
function fakeBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const first = channels[0];
  return {
    numberOfChannels: channels.length,
    length: first ? first.length : 0,
    sampleRate,
    duration: (first ? first.length : 0) / sampleRate,
    getChannelData: (i: number): Float32Array => channels[i] ?? new Float32Array(0),
  } as unknown as AudioBuffer;
}

function fakeCtx(buffer: AudioBuffer): BaseAudioContext {
  return {
    decodeAudioData: (_data: ArrayBuffer): Promise<AudioBuffer> => Promise.resolve(buffer),
  } as unknown as BaseAudioContext;
}

describe('decodeAudioFile', () => {
  it('flattens an AudioBuffer into a planar StoredSample', async () => {
    const left = sine(440, 1000);
    const right = sine(440, 1000, SR, 0.25);
    const ctx = fakeCtx(fakeBuffer([left, right], SR));
    const s = await decodeAudioFile(new ArrayBuffer(64), ctx);
    expect(s.channels).toBe(2);
    expect(s.frames).toBe(1000);
    expect(s.sampleRate).toBe(SR);
    expect(s.data.length).toBe(2000);
    expect(s.data[10]).toBeCloseTo(left[10] as number, 6);
    expect(s.data[1000 + 10]).toBeCloseTo(right[10] as number, 6);
    expect(s.id.length).toBeGreaterThan(0);
  });

  it('takes the name from a File and defaults it for raw bytes', async () => {
    const ctx = fakeCtx(fakeBuffer([sine(220, 128)], SR));
    const file = new File([new Uint8Array(8)], 'kick.wav', { type: 'audio/wav' });
    expect((await decodeAudioFile(file, ctx)).name).toBe('kick.wav');
    expect((await decodeAudioFile(new ArrayBuffer(8), ctx)).name).toBe('sample');
  });

  it('does not detach the ArrayBuffer it was handed', async () => {
    const ctx = fakeCtx(fakeBuffer([sine(220, 128)], SR));
    const raw = new ArrayBuffer(256);
    await decodeAudioFile(raw, ctx);
    expect(raw.byteLength).toBe(256);
  });
});

describe('toMono', () => {
  it('averages the channels of a stereo sample', () => {
    const left = new Float32Array([1, 1, 1]);
    const right = new Float32Array([0, -1, 0.5]);
    const data = new Float32Array(6);
    data.set(left, 0);
    data.set(right, 3);
    const s: StoredSample = {
      id: 'a', name: 'a', sampleRate: SR, channels: 2, frames: 3, data,
    };
    const mono = toMono(s);
    expect(mono.length).toBe(3);
    expect(mono[0]).toBeCloseTo(0.5, 6);
    expect(mono[1]).toBeCloseTo(0, 6);
    expect(mono[2]).toBeCloseTo(0.75, 6);
  });

  it('passes mono material straight through', () => {
    const data = new Float32Array([0.2, -0.4, 0.6]);
    const s: StoredSample = {
      id: 'a', name: 'a', sampleRate: SR, channels: 1, frames: 3, data,
    };
    expect(Array.from(toMono(s))).toEqual([
      Math.fround(0.2), Math.fround(-0.4), Math.fround(0.6),
    ]);
  });
});

describe('normaliseSample', () => {
  it('brings the loudest point to exactly the requested peak', () => {
    const out = normaliseSample(new Float32Array([0.1, -0.25, 0.05]), 0.9);
    let max = 0;
    for (const v of out) max = Math.max(max, Math.abs(v));
    expect(max).toBeCloseTo(0.9, 5);
    expect(out[0]).toBeCloseTo(0.36, 4);
    expect(out[1]).toBeCloseTo(-0.9, 4);
  });

  it('leaves silence alone rather than dividing by zero', () => {
    const out = normaliseSample(new Float32Array(16), 0.9);
    for (const v of out) expect(v).toBe(0);
  });

  it('does not modify the input', () => {
    const input = new Float32Array([0.1, -0.2]);
    normaliseSample(input, 1);
    expect(input[0]).toBeCloseTo(0.1, 6);
  });
});

describe('findZeroCrossing', () => {
  it('walks forward to the next crossing', () => {
    const d = sine(440, 2000);
    // Half a period of 440 Hz at 48 kHz is 54.5 samples.
    const i = findZeroCrossing(d, 50, 1);
    expect(i).toBeGreaterThanOrEqual(54);
    expect(i).toBeLessThanOrEqual(55);
  });

  it('walks backward to the previous crossing', () => {
    const d = sine(440, 2000);
    expect(findZeroCrossing(d, 50, -1)).toBe(0);
  });

  it('returns the start index when it is already at zero', () => {
    const d = new Float32Array([0.5, 0, -0.5]);
    expect(findZeroCrossing(d, 1, 1)).toBe(1);
  });

  it('returns the clamped start when no crossing exists', () => {
    const d = new Float32Array(64).fill(0.5);
    expect(findZeroCrossing(d, 10, 1)).toBe(10);
    expect(findZeroCrossing(d, -5, 1)).toBe(0);
    expect(findZeroCrossing(d, 999, -1)).toBe(63);
  });

  it('never returns an out-of-range index', () => {
    const d = sine(97, 500);
    for (const near of [-100, 0, 250, 499, 5000]) {
      for (const dir of [1, -1] as const) {
        const i = findZeroCrossing(d, near, dir);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(d.length);
      }
    }
  });
});

describe('detectPitchHz', () => {
  it('finds 440 Hz in a sine', () => {
    const hz = detectPitchHz(sine(440, SR), SR);
    expect(hz).not.toBeNull();
    expect(hz as number).toBeGreaterThan(437);
    expect(hz as number).toBeLessThan(443);
  });

  it('finds the fundamental of a harmonic tone, not an overtone', () => {
    const frames = SR;
    const d = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const t = (2 * Math.PI * i) / SR;
      d[i] = Math.sin(110 * t) * 0.4 + Math.sin(220 * t) * 0.5 + Math.sin(330 * t) * 0.3;
    }
    const hz = detectPitchHz(d, SR);
    expect(hz).not.toBeNull();
    expect(hz as number).toBeGreaterThan(108);
    expect(hz as number).toBeLessThan(112);
  });

  it('tracks pitch across the range at other sample rates', () => {
    for (const sr of [22050, 44100]) {
      for (const f of [82.41, 261.63, 880]) {
        const hz = detectPitchHz(sine(f, sr, sr), sr);
        expect(hz, `${f} Hz at ${sr}`).not.toBeNull();
        expect(Math.abs((hz as number) - f) / f, `${f} Hz at ${sr}`).toBeLessThan(0.02);
      }
    }
  });

  it('returns null for white noise rather than guessing', () => {
    expect(detectPitchHz(noise(SR), SR)).toBeNull();
  });

  it('returns null for silence and for buffers too short to analyse', () => {
    expect(detectPitchHz(new Float32Array(SR), SR)).toBeNull();
    expect(detectPitchHz(sine(440, 100), SR)).toBeNull();
  });

  it('ignores leading silence before the note starts', () => {
    const d = new Float32Array(SR);
    d.set(sine(220, SR >> 1), SR >> 1);
    const hz = detectPitchHz(d, SR);
    expect(hz).not.toBeNull();
    expect(Math.abs((hz as number) - 220) / 220).toBeLessThan(0.02);
  });
});

describe('persistence without IndexedDB', () => {
  // Node has no IndexedDB, which is the same shape of failure as private
  // browsing: the point is that none of these reject or throw.
  const sample: StoredSample = {
    id: 'x', name: 'x', sampleRate: SR, channels: 1, frames: 4,
    data: new Float32Array([0, 0.5, -0.5, 0]),
  };

  it('degrades quietly instead of throwing', async () => {
    await expect(saveSample(sample)).resolves.toBeUndefined();
    await expect(listSamples()).resolves.toEqual([]);
    await expect(loadSample('x')).resolves.toBeNull();
    await expect(deleteSample('x')).resolves.toBeUndefined();
  });

  it('reports why storage was unavailable', async () => {
    await saveSample(sample);
    const err = lastSampleStoreError();
    expect(err).not.toBeNull();
    expect((err as string).length).toBeGreaterThan(10);
  });
});
