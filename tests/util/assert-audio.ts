import { expect } from 'vitest';

/**
 * Assert a rendered buffer is finite and bounded — scanning first, asserting
 * once.
 *
 * Calling expect() per sample looks harmless until it sits inside a parameter
 * sweep: 11 parameters x 2 extremes x 8192 samples x 2 assertions is 360,448
 * expect() calls for a single test, which took over six seconds and timed out
 * unpredictably whenever the machine was busy. The DSP was never at fault; the
 * assertions were. Scanning in a plain loop and reporting only the first
 * offender keeps the diagnostic just as precise and costs almost nothing.
 */
export function expectAudioOk(out: Float32Array, limit: number, label: string): void {
  let badIndex = -1;
  let badValue = 0;

  for (let i = 0; i < out.length; i++) {
    const s = out[i] as number;
    if (!Number.isFinite(s) || Math.abs(s) >= limit) {
      badIndex = i;
      badValue = s;
      break;
    }
  }

  expect(
    badIndex,
    badIndex === -1
      ? label
      : `${label}: sample ${badIndex} was ${badValue} (limit ${limit})`,
  ).toBe(-1);
}

/** Every sample is exactly zero — silence, not merely quiet. */
export function expectSilence(out: Float32Array, label: string): void {
  let badIndex = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== 0) { badIndex = i; break; }
  }
  expect(
    badIndex,
    badIndex === -1 ? label : `${label}: sample ${badIndex} was ${out[badIndex]}, expected 0`,
  ).toBe(-1);
}

/** Peak absolute value, for tests that care about level rather than validity. */
export function peakOf(out: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i] as number);
    if (a > peak) peak = a;
  }
  return peak;
}
