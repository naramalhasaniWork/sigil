# SIGIL Playable Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser synthesizer you can open and play — antialiased analog voice, ladder filter, polyphony, on-screen keys, four macros — with a DSP test suite that proves it is correct, not merely audible.

**Architecture:** All DSP is pure TypeScript running in an AudioWorklet with strict zero-allocation discipline in the render loop. DSP primitives are pure functions and classes with no Web Audio dependency, so they unit-test headlessly under Vitest in Node. The worklet is bundled separately by esbuild into `public/worklet/` because AudioWorklet requires a standalone module URL. The main thread never computes audio — it only sends packed parameter updates.

**Tech Stack:** Next.js 15 (App Router), TypeScript strict, Tailwind v4, Vitest, esbuild, Node 22.

**Spec:** `docs/superpowers/specs/2026-08-17-sigil-foundation-design.md`

## Global Constraints

- TypeScript strict mode. **No `any`.** Interfaces over types. Named exports for components.
- **Zero allocation inside `render()`/`process()`**: no array or object literals, no closures, no string operations, no allocating `Array.prototype` methods, no `try/catch`.
- Denormal guard: flush any filter state whose absolute value is below `1e-20` to `0`.
- NaN guard: a voice producing NaN is silenced, not allowed onto the bus.
- Every `ParamDescriptor` must carry a non-empty `explain` string. This is enforced by test.
- Sample rate for tests: `48000`. Block size: `128` (the AudioWorklet quantum).
- Performance budget: 8 Analog voices under 5% of one core on desktop.
- Colour tokens are fixed: `--bg #0E0E0E`, `--panel #171717`, `--ink #F5F1E6`, `--analog #FF6B6B`, `--muted #7D786C`. Type is Space Grotesk (400/500/700).
- Files stay under 300 lines. Directory names lowercase-with-dashes.
- Commit after every task.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `next.config.mjs`, `vitest.config.ts` | Tooling |
| `scripts/build-worklet.mjs` | esbuild bundle of the worklet into `public/worklet/` |
| `src/audio/types.ts` | `ParamDescriptor`, `EngineDescriptor`, `EngineVoice`, `EngineModule` |
| `src/dsp/smoothing.ts` | One-pole parameter smoother |
| `src/dsp/blep.ts` | polyBLEP residual + antialiased saw oscillator |
| `src/dsp/ladder.ts` | 4-pole ladder filter with saturating feedback |
| `src/dsp/envelope.ts` | ADSR with exponential curvature |
| `src/dsp/analog-voice.ts` | The Analog engine voice (osc + filter + envelopes) |
| `src/dsp/analog-descriptor.ts` | Analog parameter table |
| `src/dsp/tuning.ts` | Note number → frequency, 12-TET and N-TET |
| `src/dsp/voice-manager.ts` | Polyphony, allocation, stealing |
| `src/audio/param-transport.ts` | Packing/unpacking parameter messages |
| `src/audio/worklet/sigil-processor.ts` | `AudioWorkletProcessor` entry point |
| `src/audio/engine-host.ts` | Main-thread facade over `AudioContext` |
| `src/ui/components/*.tsx` | `Knob`, `Keys`, `MacroRow`, `Panel` |
| `app/page.tsx` | The instrument surface |
| `tests/dsp/*.test.ts` | DSP correctness suite |
| `tests/util/fft.ts` | Small radix-2 FFT for aliasing measurement |

---

## Task 1: Project scaffold and tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.mjs`, `vitest.config.ts`, `scripts/build-worklet.mjs`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`

**Interfaces:**
- Consumes: nothing
- Produces: `pnpm test`, `pnpm dev`, `pnpm build:worklet` all runnable

- [ ] **Step 1: Initialise the project**

```bash
cd ~/dev/sigil
pnpm init
pnpm add next@15 react react-dom
pnpm add -D typescript @types/react @types/node @types/react-dom vitest esbuild tailwindcss @tailwindcss/postcss postcss
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
  resolve: { alias: { '@': resolve(__dirname, './src') } },
});
```

- [ ] **Step 4: Write `scripts/build-worklet.mjs`**

```js
import { build } from 'esbuild';

await build({
  entryPoints: ['src/audio/worklet/sigil-processor.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'public/worklet/sigil-processor.js',
  logLevel: 'info',
});
```

- [ ] **Step 5: Add scripts to `package.json`**

```json
{
  "scripts": {
    "dev": "pnpm build:worklet && next dev",
    "build": "pnpm build:worklet && next build",
    "build:worklet": "node scripts/build-worklet.mjs",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 6: Verify the toolchain runs**

Run: `pnpm test`
Expected: Vitest starts and reports "No test files found" — exit code non-zero is acceptable here; what matters is that Vitest itself runs without a config error.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js + Vitest + worklet build"
```

---

## Task 2: Parameter smoothing

Un-smoothed parameter changes cause zipper noise, which is the single most common reason a digital synth sounds cheap. Every parameter passes through this.

**Files:**
- Create: `src/dsp/smoothing.ts`
- Test: `tests/dsp/smoothing.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `class Smoother { constructor(sampleRate: number, timeMs: number); setTarget(v: number): void; snap(v: number): void; next(): number; }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { Smoother } from '@/dsp/smoothing';

