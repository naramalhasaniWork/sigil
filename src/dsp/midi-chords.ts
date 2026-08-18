/**
 * What one incoming MIDI note actually plays.
 *
 * A controller sends single notes. SIGIL can answer with a chord, so a cheap
 * 25-key keyboard becomes a pad instrument: press one key, hear a voicing that
 * belongs to the key you set. All the theory lives in `@/dsp/chords` — this
 * file only decides which chord the incoming note asks for, and guarantees the
 * note-off can be reconstructed exactly.
 *
 * Pure: MIDI numbers in, MIDI numbers out. No audio, no DOM, no state.
 */

import {
  SCALES,
  chordNotes,
  diatonicChord,
  voiceChord,
  type ChordQuality,
  type ScaleName,
} from '@/dsp/chords';

export type PadChordMode = 'off' | 'scale-degree' | 'fixed-quality';

export interface PadChordConfig {
  /**
   * `off` plays what was pressed. `scale-degree` reads the note as a degree of
   * the chosen key and answers with that key's diatonic chord, so every note is
   * in tune with every other. `fixed-quality` stacks the same shape on whatever
   * was pressed, which is how you get parallel chord playing.
   */
  mode: PadChordMode;
  /** Key centre. Any MIDI number — only its pitch class changes the result. */
  root: number;
  scale: ScaleName;
  /** Used by `fixed-quality` only. */
  quality: ChordQuality;
  /** 0 is close position; higher lifts upper voices by whole octaves. */
  voicingSpread: number;
  /**
   * Split-keyboard point. Notes BELOW this number expand to chords, notes at or
   * above it play single, so the left hand comps and the right hand plays lead.
   * `null` means the whole keyboard expands.
   */
  octaveSplit: number | null;
}

export const DEFAULT_PAD_CHORDS: PadChordConfig = {
  mode: 'off',
  root: 60,
  scale: 'minor',
  quality: 'min7',
  voicingSpread: 0,
  octaveSplit: null,
};

const MIN_MIDI = 0;
const MAX_MIDI = 127;

/**
 * Which degree of the scale this note is. Notes that are not in the scale snap
 * down to the nearest degree below them, which is what a player expects: a
 * black key between two scale tones comps as the chord underneath it rather
 * than throwing an out-of-key chord.
 */
function scaleDegree(midi: number, root: number, scale: ScaleName): number {
  const steps = SCALES[scale];
  const interval = (((midi - root) % 12) + 12) % 12;
  let degree = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step === undefined) continue;
    if (step <= interval) degree = i;
  }
  return degree;
}

/** Drop anything a synth cannot play, and never hand back an empty chord. */
function playable(notes: readonly number[], fallback: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n === undefined) continue;
    if (n >= MIN_MIDI && n <= MAX_MIDI) out.push(n);
  }
  return out.length > 0 ? out : [fallback];
}

/**
 * The single source of truth for both note-on and note-off. Deliberately does
 * not see velocity: if loudness could change which notes come out, a note-off
 * arriving at a different velocity would release the wrong set and the chord
 * would hang forever.
 */
function expand(midi: number, cfg: PadChordConfig): number[] {
  if (cfg.mode === 'off') return [midi];
  // The split note itself belongs to the lead half.
  if (cfg.octaveSplit !== null && midi >= cfg.octaveSplit) return [midi];

  if (cfg.mode === 'fixed-quality') {
    return playable(voiceChord(chordNotes(midi, cfg.quality), cfg.voicingSpread), midi);
  }

  // Degree first, octave second: the chord is built once at the key centre and
  // then moved to the octave that was actually played.
  const octave = Math.floor((midi - cfg.root) / 12);
  const degree = scaleDegree(midi, cfg.root, cfg.scale);
  const chord = diatonicChord(cfg.root, cfg.scale, degree);
  const shifted: number[] = [];
  for (let i = 0; i < chord.notes.length; i++) {
    const n = chord.notes[i];
    if (n === undefined) continue;
    shifted.push(n + octave * 12);
  }
  return playable(voiceChord(shifted, cfg.voicingSpread), midi);
}

/**
 * The notes to sound for an incoming note-on. `velocity` is accepted so callers
 * can pass the message straight through, and is intentionally ignored when
 * choosing pitches — see `expand`.
 */
export function expandIncomingNote(
  midi: number,
  velocity: number,
  cfg: PadChordConfig,
): number[] {
  void velocity;
  return expand(midi, cfg);
}

/**
 * The notes to release for an incoming note-off. Returns exactly what
 * `expandIncomingNote` returned for the same note and config; anything less and
 * voices are left running with no way to stop them.
 */
export function collapseNoteOff(midi: number, cfg: PadChordConfig): number[] {
  return expand(midi, cfg);
}
