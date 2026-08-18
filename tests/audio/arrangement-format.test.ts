import { describe, it, expect } from 'vitest';
import { PPQ } from '@/dsp/sequencer';
import { engineById } from '@/dsp/registry';
import {
  ARRANGEMENT_FORMAT_VERSION,
  loadArrangement,
  serialiseArrangement,
} from '@/audio/arrangement-format';
import type { SerialisedPatch } from '@/audio/patch-format';
import {
  MAX_TRACKS,
  addPattern,
  addTrack,
  createArrangement,
  placeClip,
  type Arrangement,
} from '@/dsp/arrangement';

/**
 * The recovery table in docs/design/arrangement-ia.md §3.6, row by row. A
 * tolerant loader without a test per row is a wish rather than a promise: the
 * difference between "my friend's song opened fine" and "my friend's song came
 * back two tracks shorter" lives entirely in this file.
 */

const ANALOG = engineById('analog');
const FIRST_PARAM = ANALOG?.descriptor.params[0]?.id ?? 'unknown';

/** A complete patch. A PARTIAL one is legal too, and warns — see below. */
function fullPatch(): Record<string, unknown> {
  const values: Record<string, number> = {};
  for (const param of ANALOG?.descriptor.params ?? []) values[param.id] = param.default;
  return { version: 2, engineId: 'analog', values };
}

function baseFile(): Record<string, unknown> {
  return {
    version: ARRANGEMENT_FORMAT_VERSION,
    id: 'song_test',
    name: 'Test Song',
    tempo: { bpm: 128, beatsPerBar: 4, ppq: PPQ },
    key: { root: 5, scale: 'dorian' },
    sections: [
      { id: 'sec_intro', name: 'Intro', bars: 2 },
      { id: 'sec_drop', name: 'Drop', bars: 4, repeats: 2 },
    ],
    tracks: [
      {
        id: 'track_bass',
        name: 'Bass',
        engineId: 'analog',
        patch: fullPatch(),
        gain: 0.7,
        pan: -0.2,
      },
    ],
    patterns: {
      pat_a: {
        id: 'pat_a',
        name: 'A',
        lengthBars: 1,
        beatsPerBar: 4,
        ppq: PPQ,
        notes: [
          { id: 'n1', midi: 36, velocity: 0.9, startTick: 0, durationTicks: 48, pass: 0 },
          { id: 'n2', midi: 43, velocity: 0.6, startTick: 192, durationTicks: 48 },
        ],
      },
    },
    clips: [
      { id: 'clip_1', trackId: 'track_bass', sectionId: 'sec_intro', patternId: 'pat_a' },
      {
        id: 'clip_2',
        trackId: 'track_bass',
        sectionId: 'sec_drop',
        patternId: 'pat_a',
        fill: 'once',
        transpose: -12,
      },
    ],
    master: { gain: 0.9 },
    savedAt: '2026-08-18T00:00:00.000Z',
  };
}

function load(raw: unknown) {
  const result = loadArrangement(raw);
  expect(result).not.toBeNull();
  if (result === null) throw new Error('unreachable');
  return result;
}

function warnedAbout(warnings: readonly string[], fragment: string): boolean {
  return warnings.some((line) => line.toLowerCase().includes(fragment.toLowerCase()));
}

