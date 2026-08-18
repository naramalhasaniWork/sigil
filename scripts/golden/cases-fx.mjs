/** Goldens for fx-core.ts, fx-reverb.ts, fx.ts, fx-magic-units.ts, fx-magic.ts. */
import { emit, noise, impulse, ramp, burst, blockSizes, IRREGULAR_BLOCKS, SR } from './harness.mjs';

export function fxCoreCases(D) {
  const { sat, limitOut, lfo, onePole, flush, Line } = D;

  // Memoryless shapers, swept over their whole meaningful domain including
  // well past the clamps. Pure arithmetic -> must be bit-exact.
  {
    const input = ramp(4096, -6, 6);
    for (const [name, fn] of [['sat', sat], ['limitOut', limitOut], ['flush', flush]]) {
      const out = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) out[i] = fn(input[i]);
      emit({
        id: `fxcore_${name}_ramp`, module: 'fx-core.ts', tol: 'exact',
        output: out, input, params: { domain: [-6, 6], points: 4096 },
      });
    }
  }
  {
    const input = ramp(2048, 0, 1);
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = lfo(input[i]);
    emit({
      id: 'fxcore_lfo_parabolic', module: 'fx-core.ts', tol: 'exact',
      output: out, input, params: { domain: [0, 1], points: 2048 },
      notes: 'The parabolic sine over phase 0..1 used by the chorus and reverb.',
    });
  }
  // onePole is the only exp() in fx-core; goldened as a coefficient table so a
  // wrong clamp or a wrong 2*PI shows up on its own rather than inside a filter.
  {
    const hz = [];
    for (let i = 0; i < 512; i++) hz.push(1 * Math.pow(24000, i / 511));
    const out = new Float32Array(hz.length);
    for (let i = 0; i < hz.length; i++) out[i] = onePole(hz[i], SR);
    emit({
      id: 'fxcore_onepole_table', module: 'fx-core.ts', tol: 'coeff',
      output: out, input: Float32Array.from(hz),
      params: { sampleRate: SR, hzFrom: 'stored input file' },
      notes: 'Input file holds the exact Hz values (f32). Clamped to [1e-4, 0.999].',
    });
  }
  // Line: fractional reads, including both clamps (d<1 and d>mask-2).
  {
    const N = 4096;
    const line = new Line(1024);
    const input = noise(N, 0x11e0);
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      line.write(input[i]);
      const d = 0.25 + (i % 1500) * 0.9;
      out[i] = line.read(d);
    }
    emit({
      id: 'fxcore_line_fractional', module: 'fx-core.ts', tol: 'exact',
      output: out, input, params: { maxSamples: 1024, delayFormula: '0.25 + (i % 1500) * 0.9' },
      notes: 'write() then read() each sample. Sweeps through both read clamps. '
        + 'Line stores Float32Array internally, so the port must too.',
    });
  }
}

export function reverbCases(D) {
  const { Reverb } = D;
  const { P } = D;
  const N = 32768;
  const settings = [
    ['default', { predelayMs: 18, size: 0.55, decayMs: 2200, damping: 0.5, mix: 1 }],
    ['small', { predelayMs: 0, size: 0.15, decayMs: 200, damping: 0, mix: 1 }],
    ['hall', { predelayMs: 200, size: 1, decayMs: 12000, damping: 1, mix: 1 }],
  ];
  for (const [tag, s] of settings) {
    // The parameter vector is in DSP units, exactly as FxChain hands it over.
    const p = makeReverbParams(D, s);
    const input = impulse(N, 0, 1);
    // Mono
    {
      const rv = new Reverb(SR, s.size, s.decayMs);
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) out[i] = rv.process(input[i], p);
      emit({
        id: `reverb_mono_${tag}`, module: 'fx-reverb.ts', tol: 'coeff',
        output: out, input, params: { ...s, dspParams: Array.from(p) },
        notes: 'new Reverb(48000, size, decayMs) then process(x, p) per sample. '
          + 'p is the 19-entry FX parameter vector in DSP units, given in full '
          + 'in `dspParams` (index order = P_* in fx-core.ts).',
      });
    }
    // Stereo, fed a decorrelated pair so the diff vector is genuinely exercised.
    {
      const rv = new Reverb(SR, s.size, s.decayMs);
      const inL = burst(N, 512, 0x5e0a);
      const inR = burst(N, 512, 0x5e0b);
      const oL = new Float32Array(N), oR = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        rv.processStereo(inL[i], inR[i], p);
        oL[i] = rv.oL; oR[i] = rv.oR;
      }
      emit({
        id: `reverb_stereo_${tag}`, module: 'fx-reverb.ts', tol: 'coeff',
        output: [oL, oR], input: [inL, inR], params: { ...s, dspParams: Array.from(p) },
        notes: 'Interleaved L,R. processStereo writes oL/oR fields; read them after each call.',
      });
    }
  }
}

