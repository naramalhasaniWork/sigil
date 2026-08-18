import type { EngineDescriptor, ParamDescriptor } from '@/audio/types';
import { normalise } from '@/dsp/mutation';

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

interface Polarity { readonly adj: readonly string[]; readonly noun: readonly string[] }
interface AxisWords { readonly high: Polarity; readonly low: Polarity }

/**
 * The vocabulary. Materials, weather and architecture only: nothing jokey, no
 * adjectives pressed into service as nouns, nothing that will read as a random
 * word generator in six months. The adjective comes from the patch's most
 * extreme axis and the noun from its second, so the two words are never
 * describing the same thing twice.
 */
const AXIS_WORDS: readonly AxisWords[] = [
  { // body
    high: { adj: ['Heavy', 'Deep', 'Leaden', 'Thick', 'Sunken'], noun: ['Slab', 'Hull', 'Anvil', 'Stone', 'Girder'] },
    low: { adj: ['Thin', 'Hollow', 'Bare', 'Faint', 'Narrow'], noun: ['Thread', 'Reed', 'Wire', 'Husk', 'Paper'] },
  },
  { // air
    high: { adj: ['Bright', 'Silver', 'Keen', 'Pale', 'Open'], noun: ['Halo', 'Sheen', 'Frost', 'Chrome', 'Spire'] },
    low: { adj: ['Dim', 'Dusk', 'Muted', 'Umber', 'Shuttered'], noun: ['Shade', 'Wool', 'Peat', 'Cellar', 'Loam'] },
  },
  { // grit
    high: { adj: ['Rusted', 'Burnt', 'Scarred', 'Coarse', 'Charred'], noun: ['Ash', 'Cinder', 'Tar', 'Slag', 'Grindstone'] },
    low: { adj: ['Clean', 'Smooth', 'Clear', 'Fine', 'Soft'], noun: ['Silk', 'Milk', 'Vellum', 'Salt', 'Ivory'] },
  },
  { // motion
    high: { adj: ['Drifting', 'Restless', 'Tidal', 'Wandering', 'Shivering'], noun: ['Tide', 'Swarm', 'Current', 'Pulse', 'Weather'] },
    low: { adj: ['Still', 'Fixed', 'Steady', 'Held', 'Quiet'], noun: ['Anchor', 'Slate', 'Column', 'Pane', 'Well'] },
  },
];

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

/** Which parameter a spoke reads, sampling evenly across the whole descriptor. */
function spokeParamIndex(i: number, count: number): number {
  if (count <= 1) return 0;
  return Math.round((i * (count - 1)) / (SPOKES - 1));
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
  const all = normalisedAll(values, descriptor);
  const spokes: Point[] = [];
  let node: Point = { x: CENTRE, y: CENTRE };
  let longest = -1;

  for (let i = 0; i < SPOKES; i++) {
    const n = safe01(all[spokeParamIndex(i, all.length)] ?? 0.5);
    const r = R_MIN + n * R_SPAN;
    const a = ((-90 + i * SPOKE_STEP) * Math.PI) / 180;
    const p = { x: CENTRE + Math.cos(a) * r, y: CENTRE + Math.sin(a) * r };
    spokes.push(p);
    if (r > longest) { longest = r; node = p; }
  }

  const sig = patchSignature(values, descriptor);
  const cutAngle = ((-70 + sig.motion * 140) * Math.PI) / 180;
  const cx = Math.cos(cutAngle) * CUT_REACH;
  const cy = Math.sin(cutAngle) * CUT_REACH;

  return {
    spokes,
    node,
    cut: { x1: CENTRE - cx, y1: CENTRE - cy, x2: CENTRE + cx, y2: CENTRE + cy },
  };
}
