/** Iterative radix-2 FFT. Test utility only — never used in the audio path. */
export function magnitudeSpectrum(samples: Float32Array): Float32Array {
  const n = samples.length;
  if ((n & (n - 1)) !== 0) throw new Error('length must be a power of two');

  const re = Float64Array.from(samples);
  const im = new Float64Array(n);

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number; re[i] = re[j] as number; re[j] = tr;
      const ti = im[i] as number; im[i] = im[j] as number; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len / 2;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k] as number;
        const ui = im[i + k] as number;
        const vr0 = re[i + k + half] as number;
        const vi0 = im[i + k + half] as number;
        const vr = vr0 * cr - vi0 * ci;
        const vi = vr0 * ci + vi0 * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }

  const out = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i] as number, im[i] as number) / (n / 2);
  return out;
}
