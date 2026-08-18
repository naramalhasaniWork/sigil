import { describe, it, expect } from 'vitest';
import {
  CHORDS,
  SCALES,
  chordNotes,
  diatonicChord,
  noteName,
  scaleNotes,
  voiceChord,
  type ChordQuality,
  type ScaleName,
} from '@/dsp/chords';

const ALL_SCALES = Object.keys(SCALES) as ScaleName[];

function pitchClasses(notes: readonly number[]): Set<number> {
  return new Set(notes.map((n) => ((n % 12) + 12) % 12));
}

describe('SCALES', () => {
  it('has the textbook interval sets', () => {
    expect(SCALES.major).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(SCALES.minor).toEqual([0, 2, 3, 5, 7, 8, 10]);
    expect(SCALES.dorian).toEqual([0, 2, 3, 5, 7, 9, 10]);
    expect(SCALES.phrygian).toEqual([0, 1, 3, 5, 7, 8, 10]);
    expect(SCALES.lydian).toEqual([0, 2, 4, 6, 7, 9, 11]);
    expect(SCALES.mixolydian).toEqual([0, 2, 4, 5, 7, 9, 10]);
    expect(SCALES.harmonicMinor).toEqual([0, 2, 3, 5, 7, 8, 11]);
    expect(SCALES.pentatonicMinor).toEqual([0, 3, 5, 7, 10]);
    expect(SCALES.wholeTone).toEqual([0, 2, 4, 6, 8, 10]);
    expect(SCALES.chromatic).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('is strictly ascending and stays inside one octave', () => {
    for (const name of ALL_SCALES) {
      const steps = SCALES[name];
      expect(steps[0]).toBe(0);
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i]!).toBeGreaterThan(steps[i - 1]!);
      }
      expect(steps[steps.length - 1]!).toBeLessThan(12);
    }
  });
});

describe('CHORDS', () => {
  it('has the textbook interval sets', () => {
    expect(CHORDS.maj).toEqual([0, 4, 7]);
    expect(CHORDS.min).toEqual([0, 3, 7]);
    expect(CHORDS.dim).toEqual([0, 3, 6]);
    expect(CHORDS.aug).toEqual([0, 4, 8]);
    expect(CHORDS.maj7).toEqual([0, 4, 7, 11]);
    expect(CHORDS.min7).toEqual([0, 3, 7, 10]);
    expect(CHORDS.dom7).toEqual([0, 4, 7, 10]);
    expect(CHORDS.sus2).toEqual([0, 2, 7]);
    expect(CHORDS.sus4).toEqual([0, 5, 7]);
    expect(CHORDS.add9).toEqual([0, 4, 7, 14]);
    expect(CHORDS.min9).toEqual([0, 3, 7, 10, 14]);
    expect(CHORDS.maj9).toEqual([0, 4, 7, 11, 14]);
  });

  it('every quality has a distinct shape', () => {
    const shapes = Object.values(CHORDS).map((c) => c.join(','));
    expect(new Set(shapes).size).toBe(shapes.length);
  });
});

describe('chordNotes', () => {
  it('transposes the shape onto the root', () => {
    expect(chordNotes(60, 'maj')).toEqual([60, 64, 67]);
    expect(chordNotes(62, 'min')).toEqual([62, 65, 69]);
    expect(chordNotes(67, 'dom7')).toEqual([67, 71, 74, 77]);
    expect(chordNotes(60, 'maj9')).toEqual([60, 64, 67, 71, 74]);
  });
});

describe('scaleNotes', () => {
  it('walks one octave of C major', () => {
    expect(scaleNotes(60, 'major', 8)).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
  });

  it('stays in scale across octave boundaries', () => {
    for (const name of ALL_SCALES) {
      const allowed = pitchClasses(SCALES[name].map((s) => s + 60));
      const notes = scaleNotes(60, name, 40);
      expect(notes).toHaveLength(40);
      for (const note of notes) {
        expect(allowed.has(((note % 12) + 12) % 12)).toBe(true);
      }
      for (let i = 1; i < notes.length; i++) {
        expect(notes[i]!).toBeGreaterThan(notes[i - 1]!);
      }
    }
  });

  it('repeats the pattern exactly one octave up', () => {
    const notes = scaleNotes(57, 'pentatonicMinor', 10);
    for (let i = 0; i < 5; i++) {
      expect(notes[i + 5]!).toBe(notes[i]! + 12);
    }
  });

  it('handles a zero count', () => {
    expect(scaleNotes(60, 'major', 0)).toEqual([]);
  });
});

