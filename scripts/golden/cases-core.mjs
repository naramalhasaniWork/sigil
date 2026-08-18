/** Goldens for smoothing.ts, blep.ts, ladder.ts, filters.ts, envelope.ts, lfo.ts. */
import { emit, noise, impulse, step, ramp, burst, SR } from './harness.mjs';

export function smoothingCases(D) {
  const { Smoother } = D;

  // Step response from 0 to 1. The coefficient is 1 - exp(-1/(t*sr)); this is
  // the whole module.
  for (const ms of [1, 20, 500]) {
    const s = new Smoother(SR, ms);
    s.snap(0); s.setTarget(1);
    const out = new Float32Array(8192);
    for (let i = 0; i < out.length; i++) out[i] = s.next();
    emit({
      id: `smoothing_step_${ms}ms`, module: 'smoothing.ts', tol: 'coeff', output: out,
      params: { sampleRate: SR, timeMs: ms, snap: 0, target: 1 },
      notes: 'snap(0); setTarget(1); then next() x N.',
    });
  }

  // Target changes mid-run: catches a smoother that only reads its target once.
  {
    const s = new Smoother(SR, 25);
    s.snap(0);
    const out = new Float32Array(6000);
    for (let i = 0; i < out.length; i++) {
      if (i === 0) s.setTarget(1);
      else if (i === 2000) s.setTarget(-0.5);
      else if (i === 4000) s.setTarget(0);
      out[i] = s.next();
    }
    emit({
      id: 'smoothing_retarget', module: 'smoothing.ts', tol: 'coeff', output: out,
      params: { timeMs: 25, targets: { 0: 1, 2000: -0.5, 4000: 0 } },
    });
  }

  // The denormal flush is load-bearing: below 1e-20 the smoother must snap to
  // an exact zero, not decay forever. A port that omits it drifts here.
  {
    const s = new Smoother(SR, 0.05);
    s.snap(1e-18); s.setTarget(0);
    const out = new Float32Array(2048);
    for (let i = 0; i < out.length; i++) out[i] = s.next();
    emit({
      id: 'smoothing_denormal_flush', module: 'smoothing.ts', tol: 'coeff', output: out,
      params: { timeMs: 0.05, snap: 1e-18, target: 0 },
      notes: 'Values are ~1e-18 and the tail must be EXACTLY 0 once flushed. '
        + 'Stored as f32 so sub-1e-38 values land on zero either way; the point '
        + 'of the case is the index at which it reaches zero.',
    });
  }
}

export function blepCases(D) {
  const { blep, SawOscillator } = D;

  // blep(t, dt) over a grid that covers both discontinuity branches and the
  // no-op middle. Pure arithmetic: bit-exact or the port is wrong.
  {
    const dts = [0.001, 0.01, 0.05, 0.1, 0.25, 0.4];
    const steps = 512;
    const out = new Float32Array(dts.length * steps);
    let k = 0;
    for (const dt of dts) {
      for (let i = 0; i < steps; i++) out[k++] = blep(i / steps, dt);
    }
    emit({
      id: 'blep_residual_grid', module: 'blep.ts', tol: 'exact', output: out,
      params: { dts, tPerDt: steps, t: 'i / 512' },
      notes: 'Row-major over dts; t = i/512 for i in [0,512).',
    });
  }

  for (const hz of [27.5, 110, 1000, 5000, 11000]) {
    const o = new SawOscillator(SR);
    o.setFrequency(hz);
    const out = new Float32Array(8192);
    for (let i = 0; i < out.length; i++) out[i] = o.next();
    emit({
      id: `blep_saw_${String(hz).replace('.', 'p')}hz`, module: 'blep.ts', tol: 'exact',
      output: out, params: { sampleRate: SR, hz },
      notes: 'new SawOscillator(48000); setFrequency(hz); next() x N. phase starts at 0.',
    });
  }
}

