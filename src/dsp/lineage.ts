import type { EngineDescriptor, ParamDescriptor } from '@/audio/types';
import { normalise } from '@/dsp/mutation';

/**
 * Hunt, in words.
 *
 * A grid of six mutations is a slot machine until you can read which way each
 * one went. Everything here turns a pair of patches into the one or two things
 * that actually changed, phrased the way a player would say them — "brighter",
 * "longer tail", "looser" — so a hunt becomes a menu of directions instead of
 * six identical bar charts.
 *
 * The same words then assemble the lineage trail, which is why these live in one
 * module: the story of how a patch was found is literally the list of moves that
 * found it.
 */

export interface Move {
  /** Player-facing phrase, e.g. "Brighter". */
  label: string;
  /** Size of the move in normalised space, 0..1. Used only for ranking. */
  magnitude: number;
}

interface WordPair {
  readonly match: RegExp;
  /** Phrase when the value went UP. */
  readonly up: string;
  /** Phrase when the value went DOWN. */
  readonly down: string;
}

/**
 * Only parameters with a *better word than their own name* appear here.
 * Everything else falls through to "More Reverb Mix" / "Less Drive Tone", which
 * is already readable because every parameter is named in plain language.
 *
 * Order is specific-to-general and it matters: `delay-feedback` must reach the
 * delay entry before the generic feedback entry, or a longer echo gets described
 * as "metallic".
 */
const WORDS: readonly WordPair[] = [
  // Envelope — the most common movers, and the ones players describe by feel.
  { match: /attack/, up: 'Softer attack', down: 'Harder attack' },
  { match: /release/, up: 'Longer tail', down: 'Shorter tail' },
  { match: /sustain/, up: 'Fuller sustain', down: 'Drier sustain' },
  // Effect families, before the generic engine words they contain.
  { match: /freeze|suspend/, up: 'More suspended', down: 'Less suspended' },
  { match: /shimmer|bloom|regeneration/, up: 'More bloom', down: 'Less bloom' },
  { match: /shift|alien|ring/, up: 'Stranger', down: 'Plainer' },
  { match: /vowel|speak/, up: 'More vocal', down: 'Less vocal' },
  { match: /stutter|slice/, up: 'More broken', down: 'Steadier' },
  { match: /tape|wear|wow|flutter/, up: 'More worn', down: 'Cleaner tape' },
  { match: /delay|echo/, up: 'More echo', down: 'Less echo' },
  { match: /reverb/, up: 'Bigger space', down: 'Tighter space' },
  { match: /chorus/, up: 'Wider', down: 'Narrower' },
  // Engine character.
  { match: /cutoff/, up: 'Brighter', down: 'Darker' },
  { match: /resonance/, up: 'Sharper', down: 'Rounder' },
  { match: /decay/, up: 'Longer decay', down: 'Shorter decay' },
  { match: /drive|crush|bits|downsample/, up: 'Dirtier', down: 'Cleaner' },
  { match: /drift|wobble/, up: 'Looser', down: 'Tighter' },
  { match: /detune|spread|unison/, up: 'Wider', down: 'Narrower' },
  { match: /damping/, up: 'Deader', down: 'Livelier' },
  { match: /index|feedback/, up: 'Metallic', down: 'Purer' },
  { match: /density|grain/, up: 'Denser', down: 'Sparser' },
  { match: /scatter|spray/, up: 'More scattered', down: 'Steadier' },
  { match: /noise/, up: 'Breathier', down: 'Purer' },
  { match: /sub|heavy/, up: 'Heavier', down: 'Lighter' },
  { match: /hardness|material/, up: 'Harder', down: 'Softer' },
  { match: /glide/, up: 'More glide', down: 'Less glide' },
  { match: /\bair\b/, up: 'Airier', down: 'Drier' },
  { match: /lfo/, up: 'More movement', down: 'Less movement' },
  { match: /position/, up: 'Off-centre', down: 'Centred' },
  // Stepped shape switches have no direction worth naming, only a change.
  { match: /wave|table|window|shape|model|exciter|algorithm|loop-mode|reverse/, up: 'Reshaped', down: 'Reshaped' },
];

