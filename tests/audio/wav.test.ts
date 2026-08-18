import { describe, it, expect } from 'vitest';
import {
  KO2_SAMPLE_RATE,
  applyFades,
  encodeWav16,
  normalisePeak,
  resampleLinear,
  resampleSinc,
  trimToZeroCrossings,
} from '@/audio/wav';

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i] as number);
  return s;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function decodePcm16(bytes: Uint8Array): Int16Array {
  const view = viewOf(bytes);
  const dataSize = view.getUint32(40, true);
  const out = new Int16Array(dataSize / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(44 + i * 2, true);
  return out;
}

function sine(length: number, cyclesPerBuffer: number, amp = 1): Float32Array {
  const buf = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    buf[i] = amp * Math.sin((2 * Math.PI * cyclesPerBuffer * i) / length);
  }
  return buf;
}

describe('encodeWav16 — header', () => {
  const frames = 100;
  const bytes = encodeWav16([sine(frames, 4, 0.5)], KO2_SAMPLE_RATE);
  const view = viewOf(bytes);

  it('writes the RIFF/WAVE container with the right sizes', () => {
    expect(ascii(bytes, 0, 4)).toBe('RIFF');
    expect(ascii(bytes, 8, 4)).toBe('WAVE');
    expect(bytes.length).toBe(44 + frames * 2);
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
  });

  it('writes a 16-byte PCM fmt chunk', () => {
    expect(ascii(bytes, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(KO2_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16);
  });

  it('derives byte rate and block align from channels and bit depth', () => {
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint32(28, true)).toBe(KO2_SAMPLE_RATE * 2);
  });

  it('writes a data chunk whose length matches the payload', () => {
    expect(ascii(bytes, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(frames * 2);
    expect(view.getUint32(40, true)).toBe(bytes.length - 44);
  });

  it('interleaves stereo channels and doubles block align', () => {
    const left = new Float32Array([0.5, 0.5, 0.5]);
    const right = new Float32Array([-0.5, -0.5, -0.5]);
    const st = encodeWav16([left, right], 48000);
    const stView = viewOf(st);
    expect(stView.getUint16(22, true)).toBe(2);
    expect(stView.getUint16(32, true)).toBe(4);
    expect(stView.getUint32(28, true)).toBe(48000 * 4);
    const pcm = decodePcm16(st);
    expect(pcm.length).toBe(6);
    expect(pcm[0] as number).toBeGreaterThan(0);
    expect(pcm[1] as number).toBeLessThan(0);
  });
});

describe('encodeWav16 — quantisation', () => {
  it('round-trips a full-scale sine without clipping or wrapping', () => {
    const src = sine(2048, 7, 1);
    const pcm = decodePcm16(encodeWav16([src], KO2_SAMPLE_RATE));
    expect(pcm.length).toBe(src.length);
    for (let i = 0; i < src.length; i++) {
      const expected = (src[i] as number) * 32767;
      const actual = pcm[i] as number;
      // Wrap-around would flip the sign at the peaks; dither costs <= 2 LSB.
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2);
    }
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i] as number));
    expect(peak).toBeGreaterThan(32000);
    expect(peak).toBeLessThanOrEqual(32768);
  });

  it('clamps rather than wraps when fed over-range samples', () => {
    const pcm = decodePcm16(encodeWav16([new Float32Array([2, -2, 1.5])], 48000));
    expect(pcm[0] as number).toBe(32767);
    expect(pcm[1] as number).toBe(-32768);
    expect(pcm[2] as number).toBe(32767);
  });

  it('dithers silence instead of leaving a dead-flat zero floor', () => {
    const pcm = decodePcm16(encodeWav16([new Float32Array(4096)], 48000));
    let nonZero = 0;
    for (let i = 0; i < pcm.length; i++) if (pcm[i] !== 0) nonZero++;
    expect(nonZero).toBeGreaterThan(0);
    for (let i = 0; i < pcm.length; i++) expect(Math.abs(pcm[i] as number)).toBeLessThanOrEqual(1);
  });
});

