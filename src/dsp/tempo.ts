/**
 * Note divisions, and the arithmetic that turns a tempo into a delay time or an
 * LFO rate.
 *
 * This is deliberately a CONTROL-layer module rather than a DSP one. Sync could
 * have been built into FxChain — hold a bpm, branch inside process() — but it
 * does not need to be: `delay-time` is already a parameter in milliseconds and
 * `lfo-rate` is already one in hertz, so syncing is a matter of computing the
 * right number and writing it to the parameter that exists. Nothing in the
 * render loop has to learn about tempo, no parameter is added, and no saved
 * patch changes meaning.
 *
 * That also means it costs nothing in the C++ port: the plugin's host layer
 * does the same arithmetic against the DAW's transport and writes the same
 * parameter.
 */

/** A division of a bar, expressed as a multiple of a whole note. */
export interface Division {
  readonly id: string;
  /** Shown on the control. */
  readonly label: string;
  /**
   * Length in whole notes. A quarter note is 0.25; a dotted eighth is 0.1875
   * (an eighth and a half); an eighth triplet is 1/12 (three in the space of a
   * quarter).
   */
  readonly whole: number;
}

/**
 * Straight, dotted and triplet, from a bar down to a thirty-second.
 *
 * Ordered strictly long to short by actual duration, which interleaves the
 * three families rather than grouping them: a dotted quarter (0.375) really is
 * longer than a half triplet (0.333), and a picker that claimed otherwise would
 * put the times out of order under the labels. Kept to the divisions people
 * reach for — a 1/64 triplet delay is a number, not a musical decision.
 */
export const DIVISIONS: readonly Division[] = [
  { id: '1/1', label: '1 bar', whole: 1 },
  { id: '1/2d', label: '1/2.', whole: 0.75 },
  { id: '1/2', label: '1/2', whole: 0.5 },
  { id: '1/4d', label: '1/4.', whole: 0.375 },
  { id: '1/2t', label: '1/2T', whole: 1 / 3 },
  { id: '1/4', label: '1/4', whole: 0.25 },
  { id: '1/8d', label: '1/8.', whole: 0.1875 },
  { id: '1/4t', label: '1/4T', whole: 1 / 6 },
  { id: '1/8', label: '1/8', whole: 0.125 },
  { id: '1/16d', label: '1/16.', whole: 0.09375 },
  { id: '1/8t', label: '1/8T', whole: 1 / 12 },
  { id: '1/16', label: '1/16', whole: 0.0625 },
  { id: '1/16t', label: '1/16T', whole: 1 / 24 },
  { id: '1/32', label: '1/32', whole: 0.03125 },
];

export const DEFAULT_DIVISION_ID = '1/8d';

export function divisionById(id: string): Division | undefined {
  return DIVISIONS.find((d) => d.id === id);
}

/**
 * Milliseconds per whole note. Everything else is a multiple of this.
 *
 * A "whole note" here means four beats, which is the convention every DAW's
 * delay uses — 1/4 at 120 BPM is 500 ms in Ableton, and it must be 500 ms here
 * too or synced delays will not line up with the project. Note that this is
 * therefore NOT bar length in anything other than 4/4: in 3/4 a bar is three
 * beats, but a 1/4 note is still 500 ms. Those are different questions and
 * conflating them is the usual bug.
 */
function wholeNoteMs(bpm: number): number {
  return (60000 / bpm) * 4;
}

/** Delay time in milliseconds for a division at a tempo. */
export function divisionMs(bpm: number, whole: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(whole) || whole <= 0) return 0;
  return wholeNoteMs(bpm) * whole;
}

/**
 * LFO rate in hertz for a division — one full cycle per division.
 *
 * A 1/4 LFO at 120 BPM is 2 Hz: two cycles a second, one per beat. Getting this
 * reciprocal backwards produces something that sounds vaguely rhythmic and is
 * never actually in time, which is worse than being obviously wrong.
 */
export function divisionHz(bpm: number, whole: number): number {
  const ms = divisionMs(bpm, whole);
  return ms <= 0 ? 0 : 1000 / ms;
}

/**
 * The division whose time is closest to a free-running value, so switching sync
 * on lands somewhere near what you were already hearing rather than jumping.
 *
 * Compares in the log domain: musically, 200 ms against 100 ms is the same
 * distance as 800 against 400, and a linear comparison would bias every choice
 * toward the longest divisions.
 */
export function nearestDivision(ms: number, bpm: number): Division {
  const fallback = divisionById(DEFAULT_DIVISION_ID) as Division;
  if (!Number.isFinite(ms) || ms <= 0 || !Number.isFinite(bpm) || bpm <= 0) return fallback;

  let best = fallback;
  let bestErr = Number.POSITIVE_INFINITY;
  for (const d of DIVISIONS) {
    const candidate = divisionMs(bpm, d.whole);
    if (candidate <= 0) continue;
    const err = Math.abs(Math.log(candidate / ms));
    if (err < bestErr) { bestErr = err; best = d; }
  }
  return best;
}

/**
 * Clamps a synced value into what the parameter can actually hold.
 *
 * A 1-bar delay at 40 BPM is 6000 ms and `delay-time` stops at 2000. Without
 * this the value is silently clamped somewhere downstream and the delay is no
 * longer in time — which looks like a sync bug rather than a range limit. The
 * caller gets told, so the UI can say so.
 */
export interface SyncedValue {
  readonly value: number;
  /** True when the division does not fit the parameter's range at this tempo. */
  readonly outOfRange: boolean;
}

export function clampSynced(value: number, min: number, max: number): SyncedValue {
  if (!Number.isFinite(value)) return { value: min, outOfRange: true };
  if (value < min) return { value: min, outOfRange: true };
  if (value > max) return { value: max, outOfRange: true };
  return { value, outOfRange: false };
}
