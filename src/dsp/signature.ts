import type { EngineDescriptor, ParamDescriptor } from '@/audio/types';
import { normalise } from '@/dsp/mutation';
import { AXIS_WORDS } from '@/dsp/sigil-words';

/**
 * A patch's identity, read out of the patch itself.
 *
 * Nothing here is stored on a patch or chosen by a person: the name and the mark
 * are both *functions* of the parameter values, so the same sound is always
 * called the same thing and always draws the same glyph, on every machine, with
 * no persistence. That is what makes a generated name trustworthy rather than
 * cute — a heavy dark patch cannot come out called "Bright Tide".
 *
 * The four axes are the four macros. The whole instrument already asserts that
 * macro 0..3 mean the same thing in every engine (Body, Air, Grit, Motion), so
 * reading identity off them is the one description that generalises across all
 * six engines without a per-engine table.
 */
export interface Signature {
  /** Macro 0 — weight, low end, sub. */
  body: number;
  /** Macro 1 — brightness, openness. */
  air: number;
  /** Macro 2 — dirt, drive, noise. */
  grit: number;
  /** Macro 3 — movement, drift, modulation. */
  motion: number;
  /** Everything not assigned to a macro, as one number. Structure, not character. */
  reach: number;
}

export interface Point { readonly x: number; readonly y: number }

export interface Sigil {
  /** Spoke tips, in draw order. Connect them for the silhouette. */
  readonly spokes: readonly Point[];
  /** Filled node at the longest spoke — the patch's dominant feature. */
  readonly node: Point;
  /** The cut: one straight line across the whole mark, angled by Motion. */
  readonly cut: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number };
}

/** Spokes in a sigil. Nine reads as constructed; six reads as a snowflake. */
const SPOKES = 9;
/**
 * Degrees between spokes. 38.7 x 9 = 348.3, so the ring never closes — the gap
 * is what stops the mark reading as a radar chart.
 */
const SPOKE_STEP = 38.7;
const CENTRE = 50;
const R_MIN = 14;
const R_SPAN = 34;
const CUT_REACH = 46;

function safe01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Quantises a coordinate to 1/100 of the box.
 *
 * Not cosmetic. `Math.cos` is not required to be bit-identical across engines, and
 * it is not: the server rendered `x2="62.60974715863566"` where the browser
 * computed `62.60974715863567`, and React reported a hydration mismatch on every
 * single load. Rounding puts the two on the same number, and 0.01 of a 100-unit
 * box is far below one device pixel at any size this is drawn at.
 */
function snap(v: number): number {
  return Math.round(v * 100) / 100;
}

function valueAt(values: Float32Array, i: number, p: ParamDescriptor): number {
  const raw = values[i];
  return raw === undefined ? p.default : raw;
}

/** Normalised 0..1 for every parameter, in descriptor order. */
function normalisedAll(values: Float32Array, descriptor: EngineDescriptor): number[] {
  const out: number[] = [];
  for (let i = 0; i < descriptor.params.length; i++) {
    const p = descriptor.params[i];
    if (p === undefined) continue;
    out.push(safe01(normalise(valueAt(values, i, p), p)));
  }
  return out;
}

function mean(list: readonly number[]): number {
  if (list.length === 0) return 0.5;
  let sum = 0;
  for (const v of list) sum += v;
  return safe01(sum / list.length);
}

/**
 * Reads the five identity axes off a patch. Each macro axis is the mean
 * normalised position of every parameter that answers to that macro, so it
 * moves when the macro moves and also when you dial the same territory by hand
 * in Deep view — the signature describes the *sound*, not the route taken.
 */
export function patchSignature(values: Float32Array, descriptor: EngineDescriptor): Signature {
  const buckets: number[][] = [[], [], [], []];
  const rest: number[] = [];
  for (let i = 0; i < descriptor.params.length; i++) {
    const p = descriptor.params[i];
    if (p === undefined) continue;
    const n = safe01(normalise(valueAt(values, i, p), p));
    const bucket = p.macro === undefined ? undefined : buckets[p.macro];
    if (bucket === undefined) rest.push(n);
    else bucket.push(n);
  }
  return {
    body: mean(buckets[0] ?? []),
    air: mean(buckets[1] ?? []),
    grit: mean(buckets[2] ?? []),
    motion: mean(buckets[3] ?? []),
    reach: mean(rest),
  };
}

/**
 * Deterministic 32-bit hash of a patch. Values are quantised to 1/64 of their
 * range first, so a patch does not get renamed by float noise or by a parameter
 * moving a thousandth of a percent — but a real edit does change the name.
 */
export function patchHash(values: Float32Array, descriptor: EngineDescriptor): number {
  let h = 0x811c9dc5 | 0;
  const all = normalisedAll(values, descriptor);
  for (let i = 0; i < all.length; i++) {
    const q = Math.round((all[i] ?? 0) * 64);
    h = (h ^ (q + i * 31)) | 0;
    h = Math.imul(h, 0x01000193) | 0;
  }
  return h >>> 0;
}

function axisValues(sig: Signature): readonly number[] {
  return [sig.body, sig.air, sig.grit, sig.motion];
}

function pick(list: readonly string[], index: number): string {
  return list[index % list.length] ?? list[0] ?? '';
}

/**
 * Two words that describe this patch. Deterministic in (signature, hash): the
 * adjective comes from whichever axis is furthest from neutral, the noun from
 * the next, and the hash only chooses *which* synonym — never which axis. So a
 * name is a reading of the sound, and re-rolling cannot make a dark sound
 * bright.
 */