export function ladderCases(D) {
  const { LadderFilter } = D;
  const N = 8192;
  const settings = [
    ['c1000_r0', 1000, 0], ['c1000_r0p7', 1000, 0.7], ['c200_r0p95', 200, 0.95],
    ['c8000_r0p5', 8000, 0.5], ['c5_r0', 5, 0], ['c40000_r1', 40000, 1],
  ];
  for (const [tag, hz, r] of settings) {
    const f = new LadderFilter(SR);
    f.setCutoff(hz); f.setResonance(r);
    const input = noise(N, 0x51ade1);
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = f.process(input[i]);
    emit({
      id: `ladder_noise_${tag}`, module: 'ladder.ts', tol: 'coeff', output: out, input,
      params: { cutoffHz: hz, resonance: r },
      notes: 'cutoff 5 and 40000 probe the clamps (10 .. sr*0.45).',
    });
  }
  // Impulse into a hot filter: the ring is where a wrong feedback term shows.
  {
    const f = new LadderFilter(SR);
    f.setCutoff(400); f.setResonance(0.95);
    const input = impulse(N, 0, 1);
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = f.process(input[i]);
    emit({
      id: 'ladder_impulse_c400_r0p95', module: 'ladder.ts', tol: 'coeff',
      output: out, input, params: { cutoffHz: 400, resonance: 0.95 },
    });
  }
  // Drive it hard so the rational-tanh feedback saturator is genuinely engaged.
  {
    const f = new LadderFilter(SR);
    f.setCutoff(1200); f.setResonance(0.85);
    const input = new Float32Array(N);
    const n = noise(N, 0x7777);
    for (let i = 0; i < N; i++) input[i] = n[i] * 6;
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = f.process(input[i]);
    emit({
      id: 'ladder_hot_c1200_r0p85', module: 'ladder.ts', tol: 'coeff',
      output: out, input, params: { cutoffHz: 1200, resonance: 0.85 },
      notes: 'The stored input file is ALREADY scaled to +/-6 so saturate() runs '
        + 'well past its linear region. Feed the file straight into process().',
    });
  }
}

export function filterCases(D) {
  const { StateVariableFilter, DiodeFilter, createFilter } = D;
  const N = 8192;

  for (const mode of ['lp', 'bp', 'hp']) {
    for (const [tag, hz, r] of [['c1000_r0', 1000, 0], ['c300_r0p9', 300, 0.9],
      ['c12000_r0p5', 12000, 0.5], ['c1000_r1', 1000, 1]]) {
      const f = new StateVariableFilter(SR);
      f.setMode(mode); f.setCutoff(hz); f.setResonance(r);
      const input = noise(N, 0x5f0000 + hz);
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) out[i] = f.process(input[i]);
      emit({
        id: `filters_svf_${mode}_${tag}`, module: 'filters.ts', tol: 'coeff',
        output: out, input, params: { mode, cutoffHz: hz, resonance: r },
        notes: 'setMode BEFORE setCutoff/setResonance, as here.',
      });
    }
  }
  // Ring the SVF at maximum resonance, where the integrator softLimit bounds it.
  {
    const f = new StateVariableFilter(SR);
    f.setMode('lp'); f.setCutoff(800); f.setResonance(1);
    const raw = burst(N, 256, 0xbeef);
    const input = new Float32Array(N);
    for (let i = 0; i < N; i++) input[i] = raw[i] * 4;
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = f.process(input[i]);
    emit({
      id: 'filters_svf_selfosc_c800', module: 'filters.ts', tol: 'coeff',
      output: out, input, params: { mode: 'lp', cutoffHz: 800, resonance: 1 },
      notes: '256-sample noise burst at +/-4 then silence; the tail is bounded by '
        + 'softLimit(s,3,6) on the integrator states. Feed the file straight in.',
    });
  }

  for (const [tag, hz, r] of [['c1000_r0', 1000, 0], ['c250_r0p95', 250, 0.95],
    ['c6000_r0p6', 6000, 0.6], ['c1000_r1', 1000, 1]]) {
    const f = new DiodeFilter(SR);
    f.setCutoff(hz); f.setResonance(r);
    const input = noise(N, 0xd10de + hz);
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = f.process(input[i]);
    emit({
      id: `filters_diode_${tag}`, module: 'filters.ts', tol: 'coeff',
      output: out, input, params: { cutoffHz: hz, resonance: r },
    });
  }
  // Asymmetric saturator well engaged: positive half folds at 0.7, negative 1.4.
  {
    const f = new DiodeFilter(SR);
    f.setCutoff(900); f.setResonance(0.9);
    const n = noise(N, 0x0a57aa);
    const input = new Float32Array(N);
    for (let i = 0; i < N; i++) input[i] = n[i] * 5 + 0.6;
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = f.process(input[i]);
    emit({
      id: 'filters_diode_asym_c900', module: 'filters.ts', tol: 'coeff',
      output: out, input, params: { cutoffHz: 900, resonance: 0.9 },
      notes: 'DC-offset hot noise so asymSat sees both knees.',
    });
  }
  // createFilter dispatch: 'ladder' must be the fallback for anything unknown.
  for (const model of ['ladder', 'svf', 'diode']) {
    const f = createFilter(model, SR);
    f.setCutoff(1500); f.setResonance(0.4);
    const input = step(2048, 64, 1);
    const out = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) out[i] = f.process(input[i]);
    emit({
      id: `filters_create_${model}_step`, module: 'filters.ts', tol: 'coeff',
      output: out, input, params: { model, cutoffHz: 1500, resonance: 0.4 },
    });
  }
}

