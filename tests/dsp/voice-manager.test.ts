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
    vm.setParam(8, 2);
    vm.noteOn(60, 1);
    const out = new Float32Array(512);
    vm.render(out, 512);
    vm.noteOff(60);
    for (let i = 0; i < 60; i++) { out.fill(0); vm.render(out, 512); }
    expect(vm.activeCount).toBe(0);
  });

  it('applies the tuning table to note frequencies', () => {
    const vm = new VoiceManager(AnalogEngine, SR, 8);
    vm.tuning.setReference(69, 432);
    expect(vm.tuning.frequency(69)).toBeCloseTo(432, 6);
  });
});