function makeReverbParams(D, s) {
  const { P_RV_PREDELAY, P_RV_SIZE, P_RV_DECAY, P_RV_DAMP, P_RV_MIX, N_PARAMS } = D;
  const p = new Float32Array(N_PARAMS);
  p[P_RV_PREDELAY] = (s.predelayMs * SR) / 1000;
  p[P_RV_SIZE] = s.size;
  p[P_RV_DECAY] = s.decayMs;
  p[P_RV_DAMP] = 1 - 0.985 * s.damping * s.damping;
  p[P_RV_MIX] = s.mix;
  return p;
}

export function fxChainCases(D) {
  const { FxChain, FX_DESCRIPTOR } = D;
  const params = FX_DESCRIPTOR.params;
  const N = 24000;

  const presets = {
    default: {},
    all_on: {
      'drive-amount': 0.6, 'drive-tone': 0.8, 'crush-rate': 0.5, 'crush-bits': 6,
      'chorus-mix': 0.7, 'delay-mix': 0.5, 'delay-time': 120, 'reverb-mix': 0.6,
      'output-trim': -3,
    },
    max: Object.fromEntries(params.map((p) => [p.id, p.max])),
    min: Object.fromEntries(params.map((p) => [p.id, p.min])),
  };

  for (const [tag, over] of Object.entries(presets)) {
    for (const mode of ['mono', 'stereo']) {
      const fx = new FxChain(SR);
      for (let i = 0; i < params.length; i++) fx.setParam(i, params[i].default);
      for (const [id, v] of Object.entries(over)) {
        fx.setParam(params.findIndex((p) => p.id === id), v);
      }
      fx.reset();
      const inL = burst(N, 4000, 0xfc0a);
      const inR = burst(N, 4000, 0xfc0b);
      const bufL = Float32Array.from(inL), bufR = Float32Array.from(inR);
      const blocks = blockSizes(N, IRREGULAR_BLOCKS);
      let off = 0;
      for (const b of blocks) {
        if (mode === 'mono') fx.process(bufL.subarray(off, off + b), b);
        else fx.processStereo(bufL.subarray(off, off + b), bufR.subarray(off, off + b), b);
        off += b;
      }
      emit({
        id: `fxchain_${tag}_${mode}`, module: 'fx.ts', tol: 'chain',
        output: mode === 'mono' ? bufL : [bufL, bufR],
        input: mode === 'mono' ? inL : [inL, inR],
        params: { overrides: over, blockSizes: blocks, mode },
        notes: 'Order: construct, setParam(all defaults), setParam(overrides), reset(), '
          + 'then process the blocks in `blockSizes` back to back over ONE buffer. '
          + 'NOTE: FxChain.process advances every Smoother once in gate() AND once '
          + 'per sample, so smoothers step count+1 times per block. That is the '
          + 'reference behaviour and the port must reproduce it, block sizes included.',
      });
    }
  }
}