describe('round trip', () => {
  it('survives load -> save -> load unchanged', () => {
    const first = load(baseFile());
    expect(first.warnings).toEqual([]);
    const saved = serialiseArrangement(first.arrangement);
    const second = load(saved);
    expect(second.warnings).toEqual([]);
    expect(JSON.stringify(serialiseArrangement(second.arrangement)))
      .toBe(JSON.stringify(saved));
    expect(saved.tempo).toEqual({ bpm: 128, beatsPerBar: 4, ppq: PPQ });
    expect(saved.key).toEqual({ root: 5, scale: 'dorian' });
    expect(saved.clips.find((c) => c.id === 'clip_2'))
      .toMatchObject({ fill: 'once', transpose: -12 });
  });

  it('keeps fields a newer build wrote, at every level, byte for byte', () => {
    const raw = baseFile();
    raw['automation'] = { lanes: [{ id: 'lane_1', points: [0, 1] }] };
    (raw['tracks'] as Record<string, unknown>[])[0]!['sidechain'] = 'track_kick';
    (raw['sections'] as Record<string, unknown>[])[0]!['timeSignature'] = '7/8';
    (raw['clips'] as Record<string, unknown>[])[0]!['warp'] = true;
    (raw['master'] as Record<string, unknown>)['limiter'] = 'brickwall';
    ((raw['patterns'] as Record<string, Record<string, unknown>>)['pat_a']!['notes'] as
      Record<string, unknown>[])[0]!['microtune'] = -14;

    const first = load(raw);
    expect(warnedAbout(first.warnings, 'unknown field')).toBe(true);
    const saved = serialiseArrangement(first.arrangement);
    expect(saved.meta?.['automation']).toEqual({ lanes: [{ id: 'lane_1', points: [0, 1] }] });
    expect(saved.tracks[0]?.meta?.['sidechain']).toBe('track_kick');
    expect(saved.sections[0]?.meta?.['timeSignature']).toBe('7/8');
    // Clips are written in a sorted order, so find the one that carried it.
    expect(saved.clips.find((c) => c.id === 'clip_1')?.meta?.['warp']).toBe(true);
    expect(saved.master?.meta?.['limiter']).toBe('brickwall');
    // Notes are numerous, so they are reported once per pattern and kept each.
    expect(saved.patterns['pat_a']?.notes[0]?.meta?.['microtune']).toBe(-14);
    expect(warnedAbout(first.warnings, 'on 1 note')).toBe(true);

    // Idempotent: a second lap through the loader must not move or lose it.
    const again = serialiseArrangement(load(saved).arrangement);
    expect(JSON.stringify(again)).toBe(JSON.stringify(saved));
  });

  it('ignores an unknown field rather than failing on it', () => {
    const raw = baseFile();
    raw['grooveTemplate'] = 'swing_58';
    const { arrangement, warnings } = load(raw);
    expect(arrangement.name).toBe('Test Song');
    expect(arrangement.tempo.bpm).toBe(128);
    expect(warnings).toHaveLength(1);
  });

  it('defaults a field an older build left out, and says so', () => {
    const raw = baseFile();
    const section = (raw['sections'] as Record<string, unknown>[])[0]!;
    delete section['bars'];
    delete raw['tempo'];
    const { arrangement, warnings } = load(raw);
    expect(arrangement.sections[0]?.bars).toBe(4);
    expect(arrangement.tempo).toEqual({ bpm: 120, beatsPerBar: 4, ppq: PPQ });
    expect(warnedAbout(warnings, 'no bars')).toBe(true);
    expect(warnedAbout(warnings, 'tempo')).toBe(true);
  });

  it('is deterministic: two saves of one song are identical text', () => {
    const a = load(baseFile()).arrangement;
    expect(JSON.stringify(serialiseArrangement(a)))
      .toBe(JSON.stringify(serialiseArrangement(a)));
  });

  it('orders clips and pattern keys itself, so a shuffled file still diffs cleanly', () => {
    const raw = baseFile();
    const shuffled = baseFile();
    shuffled['clips'] = [...(shuffled['clips'] as unknown[])].reverse();
    shuffled['patterns'] = {
      pat_z: { id: 'pat_z', lengthBars: 1, beatsPerBar: 4, ppq: PPQ, notes: [] },
      ...(shuffled['patterns'] as Record<string, unknown>),
    };
    (raw['patterns'] as Record<string, unknown>)['pat_z'] = {
      id: 'pat_z', lengthBars: 1, beatsPerBar: 4, ppq: PPQ, notes: [],
    };
    expect(JSON.stringify(serialiseArrangement(load(shuffled).arrangement)))
      .toBe(JSON.stringify(serialiseArrangement(load(raw).arrangement)));
  });

  it('never writes the runtime unplayable flag into the file', () => {
    const raw = baseFile();
    (raw['tracks'] as Record<string, unknown>[])[0]!['engineId'] = 'zither';
    const { arrangement } = load(raw);
    expect(arrangement.tracks[0]?.unplayable).toBeDefined();
    expect('unplayable' in (serialiseArrangement(arrangement).tracks[0] ?? {})).toBe(false);
  });

  it('takes savedAt from the caller rather than the clock', () => {
    const a = load(baseFile()).arrangement;
    expect(serialiseArrangement(a, '2027-01-01T00:00:00.000Z').savedAt)
      .toBe('2027-01-01T00:00:00.000Z');
    expect(serialiseArrangement(a).savedAt).toBe('2026-08-18T00:00:00.000Z');
  });
});

