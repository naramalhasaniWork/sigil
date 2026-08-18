/**
 * Golden-harness plumbing: build the real TypeScript DSP for Node, generate
 * deterministic test signals, and write raw float32 goldens + manifest entries.
 *
 * Nothing here knows about any particular DSP module. Cases live in
 * scripts/golden/cases-*.mjs.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SRC = join(ROOT, 'src');
export const OUT_DIR = join(ROOT, 'native/goldens');
export const SR = 48000;

/**
 * Tolerance classes. See native/goldens/README.md for the full argument; the
 * short version:
 *
 *  exact  - no transcendental anywhere in the case. Pure +-*\/ and integer ops
 *           in IEEE-754 double, evaluated in the same order, must produce the
 *           same bits. Requires -ffp-contract=off on the C++ side.
 *  coeff  - a transcendental (exp/tan/pow/log) is evaluated at PARAMETER rate
 *           only; the per-sample path is pure arithmetic. V8 and Apple libm can
 *           disagree by ~1 ulp of double (2.2e-16 relative) on that one value,
 *           which a recursive filter amplifies by at most ~1/(1-|pole|).
 *  trans  - a transcendental is evaluated per SAMPLE. Same ~1 ulp disagreement,
 *           but on every sample, and it can flip a comparison and shift a state
 *           transition by one sample.
 *  chain  - a full voice or effect chain: `trans`, plus branchy stage machines
 *           where a 1-ulp difference can move an envelope stage change by one
 *           sample. That shows up as an isolated spike, not as drift, which is
 *           why the rig reports the worst indices and the over-tolerance COUNT.
 */
export const TOL = {
  exact: { maxAbs: 0, rms: 0 },
  coeff: { maxAbs: 1e-6, rms: 1e-7 },
  trans: { maxAbs: 1e-5, rms: 1e-6 },
  chain: { maxAbs: 1e-5, rms: 1e-6 },
};

