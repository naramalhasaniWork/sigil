import type { EngineDescriptor, ParamDescriptor } from '@/audio/types';

/**
 * Hunt: patches are discovered by taste, not dialled in. Everything here is a
 * pure function over a descriptor and a seeded RNG, so a session is fully
 * reproducible and nothing needs a model or the audio thread.
 */
export interface Patch {
  engineId: string;
  values: Float32Array;
}

/** Default mutability when a descriptor does not state one. */
const DEFAULT_MUTABILITY = 0.5;
/** Jitter applied to a bred value, as a mutation amount. */
const BREED_JITTER = 0.05;
/** Widest normalised step a single mutation may take at amount = mutability = 1. */
const WALK_SCALE = 0.5;
/** Nearest / widest scaling applied across a set of variations. */
const SPREAD_MIN = 0.45;
const SPREAD_MAX = 1.3;
/** How hard variations() tries before accepting a duplicate. */
const DISTINCT_TRIES = 8;

/**
 * Deterministic xorshift32. Same seed, same stream, on every machine — which is
 * what makes a hunt shareable as a single number rather than a blob of floats.
 */
export function makeRng(seed: number): () => number {
  let s = Math.trunc(seed) | 0;
  if (s === 0) s = 0x9e3779b9 | 0;
  return (): number => {
    s ^= s << 13;
    s |= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s |= 0;
    return (s >>> 0) / 4294967296;
  };
}

/** True when this parameter can be walked geometrically (log space). */
function isGeometric(p: ParamDescriptor): boolean {
  return (p.curve === 'exp' || p.curve === 'log') && p.min > 0 && p.max > p.min;
}