describe('recovery', () => {
  it('returns null when the payload is not an object, exactly like loadPatch', () => {
    expect(loadArrangement(null)).toBeNull();
    expect(loadArrangement('song')).toBeNull();
    expect(loadArrangement([1, 2, 3])).toBeNull();
  });

  it('warns about a newer format version and still loads what it understands', () => {
    const raw = baseFile();
    raw['version'] = ARRANGEMENT_FORMAT_VERSION + 5;
    const { arrangement, warnings } = load(raw);
    expect(warnedAbout(warnings, 'newer build')).toBe(true);
    expect(arrangement.tracks).toHaveLength(1);
    expect(arrangement.version).toBe(ARRANGEMENT_FORMAT_VERSION);
  });

  it('clamps every number that is out of range and reports each one', () => {
    const raw = baseFile();
    (raw['tempo'] as Record<string, unknown>)['bpm'] = 9000;
    (raw['key'] as Record<string, unknown>)['root'] = 40;
    (raw['tracks'] as Record<string, unknown>[])[0]!['gain'] = 5;
    (raw['tracks'] as Record<string, unknown>[])[0]!['pan'] = -9;
    (raw['clips'] as Record<string, unknown>[])[1]!['transpose'] = -99;
    (raw['sections'] as Record<string, unknown>[])[1]!['bars'] = 900;
    const { arrangement, warnings } = load(raw);
    expect(arrangement.tempo.bpm).toBe(300);
    expect(arrangement.key.root).toBe(11);
    expect(arrangement.tracks[0]?.gain).toBe(1);
    expect(arrangement.tracks[0]?.pan).toBe(-1);
    expect(arrangement.clips[1]?.transpose).toBe(-24);
    expect(arrangement.sections[1]?.bars).toBe(64);
    expect(warnings.filter((line) => line.includes('clamped')).length).toBe(6);
  });

  it('falls back to minor when the scale is not one this build knows', () => {
    const raw = baseFile();
    (raw['key'] as Record<string, unknown>)['scale'] = 'bebopDominant';
    const { arrangement, warnings } = load(raw);
    expect(arrangement.key.scale).toBe('minor');
    expect(warnedAbout(warnings, 'unknown scale')).toBe(true);
  });

  it('keeps a track whose engine is missing, with its patch byte for byte', () => {
    const raw = baseFile();
    const track = (raw['tracks'] as Record<string, unknown>[])[0]!;
    track['engineId'] = 'zither';
    const { arrangement, warnings } = load(raw);
    expect(arrangement.tracks).toHaveLength(1);
    expect(arrangement.tracks[0]?.unplayable).toContain('zither');
    expect(arrangement.tracks[0]?.patch).toEqual(track['patch']);
    // Its clips survive too: dropping them would delete the music.
    expect(arrangement.clips).toHaveLength(2);
    expect(warnedAbout(warnings, 'unknown engine')).toBe(true);
  });

  it('re-emits the patch loader own warnings, prefixed with the track name', () => {
    const raw = baseFile();
    const track = (raw['tracks'] as Record<string, unknown>[])[0]!;
    track['patch'] = {
      version: 2,
      engineId: 'analog',
      values: { [FIRST_PARAM]: 0.5, notAParameter: 3 },
    };
    const { arrangement, warnings } = load(raw);
    expect(warnings.some((line) => line.startsWith('Bass: '))).toBe(true);
    expect(warnedAbout(warnings, 'unknown parameter')).toBe(true);
    // A PARTIAL patch is legal — fromKeyed fills the gaps from defaults, which
    // is what lets a model say "this preset but the cutoff at 800". It warns,
    // and the values it did state are kept verbatim.
    expect(warnedAbout(warnings, 'not in the patch')).toBe(true);
    expect(arrangement.tracks[0]?.patch).toEqual(track['patch']);
  });

  it('warns when a track has neither a patch nor a preset', () => {
    const raw = baseFile();
    delete (raw['tracks'] as Record<string, unknown>[])[0]!['patch'];
    expect(warnedAbout(load(raw).warnings, 'no patch and no presetId')).toBe(true);
  });

  it('keeps an unknown presetId but warns that defaults will be used', () => {
    const raw = baseFile();
    const track = (raw['tracks'] as Record<string, unknown>[])[0]!;
    delete track['patch'];
    track['presetId'] = 'moon_harp_from_2031';
    const { arrangement, warnings } = load(raw);
    expect(arrangement.tracks[0]?.presetId).toBe('moon_harp_from_2031');
    expect(warnedAbout(warnings, 'not in this build')).toBe(true);
  });

  it('quarantines a clip that names something that is not there', () => {
    const raw = baseFile();
    (raw['clips'] as Record<string, unknown>[])[1]!['trackId'] = 'track_ghost';
    const { arrangement, warnings, quarantined } = load(raw);
    expect(arrangement.clips).toHaveLength(1);
    expect(quarantined).toHaveLength(1);
    expect((quarantined[0] as Record<string, unknown>)['id']).toBe('clip_2');
    expect(warnedAbout(warnings, 'quarantined')).toBe(true);
  });

  it('rescales a pattern written at a different ppq', () => {
    const raw = baseFile();
    (raw['patterns'] as Record<string, Record<string, unknown>>)['pat_a'] = {
      id: 'pat_a',
      lengthBars: 1,
      beatsPerBar: 4,
      ppq: 48,
      notes: [{ id: 'n1', midi: 36, velocity: 0.9, startTick: 96, durationTicks: 24 }],
    };
    const { arrangement, warnings } = load(raw);
    const pattern = arrangement.patterns['pat_a'];
    expect(pattern?.ppq).toBe(PPQ);
    expect(pattern?.notes[0]?.startTick).toBe(192);
    expect(pattern?.notes[0]?.durationTicks).toBe(48);
    expect(warnedAbout(warnings, 'rescaled')).toBe(true);
  });

  it('drops a note that falls outside its pattern rather than re-homing it', () => {
    const raw = baseFile();
    const pattern = (raw['patterns'] as Record<string, Record<string, unknown>>)['pat_a']!;
    pattern['notes'] = [
      { id: 'n1', midi: 36, velocity: 0.9, startTick: 0, durationTicks: 48 },
      { id: 'n2', midi: 43, velocity: 0.9, startTick: 4096, durationTicks: 48 },
      { id: 'n3', midi: 43, velocity: 0.9, startTick: -8, durationTicks: 48 },
    ];
    const { arrangement, warnings } = load(raw);
    expect(arrangement.patterns['pat_a']?.notes.map((n) => n.id)).toEqual(['n1']);
    expect(warnedAbout(warnings, 'dropped 2 note')).toBe(true);
  });

  it('renames a duplicate id instead of letting the second overwrite the first', () => {
    const raw = baseFile();
    (raw['sections'] as Record<string, unknown>[])[1]!['id'] = 'sec_intro';
    const { arrangement, warnings } = load(raw);
    expect(arrangement.sections.map((s) => s.id)).toEqual(['sec_intro', 'sec_intro__2']);
    expect(warnedAbout(warnings, 'duplicate id')).toBe(true);
  });

  it('keeps tracks past the cap but flags them unplayable', () => {
    const raw = baseFile();
    const template = (raw['tracks'] as Record<string, unknown>[])[0]!;
    raw['tracks'] = Array.from({ length: MAX_TRACKS + 2 }, (_unused, i) => ({
      ...template, id: `track_${i}`, name: `Track ${i}`,
    }));
    const { arrangement, warnings } = load(raw);
    expect(arrangement.tracks).toHaveLength(MAX_TRACKS + 2);
    expect(arrangement.tracks.filter((t) => t.unplayable !== undefined)).toHaveLength(2);
    expect(warnedAbout(warnings, 'limit')).toBe(true);
  });

  it('flags the second sampler track, because the sample is a worklet global', () => {
    const raw = baseFile();
    const template = (raw['tracks'] as Record<string, unknown>[])[0]!;
    raw['tracks'] = [
      { ...template, id: 'track_kick', name: 'Kick', engineId: 'sampler', sampleRef: 'kick.wav' },
      { ...template, id: 'track_snare', name: 'Snare', engineId: 'sampler', sampleRef: 'sn.wav' },
    ];
    const { arrangement, warnings } = load(raw);
    expect(arrangement.tracks[0]?.unplayable).toBeUndefined();
    expect(arrangement.tracks[1]?.unplayable).toContain('sampler');
    expect(warnedAbout(warnings, 'second sampler')).toBe(true);
    // The sample NAME travels; the bytes never do.
    expect(arrangement.tracks[1]?.sampleRef).toBe('sn.wav');
  });

  it('quarantines entries that are not objects at all', () => {
    const raw = baseFile();
    raw['tracks'] = [...(raw['tracks'] as unknown[]), 'not a track'];
    raw['sections'] = [...(raw['sections'] as unknown[]), 42];
    const { arrangement, quarantined } = load(raw);
    expect(arrangement.tracks).toHaveLength(1);
    expect(arrangement.sections).toHaveLength(2);
    expect(quarantined).toEqual([42, 'not a track']);
  });

  it('gives an empty file a section to stand on', () => {
    const { arrangement, warnings } = load({});
    expect(arrangement.sections).toHaveLength(1);
    expect(arrangement.tracks).toEqual([]);
    expect(warnedAbout(warnings, 'no version')).toBe(true);
  });
});

