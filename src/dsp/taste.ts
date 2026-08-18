import type { EngineDescriptor, ParamDescriptor } from '@/audio/types';
import { normalise, denormalise } from '@/dsp/mutation';

/**
 * Taste: the machine loads the dice.
 *
 * Keeping a patch is currently a checkbox that expires the moment you breed. It
 * should be a vote. This turns the set of patches you kept into a direction in
 * normalised parameter space — the average of "what you chose, minus what you
 * were offered" — and the next generation is seeded a little way along it. Keep
 * the darker ones three times and the machine starts offering dark.
 *
 * The whole file is one clamp away from being dangerous, so the clamps are the
 * design:
 *
 *  - a taste vector is bounded to ±CLAMP in normalised space, so it can bias a
 *    hunt but can never pin a parameter to its wall;
 *  - it is blended, not replaced, so one weird keep does not redefine you;
 *  - it decays every generation, so taste has to be re-expressed to survive;
 *  - it is applied at partial strength, so the seed is nudged rather than moved.
 *
 * Without those, convergence becomes collapse: every child identical, at the
 * extremes, and the hunt is over.
 */

/** Widest bias any single parameter may carry, in normalised space. */
const CLAMP = 0.5;

function clampBias(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < -CLAMP ? -CLAMP : v > CLAMP ? CLAMP : v;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function valueAt(values: Float32Array, i: number, p: ParamDescriptor): number {
  const raw = values[i];
  return raw === undefined ? p.default : raw;
}

/**
 * The direction the kept patches sit in, relative to what was offered.
 *
 * Measured against the SEED rather than against each other, because the question
 * is not "what do these have in common" but "which way did you go when given the
 * choice" — the seed is the thing you were rejecting.
 */
export function tasteFrom(
  seed: Float32Array,
  kept: readonly Float32Array[],
  descriptor: EngineDescriptor,
): Float32Array {
  const out = new Float32Array(descriptor.params.length);
  if (kept.length === 0) return out;
  for (let i = 0; i < descriptor.params.length; i++) {
    const p = descriptor.params[i];
    if (p === undefined) continue;
    const base = normalise(valueAt(seed, i, p), p);
    let sum = 0;
    for (const k of kept) sum += normalise(valueAt(k, i, p), p) - base;
    out[i] = clampBias(sum / kept.length);
  }
  return out;
}

/**
 * Folds a new observation into the standing taste. `alpha` is how much the new
 * generation counts: 1 forgets everything older, 0 ignores what just happened.
 *
 * A length mismatch means the engine changed underneath us — parameter 7 is a
 * different parameter in FM than in Analog — so the old vector is discarded
 * rather than misapplied.
 */
export function blendTaste(
  prev: Float32Array | null,
  next: Float32Array,
  alpha: number,
): Float32Array {
  if (prev === null || prev.length !== next.length) return Float32Array.from(next);
  const a = clamp01(alpha);
  const out = new Float32Array(next.length);
  for (let i = 0; i < next.length; i++) {
    out[i] = clampBias((prev[i] ?? 0) * (1 - a) + (next[i] ?? 0) * a);
  }
  return out;
}

/** Fades a taste vector. Taste has to be re-expressed to survive. */
export function decayTaste(taste: Float32Array, factor: number): Float32Array {
  const f = clamp01(factor);
  const out = new Float32Array(taste.length);
  for (let i = 0; i < taste.length; i++) out[i] = clampBias((taste[i] ?? 0) * f);
  return out;
}

/**
 * Moves a seed along the taste direction and back into real parameter units.
 * `strength` is 0..1; the whole point is that it is well under 1, so a hunt is
 * steered rather than decided.
 */
export function applyTaste(
  seed: Float32Array,
  taste: Float32Array,
  descriptor: EngineDescriptor,
  strength: number,
): Float32Array {
  const out = new Float32Array(descriptor.params.length);
  const s = clamp01(strength);
  for (let i = 0; i < descriptor.params.length; i++) {
    const p = descriptor.params[i];
    if (p === undefined) continue;
    const base = normalise(valueAt(seed, i, p), p);
    const bias = taste.length === descriptor.params.length ? (taste[i] ?? 0) : 0;
    out[i] = denormalise(clamp01(base + bias * s), p);
  }
  return out;
}

/** How much this vector actually leans, 0..1. Below a threshold, say nothing. */
export function tasteStrength(taste: Float32Array): number {
  if (taste.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < taste.length; i++) sum += Math.abs(taste[i] ?? 0);
  return clamp01(sum / (taste.length * CLAMP));
}