describe('trimToZeroCrossings', () => {
  it('removes a leading and trailing DC offset', () => {
    const body = sine(1000, 5, 1);
    const buf = new Float32Array(1200);
    buf.fill(0.5);
    buf.set(body, 100);
    const out = trimToZeroCrossings(buf);
    expect(out.length).toBeLessThan(buf.length);
    expect(Math.abs(out[0] as number)).toBeLessThan(0.05);
    expect(Math.abs(out[out.length - 1] as number)).toBeLessThan(0.05);
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i] as number));
    expect(peak).toBeGreaterThan(0.9);
  });

  it('drops silent lead-in and tail while keeping the attack', () => {
    const buf = new Float32Array(1400);
    const body = sine(1000, 5, 0.8);
    buf.set(body, 200);
    const out = trimToZeroCrossings(buf);
    expect(out.length).toBeLessThan(buf.length);
    expect(out.length).toBeGreaterThanOrEqual(body.length - 2);
    expect(Math.abs(out[0] as number)).toBeLessThan(1e-6);
    expect(Math.abs(out[out.length - 1] as number)).toBeLessThan(1e-6);
  });

  it('returns empty for silence', () => {
    expect(trimToZeroCrossings(new Float32Array(64)).length).toBe(0);
    expect(trimToZeroCrossings(new Float32Array(0)).length).toBe(0);
  });
});

describe('normalisePeak', () => {
  it('lands the peak exactly at the requested headroom', () => {
    for (const headroom of [0, 1, 3, 6]) {
      const out = normalisePeak(sine(512, 3, 0.02), headroom);
      let peak = 0;
      for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i] as number));
      expect(peak).toBeCloseTo(Math.pow(10, -headroom / 20), 5);
    }
  });

  it('attenuates a too-hot buffer and leaves silence alone', () => {
    const hot = normalisePeak(new Float32Array([2, -1.4, 0.3]), 6);
    expect(Math.abs(hot[0] as number)).toBeCloseTo(0.501187, 5);
    const quiet = normalisePeak(new Float32Array(16), 1);
    expect(quiet.length).toBe(16);
    expect(quiet[0] as number).toBe(0);
  });
});

describe('applyFades', () => {
  it('starts and ends at zero without touching the middle', () => {
    const sr = 48000;
    const src = new Float32Array(4800);
    src.fill(1);
    const out = applyFades(src, 10, 10, sr);
    expect(out[0] as number).toBeCloseTo(0, 6);
    expect(out[out.length - 1] as number).toBeCloseTo(0, 6);
    expect(out[2400] as number).toBeCloseTo(1, 6);
  });

  it('clamps overlapping fades to the buffer length', () => {
    const out = applyFades(new Float32Array(100).fill(1), 1000, 1000, 48000);
    expect(out.length).toBe(100);
    for (let i = 0; i < out.length; i++) expect(Math.abs(out[i] as number)).toBeLessThanOrEqual(1);
  });
});

describe('resampling', () => {
  it('resampleLinear changes length by the rate ratio', () => {
    expect(resampleLinear(new Float32Array(1000), 48000, KO2_SAMPLE_RATE).length).toBe(
      Math.round((1000 * KO2_SAMPLE_RATE) / 48000),
    );
    expect(resampleLinear(new Float32Array(1000), 48000, 24000).length).toBe(500);
    expect(resampleLinear(new Float32Array(1000), 24000, 48000).length).toBe(2000);
    expect(resampleLinear(new Float32Array(1000), 48000, 48000).length).toBe(1000);
    expect(resampleLinear(new Float32Array(0), 48000, 24000).length).toBe(0);
  });

  it('resampleSinc keeps the same length ratio', () => {
    expect(resampleSinc(new Float32Array(1000), 48000, KO2_SAMPLE_RATE).length).toBe(977);
  });

  it('preserves a low-frequency sine through a 48000 -> 46875 conversion', () => {
    const src = sine(4800, 20, 0.8);
    const out = resampleSinc(src, 48000, KO2_SAMPLE_RATE);
    let peak = 0;
    for (let i = 200; i < out.length - 200; i++) peak = Math.max(peak, Math.abs(out[i] as number));
    expect(peak).toBeGreaterThan(0.75);
    expect(peak).toBeLessThan(0.85);
  });
});