export function sigilName(sig: Signature, hash: number): string {
  const axes = axisValues(sig);
  let first = 0;
  let second = 1;
  let firstScore = -1;
  let secondScore = -1;
  for (let i = 0; i < axes.length; i++) {
    const score = Math.abs((axes[i] ?? 0.5) - 0.5);
    if (score > firstScore) {
      second = first; secondScore = firstScore;
      first = i; firstScore = score;
    } else if (score > secondScore) {
      second = i; secondScore = score;
    }
  }

  const adjAxis = AXIS_WORDS[first] ?? AXIS_WORDS[0];
  const nounAxis = AXIS_WORDS[second] ?? AXIS_WORDS[1];
  if (adjAxis === undefined || nounAxis === undefined) return 'Sigil';

  const adjSide = (axes[first] ?? 0.5) >= 0.5 ? adjAxis.high : adjAxis.low;
  const nounSide = (axes[second] ?? 0.5) >= 0.5 ? nounAxis.high : nounAxis.low;
  return `${pick(adjSide.adj, hash)} ${pick(nounSide.noun, hash >>> 8)}`;
}

/** The true name of a patch: signature and hash in one call. */
export function nameOf(values: Float32Array, descriptor: EngineDescriptor): string {
  return sigilName(patchSignature(values, descriptor), patchHash(values, descriptor));
}

const NUMERALS: readonly string[] = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/**
 * A name that is not already taken. Two patches can legitimately read the same,
 * and silently overwriting the earlier one is the worst possible outcome of a
 * feature whose whole point is keeping things — so the second one becomes
 * "Bright Tide II".
 */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const t of taken) used.add(t.trim().toLowerCase());
  if (!used.has(base.trim().toLowerCase())) return base;
  for (const numeral of NUMERALS) {
    const candidate = `${base} ${numeral}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${used.size + 1}`;
}

/**
 * The nine lengths the mark is built from.
 *
 * Deliberately NOT nine evenly sampled parameters: with 39 parameters in Analog,
 * even sampling skipped the cutoff entirely, so two patches an octave apart in
 * brightness drew the identical glyph. The mark has to move when the *sound*
 * moves. So the five identity axes are interleaved with four sampled structural
 * parameters — the axes make it responsive to character, the samples keep two
 * patches with the same character visually distinct, and interleaving stops all
 * the character sitting on one side of the form.
 */
function spokeValues(values: Float32Array, descriptor: EngineDescriptor): number[] {
  const sig = patchSignature(values, descriptor);
  const all = normalisedAll(values, descriptor);
  const sampled = (slot: number): number => {
    if (all.length === 0) return 0.5;
    const i = Math.round((slot * (all.length - 1)) / 3);
    return safe01(all[i] ?? 0.5);
  };
  const raw = [
    sig.body, sampled(0),
    sig.air, sampled(1),
    sig.grit, sampled(2),
    sig.motion, sampled(3),
    sig.reach,
  ];

  /*
   * Scaled so the longest spoke reaches the rim.
   *
   * Without this, the mark is unreadable for most real patches: Analog's own
   * defaults sit at body 0.15, motion 0, so every spoke landed near the minimum
   * radius and the glyph drew a tiny lopsided tangle in the middle of the box.
   * Normalising makes the *proportions* between the axes the signal, which is
   * what a silhouette can actually carry — and proportion is the thing you
   * recognise a patch by. The 0.4 floor stops a near-silent patch being blown up
   * into a starburst by dividing by almost nothing.
   */
  let max = 0;
  for (const v of raw) if (v > max) max = v;
  const scale = 1 / Math.max(0.4, max);
  return raw.map((v) => safe01(v * scale));
}

/**
 * The mark. Nine spokes whose lengths are the patch's own parameter values, a
 * silhouette through their tips, a filled node on the longest, and one straight
 * cut across the whole form angled by Motion.
 *
 * Every coordinate lands inside a 0..100 box, so this drops into any SVG
 * viewBox without measurement, and every stroke is straight and flat — no
 * curves, no gradients, nothing to soften.
 */
export function sigilOf(values: Float32Array, descriptor: EngineDescriptor): Sigil {
  const lengths = spokeValues(values, descriptor);
  const spokes: Point[] = [];
  let node: Point = { x: CENTRE, y: CENTRE };
  let longest = -1;

  for (let i = 0; i < SPOKES; i++) {
    const n = safe01(lengths[i] ?? 0.5);
    const r = R_MIN + n * R_SPAN;
    const a = ((-90 + i * SPOKE_STEP) * Math.PI) / 180;
    const p = { x: snap(CENTRE + Math.cos(a) * r), y: snap(CENTRE + Math.sin(a) * r) };
    spokes.push(p);
    if (r > longest) { longest = r; node = p; }
  }

  // Off the raw Motion axis, not the scaled spoke: the cut's angle should mean
  // the same thing on every mark regardless of how the spokes were rescaled.
  const cutAngle = ((-70 + patchSignature(values, descriptor).motion * 140) * Math.PI) / 180;
  const cx = Math.cos(cutAngle) * CUT_REACH;
  const cy = Math.sin(cutAngle) * CUT_REACH;

  return {
    spokes,
    node,
    cut: {
      x1: snap(CENTRE - cx), y1: snap(CENTRE - cy),
      x2: snap(CENTRE + cx), y2: snap(CENTRE + cy),
    },
  };
}
