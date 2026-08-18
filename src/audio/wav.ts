/**
 * Pure sample-buffer maths for the bounce pipeline. No Web Audio, no DOM —
 * everything here is unit-testable in Node and safe to call on the main thread.
 *
 * These functions run once per bounce, not per audio block, so they allocate
 * freely; the zero-allocation discipline applies to the worklet, not here.
 */

/** The EP-133 K.O. II's native rate. Everything aims here. */
export const KO2_SAMPLE_RATE = 46875;

/** Anything at or below this counts as "already at zero" for trimming. */
const ZERO_GATE_RATIO = 1e-3;

function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const mag = Math.abs(samples[i] as number);
    if (mag > peak) peak = mag;
  }
  return peak;
}

/** True when the signal changes sign (or touches zero) between a and b. */
function crosses(a: number, b: number): boolean {
  return a * b <= 0;
}

/**
 * Trim leading and trailing material so the buffer both starts and ends at (or
 * very near) zero. A one-shot that starts on a non-zero value clicks on every
 * trigger, and the KO II triggers samples constantly.
 *
 * Boundaries first walk *outward* into the near-silent lead-in/tail (this keeps
 * the whole attack transient). If the boundary sample is still well away from
 * zero — a DC pedestal, or a hard-cut render — the boundary instead moves
 * *inward* to the first real zero crossing, which is the only click-free cut.
 */
export function trimToZeroCrossings(samples: Float32Array): Float32Array {
  const n = samples.length;
  if (n === 0) return new Float32Array(0);
  const peak = peakOf(samples);
  if (peak === 0) return new Float32Array(0);
  const gate = peak * ZERO_GATE_RATIO;

  let a = 0;
  while (a < n && Math.abs(samples[a] as number) < gate) a++;
  let b = n - 1;
  while (b > a && Math.abs(samples[b] as number) < gate) b--;
  if (a >= b) return new Float32Array(0);

  while (a > 0 && Math.abs(samples[a - 1] as number) < Math.abs(samples[a] as number)) a--;
  if (Math.abs(samples[a] as number) > gate) {
    let i = a + 1;
    while (i <= b && !crosses(samples[i - 1] as number, samples[i] as number)) i++;
    if (i <= b) a = i;
  }

  while (b < n - 1 && Math.abs(samples[b + 1] as number) < Math.abs(samples[b] as number)) b++;
  if (Math.abs(samples[b] as number) > gate) {
    let i = b - 1;
    while (i > a && !crosses(samples[i] as number, samples[i + 1] as number)) i--;
    if (i > a) b = i;
  }

  return samples.slice(a, b + 1);
}

/**
 * Scale so the loudest sample sits exactly `headroomDb` below full scale.
 * Headroom matters because the KO II adds its own gain staging on playback —
 * a sample normalised to 0 dBFS distorts the moment you touch its volume.
 * Returns a new buffer; a silent input is returned unchanged.
 */
export function normalisePeak(samples: Float32Array, headroomDb: number): Float32Array {
  const out = samples.slice();
  const peak = peakOf(out);
  if (peak === 0) return out;
  const target = Math.pow(10, -Math.abs(headroomDb) / 20);
  const gain = target / peak;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * gain;
  return out;
}

/**
 * Raised-cosine fades at each end. Cosine rather than linear because a linear
 * ramp has a corner at both ends, and corners are broadband clicks.
 * Fades are clamped so they can never overlap.
 */
export function applyFades(
  samples: Float32Array,
  fadeInMs: number,
  fadeOutMs: number,
  sampleRate: number,
): Float32Array {
  const out = samples.slice();
  const n = out.length;
  if (n === 0 || sampleRate <= 0) return out;

  let inLen = Math.min(n, Math.max(0, Math.round((fadeInMs / 1000) * sampleRate)));
  let outLen = Math.min(n, Math.max(0, Math.round((fadeOutMs / 1000) * sampleRate)));
  if (inLen + outLen > n) {
    const scale = n / (inLen + outLen);
    inLen = Math.floor(inLen * scale);
    outLen = Math.floor(outLen * scale);
  }

  for (let i = 0; i < inLen; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / inLen);
    out[i] = (out[i] as number) * g;
  }
  for (let i = 0; i < outLen; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / outLen);
    out[n - 1 - i] = (out[n - 1 - i] as number) * g;
  }
  return out;
}