describe('diatonicChord', () => {
  it('produces maj min min maj maj min dim for the major scale', () => {
    const expected: ChordQuality[] = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'];
    const actual = expected.map((_, degree) => diatonicChord(60, 'major', degree).quality);
    expect(actual).toEqual(expected);
  });

  it('produces min dim maj min min maj maj for the natural minor scale', () => {
    const expected: ChordQuality[] = ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj'];
    const actual = expected.map((_, degree) => diatonicChord(57, 'minor', degree).quality);
    expect(actual).toEqual(expected);
  });

  it('finds the augmented triad on degree 2 of harmonic minor', () => {
    expect(diatonicChord(57, 'harmonicMinor', 2).quality).toBe('aug');
  });

  it('labels chords the way a player reads them', () => {
    expect(diatonicChord(60, 'major', 0).label).toBe('C');
    expect(diatonicChord(60, 'major', 1).label).toBe('Dm');
    expect(diatonicChord(60, 'major', 6).label).toBe('Bdim');
    expect(diatonicChord(60, 'mixolydian', 4).label).toBe('Gm');
  });

  it('stacks thirds inside the scale, never outside it', () => {
    for (const name of ALL_SCALES) {
      const allowed = pitchClasses(SCALES[name].map((s) => s + 60));
      for (let degree = 0; degree < 16; degree++) {
        const chord = diatonicChord(60, name, degree);
        expect(chord.notes).toHaveLength(3);
        for (const note of chord.notes) {
          expect(allowed.has(((note % 12) + 12) % 12)).toBe(true);
        }
        expect(chord.notes[1]!).toBeGreaterThan(chord.notes[0]!);
        expect(chord.notes[2]!).toBeGreaterThan(chord.notes[1]!);
        expect(chord.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('climbs an octave when the degree passes the end of the scale', () => {
    const low = diatonicChord(60, 'major', 0);
    const high = diatonicChord(60, 'major', 7);
    expect(high.quality).toBe(low.quality);
    expect(high.notes).toEqual(low.notes.map((n) => n + 12));
  });
});

describe('voiceChord', () => {
  const cases: readonly number[][] = [
    [60, 64, 67],
    [62, 65, 69, 72],
    [60, 64, 67, 71, 74],
    [60, 60, 67],
    [48, 55, 64],
  ];

  it('returns close position at spread 0', () => {
    expect(voiceChord([60, 64, 67], 0)).toEqual([60, 64, 67]);
    expect(voiceChord([67, 60, 64], 0)).toEqual([60, 64, 67]);
  });

  it('never duplicates a pitch and preserves the pitch-class set', () => {
    for (const chord of cases) {
      for (const spread of [0, 0.25, 0.5, 0.75, 1, 1.5, 3]) {
        const voiced = voiceChord(chord, spread);
        expect(new Set(voiced).size).toBe(voiced.length);
        expect(voiced.length).toBe(chord.length);
        expect([...pitchClasses(voiced)].sort()).toEqual([...pitchClasses(chord)].sort());
      }
    }
  });

  it('opens the chord up as spread rises', () => {
    const close = voiceChord([60, 64, 67], 0);
    const open = voiceChord([60, 64, 67], 1);
    const range = (n: readonly number[]): number => n[n.length - 1]! - n[0]!;
    expect(range(open)).toBeGreaterThan(range(close));
  });

  it('keeps every voice in MIDI range and sorted ascending', () => {
    for (const chord of cases) {
      for (const spread of [0, 1, 3, 10]) {
        const voiced = voiceChord(chord, spread);
        for (let i = 0; i < voiced.length; i++) {
          expect(voiced[i]!).toBeGreaterThanOrEqual(0);
          expect(voiced[i]!).toBeLessThanOrEqual(127);
          if (i > 0) expect(voiced[i]!).toBeGreaterThan(voiced[i - 1]!);
        }
      }
    }
  });

  it('handles empty and single-note input', () => {
    expect(voiceChord([], 1)).toEqual([]);
    expect(voiceChord([60], 2)).toEqual([60]);
  });

  it('treats negative spread as close position', () => {
    expect(voiceChord([60, 64, 67], -5)).toEqual([60, 64, 67]);
  });
});

describe('noteName', () => {
  it('maps middle C and A440 the way players expect', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(69)).toBe('A4');
  });

  it('names accidentals and octave edges', () => {
    expect(noteName(61)).toBe('C#4');
    expect(noteName(59)).toBe('B3');
    expect(noteName(72)).toBe('C5');
    expect(noteName(0)).toBe('C-1');
    expect(noteName(127)).toBe('G9');
  });
});