/** Bundle the real TS DSP to ESM and import it. No TS is copied or edited. */
export async function loadDsp(exportsSource) {
  const r = await build({
    stdin: { contents: exportsSource, resolveDir: ROOT, loader: 'ts' },
    bundle: true, format: 'esm', write: false, target: 'es2022',
    alias: { '@': SRC },
  });
  const code = Buffer.from(r.outputFiles[0].contents).toString('utf8');
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/**
 * Load one DSP source file with extra exports appended, so module-private
 * builders (the sampler's built-in tone, the granular source) can be goldened.
 * The file on disk is read, never written.
 */
export async function loadProbe(relPath, extraExports) {
  const text = readFileSync(join(ROOT, relPath), 'utf8');
  return loadDspFrom(`${text}\n${extraExports}\n`, join(ROOT, dirname(relPath)));
}

async function loadDspFrom(contents, resolveDir) {
  const r = await build({
    stdin: { contents, resolveDir, loader: 'ts' },
    bundle: true, format: 'esm', write: false, target: 'es2022',
    alias: { '@': SRC },
  });
  const code = Buffer.from(r.outputFiles[0].contents).toString('utf8');
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

// ---------------------------------------------------------------------------
// Deterministic test signals. Integer/float arithmetic only, no transcendentals,
// so these are reproducible anywhere. Inputs are ALSO written to disk, so the
// C++ rig never regenerates them and a signal-generator mismatch cannot ever be
// misread as a DSP mismatch.
// ---------------------------------------------------------------------------

/** xorshift32 -> [-1, 1). Identical stream in C++ with uint32_t. */
export function noise(n, seed = 0x1234567) {
  const out = new Float32Array(n);
  let s = seed | 0;
  if (s === 0) s = 0x9e3779b9 | 0;
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    out[i] = (s >>> 0) / 2147483648 - 1;
  }
  return out;
}

export function impulse(n, at = 0, amp = 1) {
  const out = new Float32Array(n);
  if (at < n) out[at] = amp;
  return out;
}

export function step(n, at = 64, amp = 1) {
  const out = new Float32Array(n);
  for (let i = at; i < n; i++) out[i] = amp;
  return out;
}

export function dc(n, v) {
  const out = new Float32Array(n);
  out.fill(v);
  return out;
}

/** Linear ramp lo..hi inclusive. Used to probe memoryless shapers. */
export function ramp(n, lo, hi) {
  const out = new Float32Array(n);
  const d = n > 1 ? (hi - lo) / (n - 1) : 0;
  for (let i = 0; i < n; i++) out[i] = lo + d * i;
  return out;
}

/** Noise burst then silence: exercises decay tails and denormal flushing. */
export function burst(n, on, seed = 0x2468ace) {
  const out = noise(n, seed);
  for (let i = on; i < n; i++) out[i] = 0;
  return out;
}

/** Irregular block partition. Same sequence in the C++ rig (see parity.cpp). */
export const IRREGULAR_BLOCKS = [1, 7, 64, 128, 3, 199, 128, 32, 5, 256, 128, 64];

export function blockSizes(total, pattern) {
  const out = [];
  let left = total, k = 0;
  while (left > 0) {
    const b = Math.min(left, pattern[k % pattern.length]);
    out.push(b); left -= b; k++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Golden writing
// ---------------------------------------------------------------------------

const cases = [];
const files = new Map();

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function writeF32(name, data) {
  const f32 = data instanceof Float32Array ? data : Float32Array.from(data);
  // Force little-endian regardless of host, so goldens are portable.
  const buf = Buffer.alloc(f32.length * 4);
  for (let i = 0; i < f32.length; i++) buf.writeFloatLE(f32[i], i * 4);
  files.set(name, buf);
  return { file: name, frames: f32.length, sha256: sha256(buf) };
}

/**
 * Record one golden.
 *
 * @param {object} c
 * @param {string} c.id       unique case id; also the golden filename stem
 * @param {string} c.module   TS source file this exercises, e.g. 'ladder.ts'
 * @param {keyof TOL} c.tol   tolerance class
 * @param {Float32Array|Float32Array[]} c.output  one array per channel
 * @param {Float32Array|Float32Array[]} [c.input] one array per channel
 * @param {object} [c.params] free-form record of exactly how the case was set up
 * @param {string} [c.notes]
 */
export function emit(c) {
  const outs = Array.isArray(c.output) ? c.output : [c.output];
  const ins = c.input ? (Array.isArray(c.input) ? c.input : [c.input]) : null;
  const frames = outs[0].length;
  for (const o of outs) {
    if (o.length !== frames) throw new Error(`${c.id}: channel length mismatch`);
    for (let i = 0; i < o.length; i++) {
      if (!Number.isFinite(o[i]) && !c.allowNonFinite) {
        throw new Error(`${c.id}: non-finite output at ${i} (${o[i]})`);
      }
    }
  }
  const outFile = writeF32(`${c.id}.f32`, interleave(outs));
  const inFile = ins ? writeF32(`${c.id}.in.f32`, interleave(ins)) : null;
  cases.push({
    id: c.id,
    module: c.module,
    sampleRate: SR,
    dtype: 'f32le',
    channels: outs.length,
    frames,
    output: outFile,
    input: inFile ? { ...inFile, channels: ins.length, frames: ins[0].length } : null,
    tolClass: c.tol,
    tolerance: TOL[c.tol],
    params: c.params ?? {},
    notes: c.notes ?? '',
  });
}

function interleave(chans) {
  if (chans.length === 1) return chans[0];
  const n = chans[0].length;
  const out = new Float32Array(n * chans.length);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < chans.length; c++) out[i * chans.length + c] = chans[c][i];
  }
  return out;
}

export function flushAll() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, buf] of files) writeFileSync(join(OUT_DIR, name), buf);
  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const manifest = {
    version: 1,
    generator: 'scripts/golden.mjs',
    sampleRate: SR,
    dtype: 'f32le',
    toleranceClasses: TOL,
    caseCount: cases.length,
    cases,
  };
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(OUT_DIR, 'manifest.json'), json);
  return { caseCount: cases.length, fileCount: files.size + 1 };
}

/** Apply descriptor defaults, then id-keyed overrides, to an EngineVoice/FxUnit. */
export function applyParams(target, params, overrides = {}) {
  for (let i = 0; i < params.length; i++) target.setParam(i, params[i].default);
  for (const [id, v] of Object.entries(overrides)) {
    const i = params.findIndex((p) => p.id === id);
    if (i < 0) throw new Error(`no such parameter: ${id}`);
    target.setParam(i, v);
  }
}

/** Every parameter at min / max / midpoint, as an id->value record. */
export function extremeSet(params, which) {
  const o = {};
  for (const p of params) {
    o[p.id] = which === 'min' ? p.min : which === 'max' ? p.max : (p.min + p.max) * 0.5;
  }
  return o;
}