export function envelopeCases(D) {
  const { Envelope } = D;
  const N = 24000;
  const settings = [
    ['default', 5, 100, 0.7, 200],
    ['snap', 0.5, 1, 0, 1],
    ['slow', 4000, 8000, 1, 8000],
    ['zero_sustain', 5, 300, 0, 400],
    ['full_sustain', 1, 50, 1, 100],
  ];
  for (const [tag, a, d, s, r] of settings) {
    const e = new Envelope(SR);
    e.set(a, d, s, r);
    e.trigger();
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (i === 12000) e.release();
      out[i] = e.next();
    }
    emit({
      id: `envelope_${tag}`, module: 'envelope.ts', tol: 'coeff', output: out,
      params: { attackMs: a, decayMs: d, sustain: s, releaseMs: r, releaseAtSample: 12000 },
      notes: 'trigger() before sample 0; release() before sample 12000. '
        + 'Stage transitions are threshold tests, so a 1-ulp coefficient '
        + 'difference can move one transition by one sample: expect an isolated '
        + 'spike, not drift, if that happens.',
    });
  }
  // Release before the attack completes: exercises the stage machine, not the
  // steady-state curve.
  {
    const e = new Envelope(SR);
    e.set(500, 500, 0.5, 500);
    e.trigger();
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (i === 1000) e.release();
      if (i === 9000) e.trigger();
      out[i] = e.next();
    }
    emit({
      id: 'envelope_retrigger', module: 'envelope.ts', tol: 'coeff', output: out,
      params: { attackMs: 500, decayMs: 500, sustain: 0.5, releaseMs: 500,
        releaseAtSample: 1000, retriggerAtSample: 9000 },
    });
  }
}