describe('an arrangement built in the app', () => {
  it('serialises and reloads with no warnings at all', () => {
    let a: Arrangement = createArrangement({ name: 'Live Take', tempo: { bpm: 96 } });
    const track = addTrack(a, {
      name: 'Bass',
      engineId: 'analog',
      patch: fullPatch() as unknown as SerialisedPatch,
      gain: 0.8,
    });
    if (!track.ok) throw new Error(track.reason);
    const pattern = addPattern(track.arrangement, {
      name: 'Take 1',
      lengthBars: 2,
      notes: [{ id: 'n1', midi: 40, velocity: 0.7, startTick: 0, durationTicks: 96, pass: 1 }],
    });
    if (!pattern.ok) throw new Error('pattern');
    const placed = placeClip(pattern.arrangement, track.id, 'sec_a', pattern.id);
    if (!placed.ok) throw new Error(placed.reason);
    a = placed.arrangement;

    const saved = serialiseArrangement(a, '2026-08-18T12:00:00.000Z');
    const reloaded = load(saved);
    expect(reloaded.warnings).toEqual([]);
    expect(reloaded.quarantined).toEqual([]);
    expect(JSON.stringify(serialiseArrangement(reloaded.arrangement))).toBe(JSON.stringify(saved));
    expect(reloaded.arrangement.patterns[pattern.id]?.notes[0]?.pass).toBe(1);
  });
});
