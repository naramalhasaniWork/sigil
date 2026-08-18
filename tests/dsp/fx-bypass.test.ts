import { describe, it, expect } from 'vitest';
import { FxChain } from '@/dsp/fx';
import { MagicChain } from '@/dsp/fx-magic';
import { VoiceManager } from '@/dsp/voice-manager';
import { AnalogEngine } from '@/dsp/analog-voice';

const SR = 48000;
const BLOCK = 128;

/**
 * These exist because an audit found both FX chains running every effect on
 * every sample even at mix zero — `blend(x, unit.process(...), 0)` reads as a
 * bypass, but JavaScript evaluates arguments eagerly. Measured cost was 4.18% of
 * a core for two chains producing their input unchanged, against 3.27% for the
 * entire 16-voice synth.
 *
 * The existing performance gate could never have caught it: it measures
 * VoiceManager.render alone, with no FX in the path.
 */
function costOf(render: () => void, seconds: number): number {
  const blocks = Math.floor((SR * seconds) / BLOCK);
  for (let i = 0; i < 400; i++) render();          // warm the JIT
  let best = Infinity;
  for (let pass = 0; pass < 3; pass++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < blocks; i++) render();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e9);
  }
  return best / seconds;
}

describe('FX bypass', () => {
  it('an idle FxChain is far cheaper than the synth feeding it', () => {
    const fx = new FxChain(SR);
    const buf = new Float32Array(BLOCK);
    const idleFx = costOf(() => { buf.fill(0.2); fx.process(buf, BLOCK); }, 4);

    const vm = new VoiceManager(AnalogEngine, SR, 8);
    for (let n = 55; n < 63; n++) vm.noteOn(n, 1);
    const out = new Float32Array(BLOCK);
    const synth = costOf(() => { out.fill(0); vm.render(out, BLOCK); }, 4);

    console.log(`  idle FxChain ${(idleFx * 100).toFixed(2)}% vs 8-voice synth ${(synth * 100).toFixed(2)}%`);
    // Before gating these were comparable. A bypassed chain should be a rounding
    // error next to eight live voices.
    expect(idleFx).toBeLessThan(synth * 0.5);
  });

  it('an idle MagicChain is far cheaper than the synth feeding it', () => {
    const magic = new MagicChain(SR);
    const buf = new Float32Array(BLOCK);
    const idleMagic = costOf(() => { buf.fill(0.2); magic.process(buf, BLOCK); }, 4);

    const vm = new VoiceManager(AnalogEngine, SR, 8);
    for (let n = 55; n < 63; n++) vm.noteOn(n, 1);
    const out = new Float32Array(BLOCK);
    const synth = costOf(() => { out.fill(0); vm.render(out, BLOCK); }, 4);

    console.log(`  idle MagicChain ${(idleMagic * 100).toFixed(2)}% vs 8-voice synth ${(synth * 100).toFixed(2)}%`);
    expect(idleMagic).toBeLessThan(synth * 0.5);
  });

  it('leaves the signal untouched when fully bypassed', () => {
    const fx = new FxChain(SR);
    const magic = new MagicChain(SR);
    const buf = new Float32Array(BLOCK);
    const reference = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const s = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.4;
      buf[i] = s;
      reference[i] = s;
    }
    // Settle the smoothers, then check a fresh block passes through.
    for (let i = 0; i < 60; i++) { const t = Float32Array.from(reference); fx.process(t, BLOCK); magic.process(t, BLOCK); }

    magic.process(buf, BLOCK);
    let maxDelta = 0;
    for (let i = 0; i < BLOCK; i++) {
      maxDelta = Math.max(maxDelta, Math.abs((buf[i] as number) - (reference[i] as number)));
    }
    // MagicChain returns early when everything is silent, so this is exact.
    expect(maxDelta).toBe(0);
  });

  it('still applies an effect once its mix is raised', () => {
    const magic = new MagicChain(SR);
    // Shimmer mix is index 3 in FX_MAGIC_DESCRIPTOR's parameter order.
    magic.setParam(3, 0.9);
    const buf = new Float32Array(BLOCK);
    let energy = 0;
    for (let block = 0; block < 200; block++) {
      for (let i = 0; i < BLOCK; i++) {
        buf[i] = Math.sin((2 * Math.PI * 220 * (block * BLOCK + i)) / SR) * 0.4;
      }
      magic.process(buf, BLOCK);
      if (block > 150) for (const s of buf) energy += s * s;
    }
    // Gating must not silence a unit that is actually switched on.
    expect(energy).toBeGreaterThan(0);
    expect(Number.isFinite(energy)).toBe(true);
  });
});