export function lfoCases(D) {
  const { addOsc, Lfo, WAVE_SAW, WAVE_PULSE, WAVE_TRIANGLE, WAVE_SINE } = D;
  const N = 8192;

  // addOsc: block form, phase/tri state held in caller-owned Float64Arrays.
  const shapes = [['saw', WAVE_SAW, 'exact'], ['pulse', WAVE_PULSE, 'exact'],
    ['triangle', WAVE_TRIANGLE, 'exact'], ['sine', WAVE_SINE, 'trans']];
  for (const [name, shape, tol] of shapes) {
    for (const [hz, pw] of [[110, 0.5], [1234.5, 0.23], [7000, 0.5]]) {
      const ph = new Float64Array(4), tri = new Float64Array(4);
      ph[1] = 0.25;
      const acc = new Float64Array(N);
      // Two voices summed into one buffer, u=0 and u=1, exactly as a unison
      // oscillator does it.
      addOsc(shape, acc, N, ph, tri, 0, hz / SR, pw, 0.8);
      addOsc(shape, acc, N, ph, tri, 1, (hz * 1.01) / SR, pw, 0.5);
      emit({
        id: `lfo_addosc_${name}_${String(hz).replace('.', 'p')}`, module: 'lfo.ts',
        tol, output: Float32Array.from(acc),
        params: { shape, hz, pw, gain0: 0.8, gain1: 0.5, inc0: hz / SR,
          inc1: (hz * 1.01) / SR, phaseInit: [0, 0.25, 0, 0], triInit: [0, 0, 0, 0] },
        notes: 'out starts at 0; addOsc(u=0) then addOsc(u=1) into the SAME buffer, '
          + 'accumulating. ph[1] starts at 0.25.',
      });
    }
  }
  // Split across blocks: state must survive a call boundary identically.
  {
    const ph = new Float64Array(4), tri = new Float64Array(4);
    const acc = new Float64Array(N);
    const pattern = [1, 7, 128, 64, 3, 199];
    let i = 0, k = 0;
    while (i < N) {
      const m = Math.min(pattern[k % pattern.length], N - i);
      addOsc(WAVE_TRIANGLE, acc.subarray(i, i + m), m, ph, tri, 0, 220 / SR, 0.5, 0.9);
      i += m; k++;
    }
    emit({
      id: 'lfo_addosc_triangle_blocked', module: 'lfo.ts', tol: 'exact',
      output: Float32Array.from(acc),
      params: { shape: WAVE_TRIANGLE, hz: 220, gain: 0.9, blockPattern: [1, 7, 128, 64, 3, 199] },
      notes: 'Same signal as a single call would give; proves the triangle '
        + 'integrator state survives block boundaries.',
    });
  }

  // Lfo class: five shapes, seeded, with fade-in.
  for (let shape = 0; shape < 5; shape++) {
    for (const [tag, rate, depth, delayMs, keysync, seed] of [
      ['fast', 6, 1, 0, true, 0],
      ['slow_fade', 0.5, 0.8, 250, true, 3],
      ['free', 3.2, 1, 0, false, 7],
    ]) {
      const l = new Lfo(SR);
      l.setRate(rate); l.setShape(shape); l.setDepth(depth); l.setDelayMs(delayMs);
      l.seed(seed); l.trigger(keysync);
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) out[i] = l.next();
      emit({
        id: `lfo_shape${shape}_${tag}`, module: 'lfo.ts',
        tol: shape === 0 ? 'trans' : 'exact', output: out,
        params: { shape, rateHz: rate, depth, delayMs, keysync, seed },
        notes: 'Call order: setRate, setShape, setDepth, setDelayMs, seed, '
          + 'trigger(keysync). seed() draws two randoms before any next().',
      });
    }
  }
  // Rate clamps: 0, negative, and above sr*0.45.
  {
    const out = new Float32Array(3072);
    let k = 0;
    for (const rate of [0, -5, SR]) {
      const l = new Lfo(SR);
      l.setRate(rate); l.setShape(2); l.setDepth(1); l.setDelayMs(0);
      l.seed(11); l.trigger(true);
      for (let i = 0; i < 1024; i++) out[k++] = l.next();
    }
    emit({
      id: 'lfo_rate_clamps', module: 'lfo.ts', tol: 'exact', output: out,
      params: { rates: [0, -5, SR], shape: 2, seed: 11, framesPerRate: 1024 },
      notes: 'Three 1024-frame segments concatenated, fresh Lfo each.',
    });
  }
}
