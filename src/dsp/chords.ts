/**
 * Pure music theory. No audio, no DOM — every note here is a MIDI number, so
 * the tuning table decides what a "note" actually sounds like.
 */

export type ScaleName =
  | 'major'
  | 'minor'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'harmonicMinor'
  | 'pentatonicMinor'
  | 'wholeTone'
  | 'chromatic';

export type ChordQuality =
  | 'maj'
  | 'min'
  | 'dim'
  | 'aug'
  | 'maj7'
  | 'min7'
  | 'dom7'
  | 'sus2'
  | 'sus4'
  | 'add9'
  | 'min9'
  | 'maj9';

/** Semitone offsets from the root, one octave, ascending. */
export const SCALES: Readonly<Record<ScaleName, readonly number[]>> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  pentatonicMinor: [0, 3, 5, 7, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/** Semitone offsets from the root, close position. */
export const CHORDS: Readonly<Record<ChordQuality, readonly number[]>> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  add9: [0, 4, 7, 14],
  min9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
};

const SUFFIX: Readonly<Record<ChordQuality, string>> = {
  maj: '',
  min: 'm',
  dim: 'dim',
  aug: 'aug',
  maj7: 'maj7',
  min7: 'm7',
  dom7: '7',
  sus2: 'sus2',
  sus4: 'sus4',
  add9: 'add9',
  min9: 'm9',
  maj9: 'maj9',
};

const PITCH_NAMES: readonly string[] = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];

const SHAPE_TO_QUALITY = new Map<string, ChordQuality>(
  (Object.keys(CHORDS) as ChordQuality[]).map((q) => [CHORDS[q].join(','), q]),
);

function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

/** e.g. 60 -> "C4", 69 -> "A4". */
export function noteName(midi: number): string {
  const rounded = Math.round(midi);
  return `${PITCH_NAMES[pitchClass(rounded)] ?? 'C'}${Math.floor(rounded / 12) - 1}`;
}

function pitchName(midi: number): string {
  return PITCH_NAMES[pitchClass(Math.round(midi))] ?? 'C';
}

/**
 * `count` ascending MIDI notes of the scale starting at `root`, wrapping into
 * higher octaves once the single-octave pattern runs out.
 */
export function scaleNotes(root: number, scale: ScaleName, count: number): number[] {
  const steps = SCALES[scale];
  const out: number[] = [];
  if (steps.length === 0) return out;
  for (let i = 0; i < count; i++) {
    const step = steps[i % steps.length] ?? 0;
    out.push(root + Math.floor(i / steps.length) * 12 + step);
  }
  return out;
}

export function chordNotes(root: number, quality: ChordQuality): number[] {
  return CHORDS[quality].map((offset) => root + offset);
}

/**
 * Name a stack of intervals. Exact matches win; anything the scale throws up
 * that is not a textbook shape (pentatonic, chromatic) falls back to the third
 * and fifth it does have, so a pad always has something honest to print.
 */
function identifyQuality(intervals: readonly number[]): ChordQuality {
  const exact = SHAPE_TO_QUALITY.get(intervals.join(','));
  if (exact !== undefined) return exact;
  const third = intervals[1] ?? 4;
  const fifth = intervals[2] ?? 7;
  if (third === 3 || third === 4) {
    if (fifth === 6) return 'dim';
    if (fifth === 8) return 'aug';
    return third === 3 ? 'min' : 'maj';
  }
  if (third === 2) return 'sus2';
  if (third === 5) return 'sus4';
  return 'maj';
}

/**
 * The chord on a scale degree (0-indexed), built by stacking thirds *within*
 * the scale — so degree 1 of major is minor, degree 6 is diminished. Degrees
 * past the end of the scale keep climbing into the next octave.
 */
export function diatonicChord(
  root: number,
  scale: ScaleName,
  degree: number,
): { notes: number[]; quality: ChordQuality; label: string } {
  const length = SCALES[scale].length;
  const start = degree < 0 ? ((degree % length) + length) % length : degree;
  const pool = scaleNotes(root, scale, start + 5);
  const base = pool[start] ?? root;
  const notes = [base, pool[start + 2] ?? base, pool[start + 4] ?? base];
  const quality = identifyQuality(notes.map((n) => n - base));
  return { notes, quality, label: `${pitchName(base)}${SUFFIX[quality]}` };
}

function placeUnique(candidate: number, used: ReadonlySet<number>): number {
  if (!used.has(candidate)) return candidate;
  for (let step = 1; step <= 10; step++) {
    const up = candidate + step * 12;
    if (up <= 127 && !used.has(up)) return up;
    const down = candidate - step * 12;
    if (down >= 0 && !used.has(down)) return down;
  }
  return candidate;
}

/**
 * Open the chord out. At `spread` 0 this is close position; as spread rises the
 * upper voices are lifted by whole octaves, which keeps the pitch-class set
 * identical while the voicing gets airier. Never returns a duplicate pitch.
 */
export function voiceChord(notes: readonly number[], spread: number): number[] {
  const sorted = [...notes].sort((a, b) => a - b);
  const amount = Math.max(0, spread);
  const used = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    const base = sorted[i];
    if (base === undefined) continue;
    let octaves = Math.min(3, Math.floor(amount * i));
    while (octaves > 0 && base + octaves * 12 > 127) octaves--;
    used.add(placeUnique(base + octaves * 12, used));
  }
  return [...used].sort((a, b) => a - b);
}
