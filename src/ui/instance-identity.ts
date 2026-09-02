/**
 * Telling one SIGIL from another.
 *
 * Six tracks, six SIGILs, and every window is the same window: the same
 * wordmark, the same layout, and — in a DAW — the same device title, because
 * VST3 gives a plugin no per-instance say over that. So nothing on screen
 * answers "which one am I looking at", and nothing answers "which one made that
 * sound" either.
 *
 * The plugin deals each instance a MARK in order of creation and persists it
 * with the patch. This turns that number into something a person can use: a
 * name to say out loud and a colour to find across a screen. A player who
 * renames one gets their name instead; the dealt one is only ever the default,
 * so two instances never look alike out of the box.
 *
 * Why a fixed table rather than a hash of the mark: two adjacent instances must
 * never collide, and 1 and 2 must never come out as near-identical colours.
 * Walking a list guarantees both. The words are the instrument's own
 * vocabulary — materials and weather, see dsp/sigil-words.ts — because a SIGIL
 * called "Instance 3" is a row in a table and one called "Flint" is a voice in
 * a mix.
 */

export interface InstanceIdentity {
  /** The dealt name. Short enough to be read at 10px in a header. */
  readonly name: string;
  /**
   * The accent. Used ONLY for the instance badge: the rest of the interface
   * stays coloured by engine, because which engine you are on is the other
   * thing you need to know at a glance and overwriting it would trade one kind
   * of confusion for another.
   *
   * All ten are light enough to carry the page's own ground colour as text on
   * top of them, which is how the badge is drawn.
   */
  readonly tint: string;
}

/**
 * Ten, and then it repeats.
 *
 * Ten because a project with more than ten SIGILs in it has a different problem
 * than this file solves, and because past ten the hues start being ones you have
 * to compare side by side rather than recognise.
 */
export const INSTANCE_IDENTITIES: readonly InstanceIdentity[] = [
  { name: 'Ember', tint: '#FF7A3C' },
  { name: 'Frost', tint: '#7FD8FF' },
  { name: 'Bramble', tint: '#6FCF97' },
  { name: 'Cobalt', tint: '#6C8CFF' },
  { name: 'Saffron', tint: '#FFC53D' },
  { name: 'Cinnabar', tint: '#FF5E7A' },
  { name: 'Iris', tint: '#B58CFF' },
  { name: 'Patina', tint: '#35C4A6' },
  { name: 'Quartz', tint: '#E7E1D3' },
  { name: 'Peat', tint: '#C08552' },
];

/**
 * The identity for a mark. Any integer, including a negative one out of a
 * corrupt patch, lands on a real entry rather than `undefined`.
 */
export function identityFor(mark: number): InstanceIdentity {
  const n = INSTANCE_IDENTITIES.length;
  if (!Number.isFinite(mark)) return INSTANCE_IDENTITIES[0] as InstanceIdentity;
  const i = ((Math.trunc(mark) % n) + n) % n;
  return INSTANCE_IDENTITIES[i] as InstanceIdentity;
}

/** What to draw: the player's name if they gave one, otherwise the dealt one. */
export function instanceLabel(mark: number, given: string): string {
  const trimmed = given.trim();
  return trimmed.length > 0 ? trimmed : identityFor(mark).name;
}