function outputLength(inputLength: number, fromRate: number, toRate: number): number {
  if (inputLength === 0) return 0;
  return Math.max(1, Math.round((inputLength * toRate) / fromRate));
}

/**
 * Linear-interpolating resampler.
 *
 * TRADEOFF: linear interpolation is a weak lowpass — it leaves audible imaging
 * on downward conversion and dulls the top octave. For the 48000 → 46875 path
 * the ratio is 0.9766, so the artefacts are small, but `resampleSinc` below is
 * what the bounce pipeline actually uses. This stays because it is cheap,
 * exactly predictable, and useful for previews.
 */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate <= 0 || toRate <= 0) return new Float32Array(0);
  if (fromRate === toRate) return samples.slice();
  const n = samples.length;
  const outLen = outputLength(n, fromRate, toRate);
  const out = new Float32Array(outLen);
  if (n === 0) return out;
  const step = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const s0 = i0 < n ? (samples[i0] as number) : 0;
    const s1 = i0 + 1 < n ? (samples[i0 + 1] as number) : 0;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

const SINC_HALF_TAPS = 16;

function blackman(x: number): number {
  // x in [0,1]
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/**
 * Blackman-windowed sinc resampler, 32 taps. On downward conversion the kernel
 * cutoff follows the new Nyquist, so nothing folds back as aliasing — this is
 * the difference between a resampled sample that still sounds like the patch
 * and one that sounds slightly grainy on the top end.
 */
export function resampleSinc(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate <= 0 || toRate <= 0) return new Float32Array(0);
  if (fromRate === toRate) return samples.slice();
  const n = samples.length;
  const outLen = outputLength(n, fromRate, toRate);
  const out = new Float32Array(outLen);
  if (n === 0) return out;

  const step = fromRate / toRate;
  const cutoff = Math.min(1, toRate / fromRate);
  const halfWidth = SINC_HALF_TAPS / cutoff;

  for (let i = 0; i < outLen; i++) {
    const centre = i * step;
    const first = Math.ceil(centre - halfWidth);
    const last = Math.floor(centre + halfWidth);
    let acc = 0;
    let norm = 0;
    for (let j = first; j <= last; j++) {
      const dist = centre - j;
      const w = blackman(0.5 + dist / (2 * halfWidth));
      const k = cutoff * sinc(cutoff * dist) * w;
      norm += k;
      if (j >= 0 && j < n) acc += (samples[j] as number) * k;
    }
    out[i] = norm !== 0 ? acc / norm : 0;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * 16-bit PCM WAV, little-endian, with TPDF dither applied before quantisation.
 * Dither replaces the correlated quantisation distortion you hear on quiet
 * tails ("granular" decays) with a low, constant noise floor — the tail of a
 * sample is exactly where a 16-bit truncation is most audible.
 */
export function encodeWav16(
  channels: readonly Float32Array[],
  sampleRate: number,
): Uint8Array {
  const numChannels = Math.max(1, channels.length);
  let frames = 0;
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c];
    if (ch && ch.length > frames) frames = ch.length;
  }

  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const ch = channels[c];
      const sample = ch && i < ch.length ? (ch[i] as number) : 0;
      // TPDF: sum of two uniforms, peak ±1 LSB, zero mean.
      const dither = Math.random() + Math.random() - 1;
      const scaled = Math.round(sample * 32767 + dither);
      const clamped = scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled;
      view.setInt16(offset, clamped, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}