function stepCount(p: ParamDescriptor): number {
  const declared = p.steps ?? 0;
  if (declared >= 2) return Math.floor(declared);
  const span = Math.round(p.max - p.min);
  return span >= 1 ? span + 1 : 2;
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function quantise(v: number, p: ParamDescriptor): number {
  const span = p.max - p.min;
  if (span <= 0) return p.min;
  const count = stepCount(p);
  const raw = Math.round(((v - p.min) / span) * (count - 1));
  const idx = raw < 0 ? 0 : raw > count - 1 ? count - 1 : raw;
  return p.min + (idx * span) / (count - 1);
}

/** Clamp into range and, for stepped parameters, onto a valid step. */
function constrain(v: number, p: ParamDescriptor): number {
  const c = clamp(v, p.min, p.max);
  return p.curve === 'stepped' ? quantise(c, p) : c;
}

/**
 * Value -> 0..1. Exponential parameters normalise in log space so that a walk
 * of a given size covers the same musical distance at 40 Hz as at 8 kHz;
 * without this, low cutoffs are simply never explored.
 */
export function normalise(v: number, p: ParamDescriptor): number {
  const span = p.max - p.min;
  if (span <= 0) return 0;
  if (isGeometric(p)) {
    const c = clamp(v, p.min, p.max);
    return Math.log(c / p.min) / Math.log(p.max / p.min);
  }
  return clamp((v - p.min) / span, 0, 1);
}

/** 0..1 -> value, inverse of `normalise`, then clamped and stepped. */
export function denormalise(n: number, p: ParamDescriptor): number {
  const t = clamp(n, 0, 1);
  if (isGeometric(p)) {
    return constrain(p.min * Math.pow(p.max / p.min, t), p);
  }
  return constrain(p.min + t * (p.max - p.min), p);
}

/** Triangular in [-1, 1]: small moves are common, big ones rare. */
function triangular(rng: () => number): number {
  return rng() + rng() - 1;
}

/** Reflect off the walls so values at an extreme still explore inwards. */
function reflect(n: number): number {
  let x = n;
  if (x < 0) x = -x;
  if (x > 1) x = 2 - x;
  return clamp(x, 0, 1);
}

function walkValue(v: number, p: ParamDescriptor, amount: number, rng: () => number): number {
  const mutability = p.mutability ?? DEFAULT_MUTABILITY;
  const size = amount * mutability * WALK_SCALE;
  // A frozen parameter is copied verbatim: no round trip, so no drift.
  if (!(size > 0)) return constrain(v, p);
  const n = normalise(v, p);
  return denormalise(reflect(n + triangular(rng) * size), p);
}

function valueAt(patch: Patch, i: number, p: ParamDescriptor): number {
  const raw = patch.values[i];
  return raw === undefined ? p.default : raw;
}

function emptyValues(descriptor: EngineDescriptor): Float32Array {
  return new Float32Array(descriptor.params.length);
}

/** A patch drawn uniformly in normalised space — chance as a starting point. */
export function randomPatch(descriptor: EngineDescriptor, rng: () => number): Patch {
  const values = emptyValues(descriptor);
  for (let i = 0; i < descriptor.params.length; i++) {
    const p = descriptor.params[i];
    if (p === undefined) continue;
    values[i] = denormalise(rng(), p);
  }
  return { engineId: descriptor.id, values };
}

/** A patch at every parameter's default: the tame seed for a hunt. */
export function defaultPatch(descriptor: EngineDescriptor): Patch {
  const values = emptyValues(descriptor);
  for (let i = 0; i < descriptor.params.length; i++) {
    const p = descriptor.params[i];
    if (p === undefined) continue;
    values[i] = constrain(p.default, p);
  }
  return { engineId: descriptor.id, values };
}

/**
 * Constrained random walk in normalised space, per-parameter step scaled by
 * mutability, so destructive parameters barely move while character
 * parameters roam. `amount` is 0..1.
 */
export function mutate(
  patch: Patch,
  descriptor: EngineDescriptor,
  amount: number,
  rng: () => number,
): Patch {
  const a = amount < 0 ? 0 : amount;
  const values = emptyValues(descriptor);
  for (let i = 0; i < descriptor.params.length; i++) {
    const p = descriptor.params[i];
    if (p === undefined) continue;
    values[i] = walkValue(valueAt(patch, i, p), p, a, rng);
  }
  return { engineId: descriptor.id, values };
}

/** Per-parameter crossover from either parent, plus a little jitter. */
export function breed(
  a: Patch,
  b: Patch,
  descriptor: EngineDescriptor,
  rng: () => number,
): Patch {
  const values = emptyValues(descriptor);
  for (let i = 0; i < descriptor.params.length; i++) {
    const p = descriptor.params[i];
    if (p === undefined) continue;
    const parent = rng() < 0.5 ? a : b;
    values[i] = walkValue(valueAt(parent, i, p), p, BREED_JITTER, rng);
  }
  return { engineId: descriptor.id, values };
}

function sameValues(a: Patch, b: Patch): boolean {
  if (a.values.length !== b.values.length) return false;
  for (let i = 0; i < a.values.length; i++) {
    if (a.values[i] !== b.values[i]) return false;
  }
  return true;
}

/**
 * A set of children of one seed, spread from near-neighbours to wild ones so a
 * single screen offers both "more like that" and "somewhere else entirely".
 * Duplicates are retried; if a descriptor cannot vary (everything frozen) the
 * duplicate is accepted rather than looping forever.
 */
export function variations(
  seed: Patch,
  descriptor: EngineDescriptor,
  count: number,
  amount: number,
  rng: () => number,
): Patch[] {
  const n = Math.max(0, Math.floor(count));
  const out: Patch[] = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    const scaled = amount * (SPREAD_MIN + (SPREAD_MAX - SPREAD_MIN) * t);
    let child = mutate(seed, descriptor, scaled, rng);
    for (let tries = 0; tries < DISTINCT_TRIES; tries++) {
      let clash = false;
      for (let j = 0; j < out.length; j++) {
        const other = out[j];
        if (other !== undefined && sameValues(other, child)) {
          clash = true;
          break;
        }
      }
      if (!clash) break;
      child = mutate(seed, descriptor, scaled, rng);
    }
    out.push(child);
  }
  return out;
}