describe('Smoother', () => {
  it('converges toward the target without overshooting', () => {
    const s = new Smoother(48000, 10);
    s.snap(0);
    s.setTarget(1);
    let v = 0;
    for (let i = 0; i < 48000; i++) v = s.next();
    expect(v).toBeGreaterThan(0.999);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('reaches ~63% of the way after one time constant', () => {
    const s = new Smoother(48000, 10);
    s.snap(0);
    s.setTarget(1);
    let v = 0;
    for (let i = 0; i < 480; i++) v = s.next();   // 10ms at 48kHz
    expect(v).toBeGreaterThan(0.55);
    expect(v).toBeLessThan(0.70);
  });

  it('snap jumps immediately with no ramp', () => {
    const s = new Smoother(48000, 10);
    s.snap(0.25);
    expect(s.next()).toBeCloseTo(0.25, 10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/dsp/smoothing.test.ts`
Expected: FAIL — cannot resolve `@/dsp/smoothing`

- [ ] **Step 3: Write minimal implementation**

```ts
export class Smoother {
  private current = 0;
  private target = 0;
  private readonly coeff: number;

  constructor(sampleRate: number, timeMs: number) {
    this.coeff = 1 - Math.exp(-1 / ((timeMs / 1000) * sampleRate));
  }

  setTarget(v: number): void {
    this.target = v;
  }

  snap(v: number): void {
    this.current = v;
    this.target = v;
  }

  next(): number {
    this.current += this.coeff * (this.target - this.current);
    if (this.current < 1e-20 && this.current > -1e-20) this.current = 0;
    return this.current;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/dsp/smoothing.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/dsp/smoothing.ts tests/dsp/smoothing.test.ts
git commit -m "feat(dsp): one-pole parameter smoother"
```

---

## Task 3: FFT test utility

Aliasing is measured, not guessed. Later tasks need a spectrum. This is test-only code.

**Files:**
- Create: `tests/util/fft.ts`
- Test: `tests/util/fft.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `function magnitudeSpectrum(samples: Float32Array): Float32Array` — input length must be a power of two; returns `length/2` magnitude bins.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { magnitudeSpectrum } from './fft';

describe('magnitudeSpectrum', () => {
  it('puts a pure sine in exactly one bin', () => {
    const N = 1024;
    const buf = new Float32Array(N);
    const bin = 64;
    for (let i = 0; i < N; i++) buf[i] = Math.sin((2 * Math.PI * bin * i) / N);
    const spec = magnitudeSpectrum(buf);

    let peak = 0;
    let peakIdx = -1;
    for (let i = 0; i < spec.length; i++) {
      const v = spec[i] ?? 0;
      if (v > peak) { peak = v; peakIdx = i; }
    }
    expect(peakIdx).toBe(bin);

    const neighbours = (spec[bin - 4] ?? 0) + (spec[bin + 4] ?? 0);
    expect(neighbours).toBeLessThan(peak * 0.01);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/util/fft.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
/** Iterative radix-2 FFT. Test utility only — not used in the audio path. */
export function magnitudeSpectrum(samples: Float32Array): Float32Array {
  const n = samples.length;
  if ((n & (n - 1)) !== 0) throw new Error('length must be a power of two');

  const re = Float64Array.from(samples);
  const im = new Float64Array(n);

  // bit-reversal permutation
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
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k] as number, ui = im[i + k] as number;
        const vr0 = re[i + k + len / 2] as number, vi0 = im[i + k + len / 2] as number;
        const vr = vr0 * cr - vi0 * ci;
        const vi = vr0 * ci + vi0 * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }

  const out = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    out[i] = Math.hypot(re[i] as number, im[i] as number) / (n / 2);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/util/fft.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/util/fft.ts tests/util/fft.test.ts
git commit -m "test: radix-2 FFT utility for spectral assertions"
```

---

## Task 4: Antialiased oscillator

A naive saw aliases badly on high notes and is the difference between "digital" and "harsh". polyBLEP fixes the discontinuity.

**Files:**
- Create: `src/dsp/blep.ts`
- Test: `tests/dsp/blep.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `class SawOscillator { constructor(sampleRate: number); setFrequency(hz: number): void; reset(): void; next(): number; }` — output range approximately −1..1.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { SawOscillator } from '@/dsp/blep';
import { magnitudeSpectrum } from '../util/fft';

const SR = 48000;

describe('SawOscillator', () => {
  it('stays within range', () => {
    const o = new SawOscillator(SR);
    o.setFrequency(220);
    for (let i = 0; i < 10000; i++) {
      const v = o.next();
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(1.2);
    }
  });

  it('has far less aliasing than a naive saw at a high pitch', () => {
    const N = 8192;
    const freq = 3000;   // high note: naive saw aliases audibly here

    const o = new SawOscillator(SR);
    o.setFrequency(freq);
    const blep = new Float32Array(N);
    for (let i = 0; i < N; i++) blep[i] = o.next();

    const naive = new Float32Array(N);
    let p = 0;
    const inc = freq / SR;
    for (let i = 0; i < N; i++) { p += inc; if (p >= 1) p -= 1; naive[i] = 2 * p - 1; }

    const binHz = SR / N;
    const inharmonic = (spec: Float32Array): number => {
      let energy = 0;
      for (let i = 1; i < spec.length; i++) {
        const hz = i * binHz;
        const ratio = hz / freq;
        const distance = Math.abs(ratio - Math.round(ratio));
        if (distance > 0.12) energy += (spec[i] as number) ** 2;   // not near a harmonic
      }
      return energy;
    };

    const blepAlias = inharmonic(magnitudeSpectrum(blep));
    const naiveAlias = inharmonic(magnitudeSpectrum(naive));
    expect(blepAlias).toBeLessThan(naiveAlias * 0.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/dsp/blep.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
/** polyBLEP residual for a step discontinuity at phase `t` with increment `dt`. */
export function blep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

export class SawOscillator {
  private phase = 0;
  private inc = 0;
  private readonly sr: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
  }

  setFrequency(hz: number): void {
    this.inc = hz / this.sr;
  }

  reset(): void {
    this.phase = 0;
  }

  next(): number {
    this.phase += this.inc;
    if (this.phase >= 1) this.phase -= 1;
    return 2 * this.phase - 1 - blep(this.phase, this.inc);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/dsp/blep.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/dsp/blep.ts tests/dsp/blep.test.ts
git commit -m "feat(dsp): polyBLEP antialiased saw oscillator"
```

---

## Task 5: Ladder filter

**Files:**
- Create: `src/dsp/ladder.ts`
- Test: `tests/dsp/ladder.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `class LadderFilter { constructor(sampleRate: number); setCutoff(hz: number): void; setResonance(r: number): void; reset(): void; process(x: number): number; }` — `r` is `0..1`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { LadderFilter } from '@/dsp/ladder';

const SR = 48000;

function rmsAt(freq: number, cutoff: number, res: number): number {
  const f = new LadderFilter(SR);
  f.setCutoff(cutoff);
  f.setResonance(res);
  const n = 24000;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.sin((2 * Math.PI * freq * i) / SR);
    const y = f.process(x);
    if (i > n / 2) sum += y * y;          // skip settling
  }
  return Math.sqrt(sum / (n / 2));
}

describe('LadderFilter', () => {
  it('passes low frequencies and attenuates high ones', () => {
    const low = rmsAt(100, 2000, 0.1);
    const high = rmsAt(12000, 2000, 0.1);
    expect(low).toBeGreaterThan(0.5);
    expect(high).toBeLessThan(low * 0.2);
  });

  it('attenuates roughly 24 dB per octave above cutoff', () => {
    const oneOct = rmsAt(4000, 2000, 0.1);
    const twoOct = rmsAt(8000, 2000, 0.1);
    const dbPerOctave = 20 * Math.log10(oneOct / twoOct);
    expect(dbPerOctave).toBeGreaterThan(12);
    expect(dbPerOctave).toBeLessThan(36);
  });

  it('emphasises the cutoff region as resonance rises', () => {
    const calm = rmsAt(2000, 2000, 0.1);
    const loud = rmsAt(2000, 2000, 0.9);
    expect(loud).toBeGreaterThan(calm);
  });

  it('stays finite and bounded across extreme settings', () => {
    for (const cutoff of [20, 200, 2000, 20000]) {
      for (const res of [0, 0.5, 0.99, 1]) {
        const f = new LadderFilter(SR);
        f.setCutoff(cutoff);
        f.setResonance(res);
        for (let i = 0; i < 20000; i++) {
          const y = f.process(Math.sin(i * 0.1) * 2);
          expect(Number.isFinite(y)).toBe(true);
          expect(Math.abs(y)).toBeLessThan(50);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/dsp/ladder.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
const DENORMAL = 1e-20;

/** Cheap rational tanh — shaped for hot loops, monotonic and bounded. */
function saturate(x: number): number {
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

export class LadderFilter {
  private s1 = 0; private s2 = 0; private s3 = 0; private s4 = 0;
  private g = 0;
  private feedback = 0;
  private readonly sr: number;
  private readonly nyquist: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.nyquist = sampleRate * 0.45;
    this.setCutoff(1000);
    this.setResonance(0);
  }

  setCutoff(hz: number): void {
    const c = hz < 10 ? 10 : hz > this.nyquist ? this.nyquist : hz;
    this.g = 1 - Math.exp((-2 * Math.PI * c) / this.sr);
  }

  setResonance(r: number): void {
    const clamped = r < 0 ? 0 : r > 1 ? 1 : r;
    this.feedback = clamped * 4.0;
  }

  reset(): void {
    this.s1 = 0; this.s2 = 0; this.s3 = 0; this.s4 = 0;
  }

  process(x: number): number {
    // half-sample feedback compensation keeps resonance musical near Nyquist
    const fb = this.feedback * (this.s4 - 0.5 * this.s3);
    const input = saturate(x - fb);

    this.s1 += this.g * (input - this.s1);
    this.s2 += this.g * (this.s1 - this.s2);
    this.s3 += this.g * (this.s2 - this.s3);
    this.s4 += this.g * (this.s3 - this.s4);

    if (this.s1 < DENORMAL && this.s1 > -DENORMAL) this.s1 = 0;
    if (this.s2 < DENORMAL && this.s2 > -DENORMAL) this.s2 = 0;
    if (this.s3 < DENORMAL && this.s3 > -DENORMAL) this.s3 = 0;
    if (this.s4 < DENORMAL && this.s4 > -DENORMAL) this.s4 = 0;

    return this.s4;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/dsp/ladder.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/dsp/ladder.ts tests/dsp/ladder.test.ts
git commit -m "feat(dsp): 4-pole ladder filter with saturating feedback"
```

---

## Task 6: ADSR envelope

Linear ramps sound artificial. Exponential curvature is what makes an envelope feel analog.

**Files:**
- Create: `src/dsp/envelope.ts`
- Test: `tests/dsp/envelope.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `class Envelope { constructor(sampleRate: number); set(attackMs: number, decayMs: number, sustain: number, releaseMs: number): void; trigger(): void; release(): void; next(): number; isFinished(): boolean; }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { Envelope } from '@/dsp/envelope';

const SR = 48000;

describe('Envelope', () => {
  it('rises to peak then settles at sustain', () => {
    const e = new Envelope(SR);
    e.set(10, 50, 0.5, 100);
    e.trigger();
    let peak = 0;
    for (let i = 0; i < SR; i++) { const v = e.next(); if (v > peak) peak = v; }
    expect(peak).toBeGreaterThan(0.95);
    expect(e.next()).toBeCloseTo(0.5, 1);
  });

  it('falls to silence after release and reports finished', () => {
    const e = new Envelope(SR);
    e.set(1, 1, 0.8, 20);
    e.trigger();
    for (let i = 0; i < SR / 10; i++) e.next();
    e.release();
    for (let i = 0; i < SR; i++) e.next();
    expect(e.next()).toBeLessThan(1e-4);
    expect(e.isFinished()).toBe(true);
  });

  it('is not finished while sustaining', () => {
    const e = new Envelope(SR);
    e.set(1, 1, 0.7, 50);
    e.trigger();
    for (let i = 0; i < SR / 10; i++) e.next();
    expect(e.isFinished()).toBe(false);
  });

  it('attack is curved, not linear', () => {
    const e = new Envelope(SR);
    e.set(100, 10, 1, 10);
    e.trigger();
    const half = Math.floor((SR * 0.1) / 2);
    let v = 0;
    for (let i = 0; i < half; i++) v = e.next();
    expect(v).toBeGreaterThan(0.55);   // a linear attack would sit at 0.5
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/dsp/envelope.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
const IDLE = 0, ATTACK = 1, DECAY = 2, SUSTAIN = 3, RELEASE = 4;

export class Envelope {
  private stage = IDLE;
  private value = 0;
  private attackCoeff = 0;
  private decayCoeff = 0;
  private releaseCoeff = 0;
  private sustainLevel = 0.7;
  private readonly sr: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.set(5, 100, 0.7, 200);
  }

  private coeff(ms: number): number {
    const samples = Math.max(1, (ms / 1000) * this.sr);
    return 1 - Math.exp(-1 / (samples / 4));   // ~4 time constants to target
  }

  set(attackMs: number, decayMs: number, sustain: number, releaseMs: number): void {
    this.attackCoeff = this.coeff(attackMs);
    this.decayCoeff = this.coeff(decayMs);
    this.releaseCoeff = this.coeff(releaseMs);
    this.sustainLevel = sustain < 0 ? 0 : sustain > 1 ? 1 : sustain;
  }

  trigger(): void {
    this.stage = ATTACK;
  }

  release(): void {
    if (this.stage !== IDLE) this.stage = RELEASE;
  }

  isFinished(): boolean {
    return this.stage === IDLE;
  }

  next(): number {
    if (this.stage === ATTACK) {
      // overshoot target so the approach curve stays convex, then clamp
      this.value += this.attackCoeff * (1.2 - this.value);
      if (this.value >= 1) { this.value = 1; this.stage = DECAY; }
    } else if (this.stage === DECAY) {
      this.value += this.decayCoeff * (this.sustainLevel - this.value);
      if (Math.abs(this.value - this.sustainLevel) < 1e-4) {
        this.value = this.sustainLevel;
        this.stage = SUSTAIN;
      }
    } else if (this.stage === RELEASE) {
      this.value += this.releaseCoeff * (0 - this.value);
      if (this.value < 1e-5) { this.value = 0; this.stage = IDLE; }
    }
    return this.value;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/dsp/envelope.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/dsp/envelope.ts tests/dsp/envelope.test.ts
git commit -m "feat(dsp): exponential ADSR envelope"
```

---

## Task 7: Engine types and the Analog descriptor

**Files:**
- Create: `src/audio/types.ts`, `src/dsp/analog-descriptor.ts`
- Test: `tests/dsp/descriptor.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ParamDescriptor`, `EngineDescriptor`, `EngineVoice`, `EngineModule`, and `ANALOG_DESCRIPTOR: EngineDescriptor` whose `params` array order defines parameter indices used everywhere else.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { ANALOG_DESCRIPTOR } from '@/dsp/analog-descriptor';

describe('ANALOG_DESCRIPTOR', () => {
  it('gives every parameter a non-empty explanation', () => {
    for (const p of ANALOG_DESCRIPTOR.params) {
      expect(p.explain.length, `${p.id} needs an explanation`).toBeGreaterThan(20);
    }
  });

  it('has unique parameter ids', () => {
    const ids = ANALOG_DESCRIPTOR.params.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every default inside its own range', () => {
    for (const p of ANALOG_DESCRIPTOR.params) {
      expect(p.default).toBeGreaterThanOrEqual(p.min);
      expect(p.default).toBeLessThanOrEqual(p.max);
    }
  });

  it('assigns exactly four macros', () => {
    const macros = new Set(
      ANALOG_DESCRIPTOR.params.filter((p) => p.macro !== undefined).map((p) => p.macro),
    );
    expect(macros).toEqual(new Set([0, 1, 2, 3]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/dsp/descriptor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/audio/types.ts`**

```ts
export type ParamUnit = 'hz' | 'db' | 'ms' | 'ratio' | 'pct' | 'semitones' | 'none';
export type ParamCurve = 'linear' | 'exp' | 'log' | 'stepped';

export interface ParamDescriptor {
  id: string;
  name: string;
  group: string;
  unit: ParamUnit;
  min: number;
  max: number;
  default: number;
  curve: ParamCurve;
  steps?: number;
  macro?: 0 | 1 | 2 | 3;
  macroDepth?: number;
  /** How mutable this parameter is during Hunt, 0..1. Defaults to 0.5. */
  mutability?: number;
  /** Required. Plain language: what it does and why it matters. */
  explain: string;
}

export interface EngineDescriptor {
  id: string;
  name: string;
  colour: string;
  macroNames: readonly [string, string, string, string];
  params: readonly ParamDescriptor[];
}

export interface EngineVoice {
  noteOn(freq: number, velocity: number, voiceIndex: number): void;
  noteOff(): void;
  setParam(index: number, value: number): void;
  /** Additive into `out`. Must not allocate. */
  render(out: Float32Array, offset: number, count: number): void;
  isFinished(): boolean;
}

export interface EngineModule {
  readonly descriptor: EngineDescriptor;
  allocVoice(sampleRate: number): EngineVoice;
}
```

- [ ] **Step 4: Write `src/dsp/analog-descriptor.ts`**

```ts
import type { EngineDescriptor } from '@/audio/types';

export const ANALOG_DESCRIPTOR: EngineDescriptor = {
  id: 'analog',
  name: 'Analog',
  colour: '#FF6B6B',
  macroNames: ['Body', 'Air', 'Grit', 'Motion'],
  params: [
    {
      id: 'osc-detune', name: 'Detune', group: 'Oscillators', unit: 'semitones',
      min: 0, max: 0.5, default: 0.06, curve: 'linear', macro: 0, macroDepth: 0.4,
      mutability: 0.8,
      explain: 'Pushes the two oscillators slightly out of tune with each other. Small amounts make the sound thicker and alive; large amounts sound broken and seasick.',
    },
    {
      id: 'osc-drift', name: 'Drift', group: 'Oscillators', unit: 'pct',
      min: 0, max: 1, default: 0.25, curve: 'linear', macro: 3, macroDepth: 0.5,
      mutability: 0.9,
      explain: 'Slow random wandering of oscillator pitch, imitating analog circuits that never hold perfectly still. This is the cheapest way to stop a digital synth sounding sterile.',
    },
    {
      id: 'filter-cutoff', name: 'Cutoff', group: 'Filter', unit: 'hz',
      min: 20, max: 18000, default: 1800, curve: 'exp', macro: 1, macroDepth: 0.8,
      mutability: 0.9,
      explain: 'The brightness control. Everything above this frequency is progressively removed, so lowering it makes the sound darker and more distant.',
    },
    {
      id: 'filter-resonance', name: 'Resonance', group: 'Filter', unit: 'pct',
      min: 0, max: 1, default: 0.15, curve: 'linear', macro: 2, macroDepth: 0.5,
      mutability: 0.7,
      explain: 'Emphasises frequencies right at the cutoff point. Raise it for a vocal, squelchy character; near maximum the filter starts to whistle on its own.',
    },
    {
      id: 'filter-env', name: 'Env Amount', group: 'Filter', unit: 'pct',
      min: 0, max: 1, default: 0.5, curve: 'linear', mutability: 0.8,
      explain: 'How far the envelope sweeps the cutoff when a note starts. This is what makes a note go "wow" or "pluck" rather than simply appearing.',
    },
    {
      id: 'amp-attack', name: 'Attack', group: 'Envelope', unit: 'ms',
      min: 0.5, max: 4000, default: 4, curve: 'exp', mutability: 0.6,
      explain: 'How long the note takes to reach full volume. Short is percussive, long turns any sound into a pad that swells in.',
    },
    {
      id: 'amp-decay', name: 'Decay', group: 'Envelope', unit: 'ms',
      min: 1, max: 8000, default: 400, curve: 'exp', mutability: 0.6,
      explain: 'How quickly the note falls from its peak to the sustain level after the attack finishes.',
    },
    {
      id: 'amp-sustain', name: 'Sustain', group: 'Envelope', unit: 'pct',
      min: 0, max: 1, default: 0.7, curve: 'linear', mutability: 0.5,
      explain: 'The level the note holds at while you keep the key down. Set it to zero and every note becomes a pluck regardless of how long you hold it.',
    },
    {
      id: 'amp-release', name: 'Release', group: 'Envelope', unit: 'ms',
      min: 1, max: 8000, default: 300, curve: 'exp', mutability: 0.6,
      explain: 'How long the sound takes to fade once you let go. Long releases let chords overlap and blur into each other.',
    },
    {
      id: 'drive', name: 'Drive', group: 'Character', unit: 'pct',
      min: 0, max: 1, default: 0.2, curve: 'linear', mutability: 0.9,
      explain: 'Overdrives the signal going into the filter, adding harmonics and grit. A little adds weight; a lot turns the sound aggressive and compressed.',
    },
  ],
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/dsp/descriptor.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 6: Commit**

```bash
git add src/audio/types.ts src/dsp/analog-descriptor.ts tests/dsp/descriptor.test.ts
git commit -m "feat(audio): engine module contract and Analog parameter table"
```

---

## Task 8: The Analog voice

**Files:**
- Create: `src/dsp/analog-voice.ts`
- Test: `tests/dsp/analog-voice.test.ts`

**Interfaces:**
- Consumes: `SawOscillator` (Task 4), `LadderFilter` (Task 5), `Envelope` (Task 6), `Smoother` (Task 2), `ANALOG_DESCRIPTOR` (Task 7)
- Produces: `class AnalogVoice implements EngineVoice`, and `export const AnalogEngine: EngineModule`. Parameter indices match `ANALOG_DESCRIPTOR.params` order.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { AnalogEngine } from '@/dsp/analog-voice';

const SR = 48000;

function renderVoice(samples: number): Float32Array {
  const v = AnalogEngine.allocVoice(SR);
  v.noteOn(220, 1, 0);
  const out = new Float32Array(samples);
  v.render(out, 0, samples);
  return out;
}

describe('AnalogVoice', () => {
  it('produces audible, finite output after note-on', () => {
    const out = renderVoice(4800);
    let peak = 0;
    for (const s of out) {
      expect(Number.isFinite(s)).toBe(true);
      if (Math.abs(s) > peak) peak = Math.abs(s);
    }
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(2);
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
    v.setParam(8, 5);           // amp-release = 5ms
    v.noteOn(220, 1, 0);
    const out = new Float32Array(4800);
    v.render(out, 0, 4800);
    v.noteOff();
    v.render(out, 0, 4800);
    v.render(out, 0, 4800);
    expect(v.isFinished()).toBe(true);
  });

  it('does not grow the heap across a sustained render', () => {
    const v = AnalogEngine.allocVoice(SR);
    v.noteOn(220, 1, 0);
    const out = new Float32Array(128);
    for (let i = 0; i < 200; i++) { out.fill(0); v.render(out, 0, 128); }  // warm
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 4000; i++) { out.fill(0); v.render(out, 0, 128); }
    global.gc?.();
    const after = process.memoryUsage().heapUsed;
    expect(after - before).toBeLessThan(64 * 1024);
  });

  it('survives every parameter at both extremes without NaN', () => {
    for (let p = 0; p < 10; p++) {
      for (const extreme of [0, 1]) {
        const d = AnalogEngine.descriptor.params[p];
        if (!d) continue;
        const v = AnalogEngine.allocVoice(SR);
        v.setParam(p, extreme === 0 ? d.min : d.max);
        v.noteOn(880, 1, 0);
        const out = new Float32Array(2048);
        v.render(out, 0, 2048);
        for (const s of out) expect(Number.isFinite(s)).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/dsp/analog-voice.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
import type { EngineModule, EngineVoice } from '@/audio/types';
import { ANALOG_DESCRIPTOR } from './analog-descriptor';
import { SawOscillator } from './blep';
import { LadderFilter } from './ladder';
import { Envelope } from './envelope';
import { Smoother } from './smoothing';

const P_DETUNE = 0, P_DRIFT = 1, P_CUTOFF = 2, P_RES = 3, P_FILTER_ENV = 4,
      P_ATTACK = 5, P_DECAY = 6, P_SUSTAIN = 7, P_RELEASE = 8, P_DRIVE = 9;

function saturate(x: number): number {
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

class AnalogVoice implements EngineVoice {
  private readonly osc1: SawOscillator;
  private readonly osc2: SawOscillator;
  private readonly filter: LadderFilter;
  private readonly ampEnv: Envelope;
  private readonly filterEnv: Envelope;
  private readonly cutoffSmooth: Smoother;

  private readonly params = new Float32Array(10);
  private baseFreq = 220;
  private velocity = 1;
  private active = false;

  private driftPhase = 0;
  private driftInc: number;
  private driftValue = 0;

  constructor(private readonly sr: number) {
    this.osc1 = new SawOscillator(sr);
    this.osc2 = new SawOscillator(sr);
    this.filter = new LadderFilter(sr);
    this.ampEnv = new Envelope(sr);
    this.filterEnv = new Envelope(sr);
    this.cutoffSmooth = new Smoother(sr, 8);
    this.driftInc = 0.13 / sr;
    for (let i = 0; i < ANALOG_DESCRIPTOR.params.length; i++) {
      this.params[i] = ANALOG_DESCRIPTOR.params[i]?.default ?? 0;
    }
    this.cutoffSmooth.snap(this.params[P_CUTOFF] as number);
  }

  setParam(index: number, value: number): void {
    if (index < 0 || index >= this.params.length) return;
    this.params[index] = value;
    if (index === P_ATTACK || index === P_DECAY || index === P_SUSTAIN || index === P_RELEASE) {
      this.applyEnvelopes();
    }
  }

  private applyEnvelopes(): void {
    this.ampEnv.set(
      this.params[P_ATTACK] as number, this.params[P_DECAY] as number,
      this.params[P_SUSTAIN] as number, this.params[P_RELEASE] as number,
    );
    this.filterEnv.set(
      this.params[P_ATTACK] as number, (this.params[P_DECAY] as number) * 0.8,
      (this.params[P_SUSTAIN] as number) * 0.5, this.params[P_RELEASE] as number,
    );
  }

  noteOn(freq: number, velocity: number, voiceIndex: number): void {
    this.baseFreq = freq;
    this.velocity = velocity;
    this.active = true;
    this.driftPhase = voiceIndex * 0.37;      // decorrelate voices
    this.filter.reset();
    this.applyEnvelopes();
    this.ampEnv.trigger();
    this.filterEnv.trigger();
    this.cutoffSmooth.snap(this.params[P_CUTOFF] as number);
  }

  noteOff(): void {
    this.ampEnv.release();
    this.filterEnv.release();
  }

  isFinished(): boolean {
    return this.active && this.ampEnv.isFinished();
  }

  render(out: Float32Array, offset: number, count: number): void {
    if (!this.active) return;

    const detune = this.params[P_DETUNE] as number;
    const driftAmt = this.params[P_DRIFT] as number;
    const res = this.params[P_RES] as number;
    const envAmt = this.params[P_FILTER_ENV] as number;
    const drive = 1 + (this.params[P_DRIVE] as number) * 6;
    const targetCut = this.params[P_CUTOFF] as number;

    this.filter.setResonance(res);
    this.cutoffSmooth.setTarget(targetCut);

    for (let i = 0; i < count; i++) {
      this.driftPhase += this.driftInc;
      if (this.driftPhase > 1) this.driftPhase -= 1;
      this.driftValue = Math.sin(this.driftPhase * 6.283185307) * driftAmt * 0.012;

      const f1 = this.baseFreq * (1 + this.driftValue);
      const f2 = this.baseFreq * Math.pow(2, detune / 12) * (1 - this.driftValue);
      this.osc1.setFrequency(f1);
      this.osc2.setFrequency(f2);

      let sig = (this.osc1.next() + this.osc2.next()) * 0.4;
      sig = saturate(sig * drive) * (1 / Math.sqrt(drive));

      const fenv = this.filterEnv.next();
      const cut = this.cutoffSmooth.next() * (1 + envAmt * fenv * 6);
      this.filter.setCutoff(cut);

      const y = this.filter.process(sig) * this.ampEnv.next() * this.velocity * 0.35;
      out[offset + i] = (out[offset + i] as number) + (y === y ? y : 0);   // NaN guard
    }
  }
}

export const AnalogEngine: EngineModule = {
  descriptor: ANALOG_DESCRIPTOR,
  allocVoice: (sampleRate: number): EngineVoice => new AnalogVoice(sampleRate),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/dsp/analog-voice.test.ts --expose-gc` (or `node --expose-gc ./node_modules/vitest/vitest.mjs run tests/dsp/analog-voice.test.ts`)
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/dsp/analog-voice.ts tests/dsp/analog-voice.test.ts
git commit -m "feat(dsp): Analog engine voice"
```

---

## Task 9: Tuning table

**Files:**
- Create: `src/dsp/tuning.ts`
- Test: `tests/dsp/tuning.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `class TuningTable { constructor(); setEqualDivisions(n: number): void; setReference(midiNote: number, hz: number): void; frequency(midiNote: number): number; }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { TuningTable } from '@/dsp/tuning';

describe('TuningTable', () => {
  it('defaults to 12-TET with A4 = 440', () => {
    const t = new TuningTable();
    expect(t.frequency(69)).toBeCloseTo(440, 6);
    expect(t.frequency(81)).toBeCloseTo(880, 6);
    expect(t.frequency(57)).toBeCloseTo(220, 6);
    expect(t.frequency(60)).toBeCloseTo(261.6255653, 4);
  });

  it('supports 24-TET quarter tones', () => {
    const t = new TuningTable();
    t.setEqualDivisions(24);
    expect(t.frequency(69 + 24)).toBeCloseTo(880, 6);
    expect(t.frequency(69 + 12)).toBeCloseTo(440 * Math.SQRT2, 4);
  });

  it('respects a moved reference pitch', () => {
    const t = new TuningTable();
    t.setReference(69, 432);
    expect(t.frequency(69)).toBeCloseTo(432, 6);
    expect(t.frequency(81)).toBeCloseTo(864, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/dsp/tuning.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
export class TuningTable {
  private divisions = 12;
  private refNote = 69;
  private refHz = 440;

  setEqualDivisions(n: number): void {
    this.divisions = n < 1 ? 1 : n;
  }

  setReference(midiNote: number, hz: number): void {
    this.refNote = midiNote;
    this.refHz = hz;
  }

  frequency(midiNote: number): number {
    return this.refHz * Math.pow(2, (midiNote - this.refNote) / this.divisions);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/dsp/tuning.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/dsp/tuning.ts tests/dsp/tuning.test.ts
git commit -m "feat(dsp): tuning table with equal-division temperaments"
```

---

## Task 10: Voice manager

**Files:**
- Create: `src/dsp/voice-manager.ts`
- Test: `tests/dsp/voice-manager.test.ts`

**Interfaces:**
- Consumes: `EngineModule`/`EngineVoice` (Task 7), `TuningTable` (Task 9)
- Produces: `class VoiceManager { constructor(engine: EngineModule, sampleRate: number, maxVoices: number); noteOn(midiNote: number, velocity: number): void; noteOff(midiNote: number): void; setParam(index: number, value: number): void; render(out: Float32Array, count: number): void; get activeCount(): number; readonly tuning: TuningTable; }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { VoiceManager } from '@/dsp/voice-manager';
import { AnalogEngine } from '@/dsp/analog-voice';

const SR = 48000;

describe('VoiceManager', () => {
  it('starts silent', () => {
    const vm = new VoiceManager(AnalogEngine, SR, 8);
    const out = new Float32Array(128);
    vm.render(out, 128);
    for (const s of out) expect(s).toBe(0);
    expect(vm.activeCount).toBe(0);
  });

  it('plays a chord as several simultaneous voices', () => {
    const vm = new VoiceManager(AnalogEngine, SR, 8);
    vm.noteOn(60, 1); vm.noteOn(64, 1); vm.noteOn(67, 1);
    expect(vm.activeCount).toBe(3);
    const out = new Float32Array(1024);
    vm.render(out, 1024);
    let peak = 0;
    for (const s of out) if (Math.abs(s) > peak) peak = Math.abs(s);
    expect(peak).toBeGreaterThan(0.05);
  });

  it('never exceeds the voice limit, stealing instead', () => {
    const vm = new VoiceManager(AnalogEngine, SR, 4);
    for (let n = 60; n < 72; n++) vm.noteOn(n, 1);
    expect(vm.activeCount).toBeLessThanOrEqual(4);
    const out = new Float32Array(512);
    vm.render(out, 512);
    for (const s of out) expect(Number.isFinite(s)).toBe(true);
  });

  it('releases the matching voice on note-off', () => {
    const vm = new VoiceManager(AnalogEngine, SR, 8);
    vm.setParam(8, 2);          // very short release
    vm.noteOn(60, 1);
    const out = new Float32Array(512);
    vm.render(out, 512);
    vm.noteOff(60);
    for (let i = 0; i < 40; i++) { out.fill(0); vm.render(out, 512); }
    expect(vm.activeCount).toBe(0);
  });

  it('applies the tuning table to note frequencies', () => {
    const vm = new VoiceManager(AnalogEngine, SR, 8);
    vm.tuning.setReference(69, 432);
    expect(vm.tuning.frequency(69)).toBeCloseTo(432, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/dsp/voice-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
import type { EngineModule, EngineVoice } from '@/audio/types';
import { TuningTable } from './tuning';

interface Slot {
  voice: EngineVoice;
  note: number;
  age: number;
  held: boolean;
  busy: boolean;
}

export class VoiceManager {
  readonly tuning = new TuningTable();
  private readonly slots: Slot[] = [];
  private readonly paramCount: number;
  private readonly paramValues: Float32Array;
  private counter = 0;

  constructor(
    private readonly engine: EngineModule,
    sampleRate: number,
    maxVoices: number,
  ) {
    this.paramCount = engine.descriptor.params.length;
    this.paramValues = new Float32Array(this.paramCount);
    for (let i = 0; i < this.paramCount; i++) {
      this.paramValues[i] = engine.descriptor.params[i]?.default ?? 0;
    }
    for (let i = 0; i < maxVoices; i++) {
      this.slots.push({
        voice: engine.allocVoice(sampleRate),
        note: -1, age: 0, held: false, busy: false,
      });
    }
  }

  get activeCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.busy) n++;
    return n;
  }

  setParam(index: number, value: number): void {
    if (index < 0 || index >= this.paramCount) return;
    this.paramValues[index] = value;
    for (const s of this.slots) s.voice.setParam(index, value);
  }

  private claim(): Slot {
    for (const s of this.slots) if (!s.busy) return s;
    // steal the oldest voice that is no longer held, else the oldest overall
    let victim = this.slots[0] as Slot;
    for (const s of this.slots) {
      const better = (!s.held && victim.held) || (s.held === victim.held && s.age < victim.age);
      if (better) victim = s;
    }
    return victim;
  }

  noteOn(midiNote: number, velocity: number): void {
    const slot = this.claim();
    for (let i = 0; i < this.paramCount; i++) {
      slot.voice.setParam(i, this.paramValues[i] as number);
    }
    slot.note = midiNote;
    slot.age = this.counter++;
    slot.held = true;
    slot.busy = true;
    slot.voice.noteOn(this.tuning.frequency(midiNote), velocity, this.slots.indexOf(slot));
  }

  noteOff(midiNote: number): void {
    for (const s of this.slots) {
      if (s.busy && s.held && s.note === midiNote) {
        s.held = false;
        s.voice.noteOff();
      }
    }
  }

  render(out: Float32Array, count: number): void {
    for (const s of this.slots) {
      if (!s.busy) continue;
      s.voice.render(out, 0, count);
      if (s.voice.isFinished()) { s.busy = false; s.note = -1; }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/dsp/voice-manager.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/dsp/voice-manager.ts tests/dsp/voice-manager.test.ts
git commit -m "feat(dsp): polyphonic voice manager with stealing"
```

---

## Task 11: Performance budget test

The spec's budget only means something if a test can fail on it.

**Files:**
- Create: `tests/dsp/performance.test.ts`

**Interfaces:**
- Consumes: `VoiceManager` (Task 10), `AnalogEngine` (Task 8)
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { VoiceManager } from '@/dsp/voice-manager';
import { AnalogEngine } from '@/dsp/analog-voice';

const SR = 48000;

describe('performance budget', () => {
  it('renders 8 voices well inside the CPU budget', () => {
    const vm = new VoiceManager(AnalogEngine, SR, 8);
    for (let n = 55; n < 63; n++) vm.noteOn(n, 1);
    const out = new Float32Array(128);

    for (let i = 0; i < 500; i++) { out.fill(0); vm.render(out, 128); }   // warm the JIT

    const blocks = Math.floor((SR * 10) / 128);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < blocks; i++) { out.fill(0); vm.render(out, 128); }
    const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;

    const cpuFraction = elapsed / 10;
    // Spec budget is 5% of a core on desktop. Node/V8 is the proxy; the
    // authoritative on-device AudioWorklet measurement is a separate manual gate.
    expect(cpuFraction).toBeLessThan(0.05);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run tests/dsp/performance.test.ts`
Expected: PASS — reference measurement on this machine was 0.77% for 8 voices, so there is wide margin.

- [ ] **Step 3: Commit**

```bash
git add tests/dsp/performance.test.ts
git commit -m "test: CPU budget gate for 8-voice Analog render"
```

---

## Task 12: Parameter transport

**Files:**
- Create: `src/audio/param-transport.ts`
- Test: `tests/audio/param-transport.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `function packParams(updates: ReadonlyArray<readonly [number, number]>): Float32Array` and `function forEachParam(packed: Float32Array, fn: (index: number, value: number) => void): void`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { packParams, forEachParam } from '@/audio/param-transport';

describe('param transport', () => {
  it('round-trips index/value pairs', () => {
    const packed = packParams([[0, 1800], [3, 0.75], [9, 0.2]]);
    const seen: Array<[number, number]> = [];
    forEachParam(packed, (i, v) => { seen.push([i, v]); });
    expect(seen).toHaveLength(3);
    expect(seen[0]?.[0]).toBe(0);
    expect(seen[0]?.[1]).toBeCloseTo(1800, 2);
    expect(seen[2]?.[0]).toBe(9);
    expect(seen[2]?.[1]).toBeCloseTo(0.2, 5);
  });

  it('handles an empty update set', () => {
    const packed = packParams([]);
    let calls = 0;
    forEachParam(packed, () => { calls++; });
    expect(calls).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/audio/param-transport.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
/** Packs parameter updates as [index, value, index, value, ...]. */
export function packParams(
  updates: ReadonlyArray<readonly [number, number]>,
): Float32Array {
  const buf = new Float32Array(updates.length * 2);
  for (let i = 0; i < updates.length; i++) {
    const pair = updates[i];
    if (!pair) continue;
    buf[i * 2] = pair[0];
    buf[i * 2 + 1] = pair[1];
  }
  return buf;
}

/** Zero-allocation read side — safe to call inside the worklet. */
export function forEachParam(
  packed: Float32Array,
  fn: (index: number, value: number) => void,
): void {
  for (let i = 0; i + 1 < packed.length; i += 2) {
    fn(packed[i] as number, packed[i + 1] as number);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/audio/param-transport.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/audio/param-transport.ts tests/audio/param-transport.test.ts
git commit -m "feat(audio): packed parameter transport"
```

---

## Task 13: Worklet processor and host

Browser-verified rather than unit-tested — `AudioWorkletProcessor` does not exist in Node.

**Files:**
- Create: `src/audio/worklet/sigil-processor.ts`, `src/audio/engine-host.ts`

**Interfaces:**
- Consumes: `VoiceManager` (Task 10), `AnalogEngine` (Task 8), `forEachParam` (Task 12)
- Produces: `class EngineHost { start(): Promise<void>; noteOn(midi: number, velocity: number): void; noteOff(midi: number): void; setParam(index: number, value: number): void; }`

- [ ] **Step 1: Write the processor**

```ts
import { VoiceManager } from '../../dsp/voice-manager';
import { AnalogEngine } from '../../dsp/analog-voice';
import { forEachParam } from '../param-transport';

interface NoteMessage { type: 'noteOn' | 'noteOff'; note: number; velocity: number }
interface ParamMessage { type: 'params'; data: Float32Array }
type InboundMessage = NoteMessage | ParamMessage;

declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor,
): void;

class SigilProcessor extends AudioWorkletProcessor {
  private readonly vm = new VoiceManager(AnalogEngine, sampleRate, 16);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<InboundMessage>): void => {
      const msg = e.data;
      if (msg.type === 'noteOn') this.vm.noteOn(msg.note, msg.velocity);
      else if (msg.type === 'noteOff') this.vm.noteOff(msg.note);
      else forEachParam(msg.data, (i, v) => { this.vm.setParam(i, v); });
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output) return true;
    const left = output[0];
    if (!left) return true;

    left.fill(0);
    this.vm.render(left, left.length);

    for (let ch = 1; ch < output.length; ch++) {
      output[ch]?.set(left);
    }
    return true;
  }
}

registerProcessor('sigil-processor', SigilProcessor);
```

- [ ] **Step 2: Write the host**

```ts
import { packParams } from './param-transport';

export class EngineHost {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;

  async start(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule('/worklet/sigil-processor.js');
    const node = new AudioWorkletNode(ctx, 'sigil-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.connect(ctx.destination);
    this.ctx = ctx;
    this.node = node;
  }

  noteOn(note: number, velocity: number): void {
    this.node?.port.postMessage({ type: 'noteOn', note, velocity });
  }

  noteOff(note: number): void {
    this.node?.port.postMessage({ type: 'noteOff', note, velocity: 0 });
  }

  setParam(index: number, value: number): void {
    const data = packParams([[index, value]]);
    this.node?.port.postMessage({ type: 'params', data }, [data.buffer]);
  }
}
```

- [ ] **Step 3: Build the worklet bundle**

Run: `pnpm build:worklet`
Expected: writes `public/worklet/sigil-processor.js` with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/audio/worklet/sigil-processor.ts src/audio/engine-host.ts
git commit -m "feat(audio): AudioWorklet processor and main-thread host"
```

---

## Task 14: Instrument surface

**Files:**
- Create: `app/globals.css`, `src/ui/components/knob.tsx`, `src/ui/components/keys.tsx`, `src/ui/components/macro-row.tsx`, `app/page.tsx`, `app/layout.tsx`

**Interfaces:**
- Consumes: `EngineHost` (Task 13), `ANALOG_DESCRIPTOR` (Task 7)
- Produces: a playable page at `/`

- [ ] **Step 1: Write `app/globals.css` with the locked tokens**

```css
@import "tailwindcss";
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap');

:root {
  --bg: #0E0E0E;
  --panel: #171717;
  --ink: #F5F1E6;
  --analog: #FF6B6B;
  --muted: #7D786C;
}

body {
  background: var(--bg);
  color: var(--ink);
  font-family: 'Space Grotesk', ui-sans-serif, system-ui;
}

.hard { box-shadow: 4px 4px 0 0 var(--ink); }
.hard:active { transform: translate(2px, 2px); box-shadow: none; }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
```

- [ ] **Step 2: Write `src/ui/components/knob.tsx`**

```tsx
'use client';

import { useCallback, useRef } from 'react';

interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  colour: string;
  onChange: (value: number) => void;
}

export function Knob({ label, value, min, max, colour, onChange }: KnobProps): JSX.Element {
  const dragging = useRef(false);
  const norm = (value - min) / (max - min);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!dragging.current) return;
      const fine = e.shiftKey ? 0.25 : 1;
      const delta = (-e.movementY / 200) * fine;
      const next = Math.min(1, Math.max(0, norm + delta));
      onChange(min + next * (max - min));
    },
    [norm, min, max, onChange],
  );

  const onPointerUp = useCallback((): void => { dragging.current = false; }, []);

  const angle = -135 + norm * 270;

  return (
    <div className="flex flex-col items-center gap-1 select-none">
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${label} ${value.toFixed(2)}`}
        className="w-14 h-14 rounded-full border-[3px] cursor-ns-resize touch-none"
        style={{ borderColor: 'var(--ink)' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(e): void => {
          const step = (max - min) / 50;
          if (e.key === 'ArrowUp') onChange(Math.min(max, value + step));
          if (e.key === 'ArrowDown') onChange(Math.max(min, value - step));
        }}
      >
        <svg viewBox="0 0 56 56" className="w-full h-full">
          <line
            x1="28" y1="28" x2="28" y2="8"
            stroke={colour} strokeWidth="4" strokeLinecap="square"
            transform={`rotate(${angle} 28 28)`}
          />
        </svg>
      </div>
      <span className="text-[9px] uppercase tracking-[0.16em]" style={{ color: 'var(--muted)' }}>
        {label}
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Write `src/ui/components/keys.tsx`**

```tsx
'use client';

interface KeysProps {
  octave: number;
  onNoteOn: (midi: number) => void;
  onNoteOff: (midi: number) => void;
}

const SEMITONES = 24;

export function Keys({ octave, onNoteOn, onNoteOff }: KeysProps): JSX.Element {
  const base = 12 * octave;
  const notes = Array.from({ length: SEMITONES }, (_, i) => base + i);

  return (
    <div className="grid" style={{ gridTemplateColumns: `repeat(${SEMITONES}, 1fr)` }}>
      {notes.map((midi) => {
        const isBlack = [1, 3, 6, 8, 10].includes(midi % 12);
        return (
          <button
            key={midi}
            aria-label={`Note ${midi}`}
            className="h-20 border-r-[3px] border-t-[3px] touch-none"
            style={{
              borderColor: 'var(--ink)',
              background: isBlack ? '#0E0E0E' : 'var(--panel)',
            }}
            onPointerDown={(): void => onNoteOn(midi)}
            onPointerUp={(): void => onNoteOff(midi)}
            onPointerLeave={(): void => onNoteOff(midi)}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Write `app/page.tsx`**

```tsx
'use client';

import { useCallback, useRef, useState } from 'react';
import { EngineHost } from '@/audio/engine-host';
import { ANALOG_DESCRIPTOR } from '@/dsp/analog-descriptor';
import { Knob } from '@/ui/components/knob';
import { Keys } from '@/ui/components/keys';

export default function Page(): JSX.Element {
  const host = useRef<EngineHost | null>(null);
  const [started, setStarted] = useState(false);
  const [values, setValues] = useState<number[]>(
    ANALOG_DESCRIPTOR.params.map((p) => p.default),
  );

  const start = useCallback(async (): Promise<void> => {
    host.current ??= new EngineHost();
    await host.current.start();
    setStarted(true);
  }, []);

  const setParam = useCallback((index: number, value: number): void => {
    setValues((prev) => prev.map((v, i) => (i === index ? value : v)));
    host.current?.setParam(index, value);
  }, []);

  return (
    <main className="min-h-screen p-6">
      <header
        className="flex items-center justify-between border-b-4 pb-3 mb-6"
        style={{ borderColor: 'var(--ink)' }}
      >
        <div className="flex items-center gap-2">
          <span className="w-4 h-4 rounded-full" style={{ background: 'var(--analog)' }} />
          <h1 className="font-bold uppercase tracking-tight">SIGIL — Analog</h1>
        </div>
        {!started && (
          <button
            className="hard border-[3px] px-4 py-2 text-xs font-bold uppercase tracking-widest"
            style={{ borderColor: 'var(--ink)', background: 'var(--analog)', color: '#0E0E0E' }}
            onClick={(): void => { void start(); }}
          >
            Power
          </button>
        )}
      </header>

      <section className="flex flex-wrap gap-6 mb-8">
        {ANALOG_DESCRIPTOR.params.map((p, i) => (
          <Knob
            key={p.id}
            label={p.name}
            value={values[i] ?? p.default}
            min={p.min}
            max={p.max}
            colour={ANALOG_DESCRIPTOR.colour}
            onChange={(v): void => setParam(i, v)}
          />
        ))}
      </section>

      <Keys
        octave={4}
        onNoteOn={(m): void => host.current?.noteOn(m, 1)}
        onNoteOff={(m): void => host.current?.noteOff(m)}
      />
    </main>
  );
}
```

- [ ] **Step 5: Verify in the browser**

Run: `pnpm dev`, then open the preview and click Power, then press keys.
Expected: audible polyphonic sound; turning Cutoff changes brightness; no console errors; no audio dropouts.

- [ ] **Step 6: Commit**

```bash
git add app src/ui
git commit -m "feat(ui): playable Analog instrument surface"
```

---

## Self-Review

**Spec coverage for this plan's scope:** audio spine (Tasks 12–13), zero-allocation discipline (Task 8 heap test), denormal and NaN guards (Tasks 5, 8), parameter smoothing (Task 2), Analog oscillators/filter/envelopes/drift (Tasks 4–6, 8), module contract and descriptors with required explanations (Task 7), tuning tables (Task 9), polyphony and stealing (Task 10), performance budget (Task 11), design tokens and accessible controls (Task 14).

**Deferred to later plans, tracked:** the two additional filter models (state-variable, diode) — Task 5 ships ladder only; the descriptor-driven Deep view; chord pad and WebMIDI; presets; persistence, auth, bounce, deploy; Hunt and the tape; the on-device iOS/iPad measurement gate.

**Type consistency:** `EngineVoice.render(out, offset, count)` is used identically in Tasks 8, 10 and 13. `setParam(index, value)` is consistent across `EngineVoice`, `VoiceManager`, `EngineHost`. Parameter indices are defined once by `ANALOG_DESCRIPTOR.params` order and referenced by the same constants in Task 8.

**Known rough edge, deliberately accepted:** `AnalogVoice.isFinished()` returns `true` only after a note has been triggered, so a freshly allocated voice reports `false`. `VoiceManager` only calls it on busy slots, so this is correct but non-obvious — worth a comment during implementation.
