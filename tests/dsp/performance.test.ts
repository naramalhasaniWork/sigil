import { describe, it, expect } from 'vitest';
import { VoiceManager } from '@/dsp/voice-manager';
import { AnalogEngine } from '@/dsp/analog-voice';

const SR = 48000;

describe('performance budget', () => {
  it('renders 8 voices well inside the CPU budget', () => {
    const vm = new VoiceManager(AnalogEngine, SR, 8);
    for (let n = 55; n < 63; n++) vm.noteOn(n, 1);
    const out = new Float32Array(128);

    for (let i = 0; i < 500; i++) { out.fill(0); vm.render(out, 128); }

    const blocks = Math.floor((SR * 10) / 128);

    /*
     * Calibrated, not absolute. An absolute wall-clock budget fails whenever
     * the machine is busy — a dev server and a browser were enough to trip it
     * twice — so it stopped being evidence about the DSP. Instead we time a
     * fixed reference workload on the SAME machine under the SAME conditions
     * and assert the ratio. A slower or loaded machine scales both numbers, so
     * the gate still catches a real regression in the DSP while ignoring
     * whatever else is running.
     */
    const REFERENCE_OPS = 40_000_000;
    const calibrate = (): number => {
      const t0 = process.hrtime.bigint();
      let acc = 0;
      for (let i = 0; i < REFERENCE_OPS; i++) acc += i * 0.5 + (i & 7);
      const dt = Number(process.hrtime.bigint() - t0) / 1e9;
      return acc === 0 ? dt : dt;   // acc is consumed so the loop cannot be elided
    };

    const measure = (): number => {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < blocks; i++) { out.fill(0); vm.render(out, 128); }
      return Number(process.hrtime.bigint() - t0) / 1e9;
    };

    // Best of three for each, interleaved so a transient hits both equally.
    let bestRender = Infinity;
    let bestRef = Infinity;
    for (let pass = 0; pass < 3; pass++) {
      bestRef = Math.min(bestRef, calibrate());
      bestRender = Math.min(bestRender, measure());
    }

    const cpuFraction = bestRender / 10;
    const ratio = bestRender / bestRef;
    console.log(
      `  8 voices = ${(cpuFraction * 100).toFixed(2)}% of one core, ` +
      `${ratio.toFixed(2)}x the reference workload`,
    );

    /*
     * Measured baseline: 8.3x the reference, stable to about 1% across runs
     * even with a dev server and browser running — which is exactly the
     * load-independence an absolute wall-clock budget did not have.
     *
     * Threshold 12x leaves ~45% headroom: it will not fire on noise, and it
     * will fire if the engine's cost grows by half again. Raising it is a
     * deliberate act that should come with a reason.
     *
     * For reference the absolute figure logged above is ~2.3% of one core for 8
     * voices, up from 0.77% when the engine was two saws and a filter — the
     * sub-oscillator, noise source, unison and LFO account for the difference,
     * and it remains far inside the spec's 5% desktop budget.
     */
    expect(ratio).toBeLessThan(12);
  });
});
