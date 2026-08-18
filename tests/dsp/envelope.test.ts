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
    expect(v).toBeGreaterThan(0.55);
  });
});