export function magicUnitCases(D) {
  const { Freezer, Shimmer, VowelFilter, Stutter, PitchShifter, FreqShifter, Tape,
    Diffuser, DelayLine, Allpass2, HilbertPair, softLimit, saturate } = D;
  const N = 16384;

  {
    const input = ramp(4096, -3, 3);
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = softLimit(input[i], 0.9, 0.6);
    emit({ id: 'magic_softlimit_ramp', module: 'fx-magic-descriptor.ts', tol: 'exact',
      output: out, input, params: { knee: 0.9, span: 0.6 } });
  }
  {
    const input = ramp(4096, -6, 6);
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = saturate(input[i]);
    emit({ id: 'magic_saturate_ramp', module: 'fx-magic-descriptor.ts', tol: 'exact',
      output: out, input, params: { domain: [-6, 6] },
      notes: 'NOT the same as fx-core sat(): this one does not clamp its input first.' });
  }
  {
    const input = noise(N, 0xda11);
    const out = new Float32Array(N);
    const dl = new DelayLine(2048);
    for (let i = 0; i < N; i++) {
      dl.write(input[i]);
      out[i] = dl.read(3.5 + (i % 900) * 1.7);
    }
    emit({ id: 'magic_delayline_fractional', module: 'fx-magic-descriptor.ts', tol: 'exact',
      output: out, input, params: { maxSamples: 2048, delayFormula: '3.5 + (i % 900) * 1.7' },
      notes: 'DelayLine.read uses Math.floor on a possibly negative position; '
        + 'floor, not truncation. That distinction is a real porting trap.' });
  }
  {
    const input = noise(N, 0x0a11ba);
    const out = new Float32Array(N);
    const ap = new Allpass2(0.6923877778065);
    for (let i = 0; i < N; i++) out[i] = ap.process(input[i]);
    emit({ id: 'magic_allpass2', module: 'fx-magic-descriptor.ts', tol: 'exact',
      output: out, input, params: { coeff: 0.6923877778065 } });
  }
  {
    const input = noise(N, 0xd1ff);
    const out = new Float32Array(N);
    const df = new Diffuser(SR * 0.00723, 0.62);
    for (let i = 0; i < N; i++) out[i] = df.process(input[i]);
    emit({ id: 'magic_diffuser', module: 'fx-magic-descriptor.ts', tol: 'exact',
      output: out, input, params: { lengthSamples: SR * 0.00723, g: 0.62 },
      notes: 'Length is rounded to Math.max(2, Math.round(347.04)) = 347.' });
  }
  {
    const input = noise(N, 0x81be);
    const oI = new Float32Array(N), oQ = new Float32Array(N);
    const h = new HilbertPair();
    for (let i = 0; i < N; i++) { h.process(input[i]); oI[i] = h.i; oQ[i] = h.q; }
    emit({ id: 'magic_hilbert', module: 'fx-magic-descriptor.ts', tol: 'exact',
      output: [oI, oQ], input, params: {},
      notes: 'Interleaved i,q. i lags q by one sample by construction.' });
  }
  {
    const input = noise(N, 0x9175);
    for (const ratio of [0.5, 1, 2]) {
      const ps = new PitchShifter(SR, 60);
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) out[i] = ps.process(input[i], ratio);
      emit({ id: `magic_pitchshifter_r${String(ratio).replace('.', 'p')}`,
        module: 'fx-magic-descriptor.ts', tol: 'trans', output: out, input,
        params: { windowMs: 60, ratio, windowSamples: Math.round((60 / 1000) * SR) } });
    }
  }
  {
    const input = noise(N, 0x5417);
    for (const [tag, hz, ring] of [['up200', 200, 0], ['down350', -350, 0], ['ring', 120, 0.8]]) {
      const fs = new FreqShifter(SR);
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) out[i] = fs.process(input[i], hz, ring);
      emit({ id: `magic_freqshifter_${tag}`, module: 'fx-magic-descriptor.ts', tol: 'trans',
        output: out, input, params: { hz, ring } });
    }
  }
  {
    const input = noise(N, 0x7a9e);
    for (const [tag, wear, wow, flutter] of [['clean', 0, 0, 0], ['worn', 0.8, 0.6, 0.7],
      ['max', 1, 1, 1]]) {
      const t = new Tape(SR);
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) out[i] = t.process(input[i], wear, wow, flutter);
      emit({ id: `magic_tape_${tag}`, module: 'fx-magic-descriptor.ts', tol: 'trans',
        output: out, input, params: { wear, wow, flutter } });
    }
  }
  // Freezer: capture then loop. The raised-cosine splice is the interesting part.
  {
    const input = noise(N, 0xf2ee);
    const fz = new Freezer(SR);
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (i === 8000) fz.capture(0.1 * SR);
      if (i === 14000) fz.release();
      out[i] = fz.process(input[i]);
    }
    emit({ id: 'magic_freezer', module: 'fx-magic-units.ts', tol: 'trans',
      output: out, input,
      params: { captureAtSample: 8000, captureLenSamples: 0.1 * SR, releaseAtSample: 14000 },
      notes: 'capture()/release() are called BEFORE process() on that sample index.' });
  }
  // Shimmer: pitch-shifted feedback tank.
  {
    const input = burst(N, 2000, 0x5417e);
    for (const [tag, delayMs, fb, semis, damp] of [['octave', 180, 0.51, 12, 0.4],
      ['fifth_hot', 300, 0.85, 7, 0.1]]) {
      const sh = new Shimmer(SR);
      const out = new Float32Array(N);
      const d = (delayMs / 1000) * SR, ratio = 2 ** (semis / 12);
      for (let i = 0; i < N; i++) out[i] = sh.process(input[i], d, fb, ratio, damp);
      emit({ id: `magic_shimmer_${tag}`, module: 'fx-magic-units.ts', tol: 'trans',
        output: out, input,
        params: { delaySamples: d, feedback: fb, semitones: semis, ratio, damping: damp } });
    }
  }
  // Vowel filter: three SVF bandpasses, coefficients recomputed only on movement.
  {
    const input = noise(N, 0x0e0e);
    for (const [tag, pos, sharp] of [['a', 0, 0.6], ['mid', 0.5, 0.9], ['u', 1, 0.2]]) {
      const vf = new VowelFilter(SR);
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) out[i] = vf.process(input[i], pos, sharp);
      emit({ id: `magic_vowel_${tag}`, module: 'fx-magic-units.ts', tol: 'coeff',
        output: out, input, params: { pos, sharp },
        notes: 'Coefficients are recomputed only when |pos| moves > 0.002 or '
          + '|sharp| moves > 0.005; here that means once, on the first sample.' });
    }
    // Moving morph: forces repeated coefficient updates mid-stream.
    const vf = new VowelFilter(SR);
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = vf.process(input[i], i / N, 0.5 + 0.4 * (i / N));
    emit({ id: 'magic_vowel_sweep', module: 'fx-magic-units.ts', tol: 'coeff',
      output: out, input, params: { posFormula: 'i / N', sharpFormula: '0.5 + 0.4 * (i / N)', N } });
  }
  // Stutter: mulberry32 latching. Pure integer PRNG -> must be bit-exact.
  {
    const input = noise(N, 0x57);
    for (const [tag, seed, chance, sliceMs, semis] of [['seed1337', 1337, 0.35, 120, 0],
      ['always_down', 42, 1, 60, -5]]) {
      const st = new Stutter(SR);
      st.setSeed(seed);
      const out = new Float32Array(N);
      const slice = (sliceMs / 1000) * SR, ratio = 2 ** (semis / 12);
      for (let i = 0; i < N; i++) out[i] = st.process(input[i], slice, chance, ratio);
      emit({ id: `magic_stutter_${tag}`, module: 'fx-magic-units.ts', tol: 'trans',
        output: out, input,
        params: { seed, chance, sliceSamples: slice, semitones: semis, ratio },
        notes: 'setSeed() before the first process(). mulberry32 uses Math.imul and '
          + '>>> 0; port with uint32_t and 32x32->32 multiply.' });
    }
  }
}