/** How this parameter moving in this direction should be described. */
export function moveLabel(p: ParamDescriptor, delta: number): string {
  const key = `${p.id} ${p.name}`.toLowerCase();
  for (const w of WORDS) {
    if (w.match.test(key)) return delta >= 0 ? w.up : w.down;
  }
  return `${delta >= 0 ? 'More' : 'Less'} ${p.name}`;
}

/** Anything smaller than this is inaudible next to the movers, so it is noise. */
const MOVE_FLOOR = 0.06;

function valueAt(values: Float32Array, i: number, p: ParamDescriptor): number {
  const raw = values[i];
  return raw === undefined ? p.default : raw;
}

/**
 * Every meaningful difference between two patches, largest first.
 *
 * Ranked by distance in NORMALISED space, which is the only fair comparison: a
 * 500 Hz cutoff move and a 0.2 drive move are not comparable in their own units,
 * but they are once each is expressed as a fraction of its own musical range.
 */
export function rankedMoves(
  from: Float32Array,
  to: Float32Array,
  descriptor: EngineDescriptor,
  floor: number = MOVE_FLOOR,
): Move[] {
  const out: Move[] = [];
  for (let i = 0; i < descriptor.params.length; i++) {
    const p = descriptor.params[i];
    if (p === undefined) continue;
    const a = normalise(valueAt(from, i, p), p);
    const b = normalise(valueAt(to, i, p), p);
    const delta = b - a;
    if (!Number.isFinite(delta)) continue;
    const magnitude = Math.abs(delta);
    if (magnitude < floor) continue;
    out.push({ label: moveLabel(p, delta), magnitude });
  }
  out.sort((x, y) => y.magnitude - x.magnitude);
  return out;
}

/**
 * The best few phrases from a set of moves, deduplicated.
 *
 * Deduplication matters more than it sounds: mutating five envelope parameters
 * at once would otherwise fill a card with "Longer tail, Longer tail". The
 * largest instance of a phrase wins and the rest are dropped, so two words on a
 * card describe two different things.
 */
export function topLabels(moves: readonly Move[], limit = 2): string[] {
  const sorted = [...moves].sort((x, y) => y.magnitude - x.magnitude);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of sorted) {
    if (out.length >= limit) break;
    if (seen.has(m.label)) continue;
    seen.add(m.label);
    out.push(m.label);
  }
  return out;
}

/** Steps kept in a trail before the oldest are forgotten entirely. */
const TRAIL_CAP = 12;

/** Adds a step, dropping the oldest once the trail is long enough to be a log. */
export function appendStep(
  steps: readonly string[],
  label: string,
  cap: number = TRAIL_CAP,
): string[] {
  const trimmed = label.trim();
  if (trimmed === '') return [...steps];
  const next = [...steps, trimmed];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Visible steps in the trail. Beyond this it stops being a sentence. */
const TRAIL_VISIBLE = 4;

/**
 * The trail, as one line: `Glass Bell → brighter → longer tail → bred`.
 *
 * `tentative` is the step you are only auditioning. It renders as part of the
 * trail but is not committed, so clicking through siblings SWAPS the last word
 * instead of piling six of them up — a sibling is a lateral move, not a step
 * deeper, and the trail should say so.
 */
export function renderTrail(
  steps: readonly string[],
  tentative: string | null = null,
  visible: number = TRAIL_VISIBLE,
): string {
  const all = tentative === null || tentative.trim() === ''
    ? [...steps]
    : [...steps, tentative.trim()];
  if (all.length === 0) return '';
  if (all.length <= visible) return all.join(' → ');
  return `… → ${all.slice(all.length - visible).join(' → ')}`;
}
