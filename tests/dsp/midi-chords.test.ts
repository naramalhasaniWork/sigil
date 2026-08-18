import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PAD_CHORDS,
  collapseNoteOff,
  expandIncomingNote,
  type PadChordConfig,
} from '@/dsp/midi-chords';
import { CHORDS, type ChordQuality } from '@/dsp/chords';

const C4 = 60;

function cfg(patch: Partial<PadChordConfig> = {}): PadChordConfig {
  return { ...DEFAULT_PAD_CHORDS, ...patch };
}

const inKeyC = cfg({ mode: 'scale-degree', root: C4, scale: 'major' });

describe('off mode', () => {
  it('returns exactly the note that was pressed', () => {
    for (const note of [0, 21, 60, 61, 127]) {
      expect(expandIncomingNote(note, 1, cfg({ mode: 'off' }))).toEqual([note]);
    }
  });

  it('ignores key, shape and spread entirely', () => {
    const dressed = cfg({
      mode: 'off', root: 65, scale: 'lydian', quality: 'maj9', voicingSpread: 2,
    });
    expect(expandIncomingNote(C4, 0.5, dressed)).toEqual([C4]);
  });
});

describe('scale-degree mode', () => {
  it('builds the diatonic chord for each degree of C major', () => {
    // I ii iii IV V vi vii° — thirds stacked inside the scale.
    expect(expandIncomingNote(60, 1, inKeyC)).toEqual([60, 64, 67]); // C
    expect(expandIncomingNote(62, 1, inKeyC)).toEqual([62, 65, 69]); // Dm
    expect(expandIncomingNote(64, 1, inKeyC)).toEqual([64, 67, 71]); // Em
    expect(expandIncomingNote(65, 1, inKeyC)).toEqual([65, 69, 72]); // F
    expect(expandIncomingNote(67, 1, inKeyC)).toEqual([67, 71, 74]); // G
    expect(expandIncomingNote(69, 1, inKeyC)).toEqual([69, 72, 76]); // Am
    expect(expandIncomingNote(71, 1, inKeyC)).toEqual([71, 74, 77]); // Bdim
  });

  it('follows the octave the note was played in', () => {
    expect(expandIncomingNote(72, 1, inKeyC)).toEqual([72, 76, 79]);
    expect(expandIncomingNote(48, 1, inKeyC)).toEqual([48, 52, 55]);
    // Below the root: B3 is still the seventh degree, an octave down.
    expect(expandIncomingNote(59, 1, inKeyC)).toEqual([59, 62, 65]);
  });

  it('honours a minor key', () => {
    const inKeyA = cfg({ mode: 'scale-degree', root: 69, scale: 'minor' });
    expect(expandIncomingNote(69, 1, inKeyA)).toEqual([69, 72, 76]); // Am
    expect(expandIncomingNote(72, 1, inKeyA)).toEqual([72, 76, 79]); // C
  });

  it('snaps a note outside the scale down to the degree beneath it', () => {
    expect(expandIncomingNote(61, 1, inKeyC)).toEqual(expandIncomingNote(60, 1, inKeyC));
  });

  it('opens the voicing out without changing the chord', () => {
    const close = expandIncomingNote(60, 1, inKeyC);
    const open = expandIncomingNote(60, 1, cfg({ ...inKeyC, voicingSpread: 1 }));
    const pcs = (n: readonly number[]): Set<number> => new Set(n.map((x) => ((x % 12) + 12) % 12));
    expect(pcs(open)).toEqual(pcs(close));
    expect(Math.max(...open)).toBeGreaterThan(Math.max(...close));
  });

  it('never returns a note a synth cannot play', () => {
    for (let note = 0; note <= 127; note++) {
      for (const n of expandIncomingNote(note, 1, cfg({ ...inKeyC, voicingSpread: 2 }))) {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(127);
      }
    }
  });
});

describe('fixed-quality mode', () => {
  it('stacks the chosen intervals on whatever note arrived', () => {
    const qualities = Object.keys(CHORDS) as ChordQuality[];
    for (const quality of qualities) {
      const notes = expandIncomingNote(C4, 1, cfg({ mode: 'fixed-quality', quality }));
      expect(notes).toEqual([...CHORDS[quality]].map((i) => C4 + i).sort((a, b) => a - b));
    }
  });

  it('transposes with the note, ignoring the key', () => {
    const shape = cfg({ mode: 'fixed-quality', quality: 'min7', root: 65, scale: 'lydian' });
    expect(expandIncomingNote(60, 1, shape)).toEqual([60, 63, 67, 70]);
    expect(expandIncomingNote(67, 1, shape)).toEqual([67, 70, 74, 77]);
  });
});

describe('octave split', () => {
  const split = cfg({ mode: 'scale-degree', root: C4, scale: 'major', octaveSplit: C4 });

  it('expands notes below the split point', () => {
    expect(expandIncomingNote(48, 1, split)).toEqual([48, 52, 55]);
    expect(expandIncomingNote(59, 1, split)).toEqual([59, 62, 65]);
  });

  it('plays single notes at and above the split point', () => {
    expect(expandIncomingNote(60, 1, split)).toEqual([60]);
    expect(expandIncomingNote(64, 1, split)).toEqual([64]);
    expect(expandIncomingNote(84, 1, split)).toEqual([84]);
  });

  it('applies to fixed shapes too', () => {
    const fixed = cfg({ mode: 'fixed-quality', quality: 'maj', octaveSplit: C4 });
    expect(expandIncomingNote(55, 1, fixed)).toEqual([55, 59, 62]);
    expect(expandIncomingNote(60, 1, fixed)).toEqual([60]);
  });
});

describe('collapseNoteOff', () => {
  const configs: PadChordConfig[] = [
    cfg({ mode: 'off' }),
    inKeyC,
    cfg({ mode: 'scale-degree', root: 62, scale: 'dorian', voicingSpread: 1.5 }),
    cfg({ mode: 'scale-degree', root: 69, scale: 'pentatonicMinor' }),
    cfg({ mode: 'scale-degree', root: C4, scale: 'chromatic' }),
    cfg({ mode: 'fixed-quality', quality: 'maj9', voicingSpread: 0.5 }),
    cfg({ mode: 'fixed-quality', quality: 'sus4', octaveSplit: 60 }),
    cfg({ mode: 'scale-degree', root: C4, scale: 'harmonicMinor', octaveSplit: 72 }),
  ];

  it('releases exactly what the note-on opened, for every note and mode', () => {
    for (const config of configs) {
      for (let note = 0; note <= 127; note++) {
        expect(collapseNoteOff(note, config)).toEqual(expandIncomingNote(note, 1, config));
      }
    }
  });

  it('does not depend on velocity', () => {
    for (const config of configs) {
      for (const velocity of [0, 0.01, 0.5, 1]) {
        expect(expandIncomingNote(64, velocity, config)).toEqual(collapseNoteOff(64, config));
      }
    }
  });

  it('never leaves a note hanging because the chord came back empty', () => {
    for (const config of configs) {
      for (let note = 0; note <= 127; note++) {
        expect(collapseNoteOff(note, config).length).toBeGreaterThan(0);
      }
    }
  });
});