export function magicChainCases(D) {
  const { MagicChain, FX_MAGIC_DESCRIPTOR, MAGIC_PARAM } = D;
  const params = FX_MAGIC_DESCRIPTOR.params;
  const N = 24000;

  const presets = {
    default: {},
    all_on: {
      'vowel-mix': 0.8, 'vowel-pos': 0.4, 'shift-mix': 0.5, 'shift-hz': 175,
      'stutter-mix': 0.6, 'shimmer-mix': 0.7, 'freeze-mix': 0.4,
      'tape-wear': 0.5, 'tape-wow': 0.4, 'tape-flutter': 0.3,
    },
    max: Object.fromEntries(params.map((p) => [p.id, p.max])),
  };

  for (const [tag, over] of Object.entries(presets)) {
    for (const mode of ['mono', 'stereo']) {
      const mc = new MagicChain(SR);
      for (const [id, v] of Object.entries(over)) {
        mc.setParam(params.findIndex((p) => p.id === id), v);
      }
      const inL = burst(N, 6000, 0x9a10);
      const inR = burst(N, 6000, 0x9a11);
      const bufL = Float32Array.from(inL), bufR = Float32Array.from(inR);
      const blocks = blockSizes(N, IRREGULAR_BLOCKS);
      let off = 0, done = 0;
      for (const b of blocks) {
        // Capture is a latch on P.freezeCapture; toggle it partway through.
        if (done <= 9000 && done + b > 9000) mc.setParam(MAGIC_PARAM.freezeCapture, 1);
        if (mode === 'mono') mc.process(bufL.subarray(off, off + b), b);
        else mc.processStereo(bufL.subarray(off, off + b), bufR.subarray(off, off + b), b);
        off += b; done += b;
      }
      emit({
        id: `magicchain_${tag}_${mode}`, module: 'fx-magic.ts', tol: 'chain',
        output: mode === 'mono' ? bufL : [bufL, bufR],
        input: mode === 'mono' ? inL : [inL, inR],
        params: { overrides: over, blockSizes: blocks, mode,
          freezeCaptureBeforeBlockContaining: 9000 },
        notes: 'Constructed with descriptor defaults already snapped (the class does '
          + 'that itself); only the overrides are setParam-ed, so their smoothers '
          + 'RAMP rather than snap. freeze-capture is latched to 1 before the block '
          + 'that contains sample 9000.',
      });
    }
  }
}
