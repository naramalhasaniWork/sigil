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
     * Best of three, not a single pass. A one-shot measurement fails whenever
     * something else is using the machine — a dev server, a browser, another
     * test file — which made this gate flaky and therefore worthless. The
     * minimum is the least-contended sample, so it measures what the DSP costs
     * rather than what the laptop happened to be doing.
     */
    let best = Infinity;
    for (let pass = 0; pass < 3; pass++) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < blocks; i++) { out.fill(0); vm.render(out, 128); }
      const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;
      if (elapsed < best) best = elapsed;
    }

    const cpuFraction = best / 10;
    console.log(`  8 voices = ${(cpuFraction * 100).toFixed(2)}% of one core (best of 3)`);
    // Spec budget is 5% of a core on desktop. Node/V8 is the proxy; the
    // authoritative on-device AudioWorklet measurement is a separate gate.
    expect(cpuFraction).toBeLessThan(0.05);
  });
});
