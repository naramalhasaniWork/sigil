import { describe, it, expect } from 'vitest';
import {
  MAX_TRACKS,
  addClip,
  addSection,
  addTrack,
  createArrangement,
  createMemoryStore,
  createPatch,
  describeEngine,
  generateProgression,
  getArrangement,
  listArrangements,
  listEngines,
  listPresets,
  modifyPatch,
  parseNoteName,
  slugify,
  uniqueId,
  updateTrack,
  type ArrangementStore,
  type SerialisedArrangement,
  type ToolResult,
} from '@/mcp/tools';
import {
  MCP_PROTOCOL_VERSION, TOOLS, TOOL_BY_NAME, handleMessage, handlePayload,
} from '@/mcp/server';
import { SCALES, type ScaleName } from '@/dsp/chords';
import { PPQ } from '@/dsp/sequencer';

/** Unwrap a success, failing the test with the tool's own message if it errored. */
async function ok<T>(p: Promise<ToolResult>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return r.data as T;
}

/** Assert the tool refused, and hand back the message so it can be inspected. */
async function refuse(p: Promise<ToolResult>): Promise<string> {
  const r = await p;
  if (r.ok) throw new Error(`expected a refusal, got success: ${JSON.stringify(r.data)}`);
  return r.error;
}

interface Param { id: string; explain: string; min: number; max: number; default: number }
interface Warned { warnings: string[] }
interface PatchOut { patch: { engineId: string; values: Record<string, number>; fx?: Record<string, number> }; warnings: string[] }

async function song(store: ArrangementStore): Promise<string> {
  const made = await ok<{ arrangementId: string }>(createArrangement(store, {
    name: 'Night Drive',
    bpm: 92,
    root: 'A',
    scale: 'minor',
    sections: [{ name: 'Intro', bars: 4 }, { name: 'Drop', bars: 8, repeats: 2 }],
  }));
  return made.arrangementId;
}

describe('catalogue tools', () => {
  it('lists every engine with its macros', async () => {
    const data = await ok<{ engines: { id: string; macros: string[]; presets: number }[] }>(
      listEngines({}),
    );
    expect(data.engines.length).toBeGreaterThanOrEqual(6);
    expect(data.engines.map((e) => e.id)).toContain('analog');
    for (const engine of data.engines) expect(engine.macros).toHaveLength(4);
  });

  it('tolerates being called with no arguments at all', async () => {
    const r = await listEngines(undefined);
    expect(r.ok).toBe(true);
  });

  it('surfaces the explain sentence for every parameter — that is the point', async () => {
    const data = await ok<{ params: Param[] }>(describeEngine({ engineId: 'analog' }));
    expect(data.params.length).toBeGreaterThan(5);
    for (const p of data.params) {
      expect(typeof p.explain).toBe('string');
      expect(p.explain.length).toBeGreaterThan(20);
      expect(p.max).toBeGreaterThan(p.min);
    }
  });

  it('describes the shared fx and character chains too', async () => {
    const fx = await ok<{ params: Param[] }>(describeEngine({ engineId: 'fx' }));
    expect(fx.params.some((p) => p.id === 'drive-amount')).toBe(true);
    const character = await ok<{ params: Param[] }>(describeEngine({ engineId: 'character' }));
    expect(character.params.length).toBeGreaterThan(0);
  });

  it('filters parameters by group', async () => {
    const data = await ok<{ params: Param[] }>(
      describeEngine({ engineId: 'analog', group: 'Filter' }),
    );
    expect(data.params.length).toBeGreaterThan(0);
    expect(data.params.some((p) => p.id === 'filter-cutoff')).toBe(true);
  });

  it('names the engines that do exist when asked for one that does not', async () => {
    const message = await refuse(describeEngine({ engineId: 'moog' }));
    expect(message).toContain('analog');
    expect(message).toContain('moog');
  });

  it('lists the character vocabulary and filters by it', async () => {
    const all = await ok<{ tags: string[]; presets: { character: string[] }[] }>(listPresets({}));
    expect(all.tags).toContain('glassy');
    const glassy = await ok<{ presets: { character: string[] }[] }>(
      listPresets({ character: 'glassy' }),
    );
    expect(glassy.presets.length).toBeGreaterThan(0);
    for (const p of glassy.presets) expect(p.character).toContain('glassy');
    expect(glassy.presets.length).toBeLessThan(all.presets.length);
  });

  it('lists the real tags when given one that is not in the library', async () => {
    const message = await refuse(listPresets({ character: 'sparkly' }));
    expect(message).toContain('glassy');
  });
});

describe('patch tools', () => {
  it('builds a patch from a preset and keeps a partial override', async () => {
    const data = await ok<PatchOut>(createPatch({
      engineId: 'analog',
      presetId: 'frost-lattice',
      values: { 'filter-cutoff': 800 },
    }));
    expect(data.patch.engineId).toBe('analog');
    expect(data.patch.values['filter-cutoff']).toBe(800);
    // Everything not mentioned is still present, from the preset or the default.
    expect(Object.keys(data.patch.values).length).toBeGreaterThan(5);
    expect(data.warnings).toEqual([]);
  });

  it('clamps an out-of-range value and says so rather than passing it to the DSP', async () => {
    const data = await ok<PatchOut>(createPatch({
      engineId: 'analog',
      values: { 'filter-cutoff': 999_999 },
    }));
    expect(data.patch.values['filter-cutoff']).toBe(18000);
    expect(data.warnings.join(' ')).toContain('clamped');
  });

  it('warns about a parameter id it does not recognise', async () => {
    const data = await ok<PatchOut>(createPatch({
      engineId: 'analog',
      values: { 'not-a-real-param': 1 },
    }));
    expect(data.warnings.join(' ')).toContain('unknown');
  });

  it('refuses a preset written for a different engine', async () => {
    const message = await refuse(createPatch({ engineId: 'fm', presetId: 'frost-lattice' }));
    expect(message).toContain('analog');
  });

  it('carries fx values when asked', async () => {
    const data = await ok<PatchOut>(createPatch({
      engineId: 'analog',
      fx: { 'drive-amount': 0.4 },
    }));
    expect(data.patch.fx?.['drive-amount']).toBeCloseTo(0.4, 5);
  });

  it('modifies an existing patch, keeping what was not mentioned', async () => {
    const first = await ok<PatchOut>(createPatch({
      engineId: 'analog', values: { 'filter-cutoff': 800, 'filter-resonance': 0.5 },
    }));
    const second = await ok<PatchOut>(modifyPatch({
      patch: first.patch, values: { 'filter-cutoff': 400 },
    }));
    expect(second.patch.values['filter-cutoff']).toBe(400);
    expect(second.patch.values['filter-resonance']).toBeCloseTo(0.5, 5);
  });

  it('refuses a patch object with no engineId instead of throwing', async () => {
    const message = await refuse(modifyPatch({ patch: { values: {} } }));
    expect(message).toContain('engineId');
  });
});

describe('argument validation', () => {
  it('rejects non-object arguments with a readable message', async () => {
    for (const junk of [null, 42, 'hello', [1, 2, 3], true]) {
      const message = await refuse(describeEngine(junk));
      expect(message).toContain('object');
    }
  });

  it('names the missing argument', async () => {
    expect(await refuse(describeEngine({}))).toContain('engineId');
    expect(await refuse(createPatch({}))).toContain('engineId');
    expect(await refuse(generateProgression({}))).toContain('degrees');
  });

  it('states the range when a number is out of it', async () => {
    const store = createMemoryStore();
    const message = await refuse(createArrangement(store, { name: 'Too Fast', bpm: 900 }));
    expect(message).toContain('300');
  });

  it('rejects a wrong-typed value rather than coercing it', async () => {
    const store = createMemoryStore();
    expect(await refuse(createArrangement(store, { name: 'X', bpm: '120' }))).toContain('number');
    expect(await refuse(createArrangement(store, { name: 42 }))).toContain('string');
  });

  it('lists the legal values for an enum-ish argument', async () => {
    const message = await refuse(generateProgression({ degrees: [1], scale: 'klingon' }));
    expect(message).toContain('phrygian');
  });

  it('points at the arrangement tools when the id is unknown', async () => {
    const store = createMemoryStore();
    const message = await refuse(getArrangement(store, { arrangementId: 'arr_ghost' }));
    expect(message).toContain('create_arrangement');
  });

  it('never throws, whatever it is handed', async () => {
    const store = createMemoryStore();
    const junk: unknown[] = [null, undefined, 0, '', [], { arrangementId: 5 }, { notes: 'no' }];
    for (const j of junk) {
      for (const spec of TOOLS) {
        await expect(spec.run(store, j)).resolves.toBeDefined();
      }
    }
  });
});

describe('progressions are in key by construction', () => {
  const cases: { root: number; scale: ScaleName }[] = [
    { root: 0, scale: 'major' },
    { root: 9, scale: 'minor' },
    { root: 2, scale: 'dorian' },
    { root: 7, scale: 'lydian' },
    { root: 5, scale: 'harmonicMinor' },
    { root: 11, scale: 'pentatonicMinor' },
  ];

  for (const { root, scale } of cases) {
    it(`keeps every note inside ${scale} on root ${root}`, async () => {
      const data = await ok<{ notes: { midi: number }[] }>(generateProgression({
        root, scale, degrees: [1, 6, 4, 5, 2, 3, 7], notesPerChord: 4, spread: 1,
      }));
      const allowed = new Set(SCALES[scale].map((s) => (root + s) % 12));
      expect(data.notes.length).toBeGreaterThan(0);
      for (const note of data.notes) {
        expect(allowed.has(((note.midi % 12) + 12) % 12)).toBe(true);
      }
    });
  }

  it('reads roman numerals as well as numbers', async () => {
    const roman = await ok<{ chords: { degree: number; label: string }[] }>(
      generateProgression({ root: 'A', scale: 'minor', degrees: ['i', 'VI', 'III', 'VII'] }),
    );
    const numeric = await ok<{ chords: { degree: number; label: string }[] }>(
      generateProgression({ root: 'A', scale: 'minor', degrees: [1, 6, 3, 7] }),
    );
    expect(roman.chords.map((c) => c.label)).toEqual(numeric.chords.map((c) => c.label));
    expect(roman.chords[0]?.label).toBe('Am');
  });

  it('lays the chords out end to end at the requested bar length', async () => {
    const data = await ok<{
      chords: { startTick: number; durationTicks: number }[]; lengthBars: number;
    }>(generateProgression({ degrees: [1, 4, 5], barsPerChord: 2, beatsPerBar: 4 }));
    expect(data.chords[0]?.startTick).toBe(0);
    expect(data.chords[1]?.startTick).toBe(2 * 4 * PPQ);
    expect(data.chords[2]?.startTick).toBe(4 * 4 * PPQ);
    expect(data.lengthBars).toBe(6);
  });

  it('gives sevenths four notes and triads three', async () => {
    const triad = await ok<{ chords: { notes: number[] }[] }>(
      generateProgression({ degrees: [1] }),
    );
    const seventh = await ok<{ chords: { notes: number[] }[] }>(
      generateProgression({ degrees: [1], notesPerChord: 4 }),
    );
    expect(triad.chords[0]?.notes).toHaveLength(3);
    expect(seventh.chords[0]?.notes).toHaveLength(4);
  });

  it('refuses an empty degree list rather than returning silence', async () => {
    expect(await refuse(generateProgression({ degrees: [] }))).toContain('degree');
    expect(await refuse(generateProgression({ degrees: ['xyz'] }))).toContain('degree');
  });
});

describe('ids are slugs a model can hold in its head', () => {
  it('slugifies names', () => {
    expect(slugify('Lead Bass 2')).toBe('lead_bass_2');
    expect(slugify('  ---  ')).toBe('x');
  });

  it('suffixes collisions deterministically', () => {
    expect(uniqueId('track_', 'Bass', [])).toBe('track_bass');
    expect(uniqueId('track_', 'Bass', ['track_bass'])).toBe('track_bass__2');
    expect(uniqueId('track_', 'Bass', ['track_bass', 'track_bass__2'])).toBe('track_bass__3');
  });

  it('parses note names into MIDI', () => {
    expect(parseNoteName('C3')).toBe(48);
    expect(parseNoteName('A4')).toBe(69);
    expect(parseNoteName('F#2')).toBe(42);
    expect(parseNoteName('Bb3')).toBe(58);
    expect(parseNoteName('H2')).toBeNull();
  });

  it('gives tracks and sections readable ids', async () => {
    const store = createMemoryStore();
    const id = await song(store);
    const bass = await ok<{ trackId: string }>(
      addTrack(store, { arrangementId: id, name: 'Bass', engineId: 'analog' }),
    );
    expect(bass.trackId).toBe('track_bass');
    const again = await ok<{ trackId: string }>(
      addTrack(store, { arrangementId: id, name: 'Bass', engineId: 'fm' }),
    );
    expect(again.trackId).toBe('track_bass__2');
    const arrangement = await ok<{ arrangement: SerialisedArrangement }>(
      getArrangement(store, { arrangementId: id }),
    );
    expect(arrangement.arrangement.sections.map((s) => s.id)).toEqual(['sec_intro', 'sec_drop']);
  });
});

describe('arrangement mutations', () => {
  it('creates a song with sections in play order', async () => {
    const store = createMemoryStore();
    const id = await song(store);
    const data = await ok<{ arrangement: SerialisedArrangement; summary: { totalBars: number; seconds: number } }>(
      getArrangement(store, { arrangementId: id }),
    );
    expect(data.arrangement.tempo).toEqual({ bpm: 92, beatsPerBar: 4, ppq: PPQ });
    expect(data.arrangement.key).toEqual({ root: 9, scale: 'minor' });
    // 4 bars of intro + 8 bars twice.
    expect(data.summary.totalBars).toBe(20);
    expect(data.summary.seconds).toBeCloseTo((20 * 4 * 60) / 92, 1);
  });

  it('inserts a section after a named one', async () => {
    const store = createMemoryStore();
    const id = await song(store);
    await ok(addSection(store, { arrangementId: id, name: 'Verse', bars: 8, after: 'sec_intro' }));
    const data = await ok<{ sections: { id: string }[] }>(
      addSection(store, { arrangementId: id, name: 'Outro', bars: 2 }),
    );
    expect(data.sections.map((s) => s.id)).toEqual(
      ['sec_intro', 'sec_verse', 'sec_drop', 'sec_outro'],
    );
  });

  it('refuses to insert after a section that is not there', async () => {
    const store = createMemoryStore();
    const id = await song(store);
    expect(await refuse(addSection(store, { arrangementId: id, name: 'X', after: 'sec_nope' })))
      .toContain('sec_nope');
  });

  it('gives a track a sound from a preset and a partial override', async () => {
    const store = createMemoryStore();
    const id = await song(store);
    const data = await ok<{ track: { patch?: { values: Record<string, number> }; presetId?: string; gain?: number } }>(
      addTrack(store, {
        arrangementId: id, name: 'Pad', engineId: 'analog',
        presetId: 'frost-lattice', values: { 'filter-cutoff': 600 }, gain: 0.5,
      }),
    );
    expect(data.track.presetId).toBe('frost-lattice');
    expect(data.track.patch?.values['filter-cutoff']).toBe(600);
    expect(data.track.gain).toBe(0.5);
  });

  it('caps tracks at eight and says why', async () => {
    const store = createMemoryStore();
    const id = await song(store);
    for (let i = 0; i < MAX_TRACKS; i++) {
      await ok(addTrack(store, { arrangementId: id, name: `T${i}`, engineId: 'analog' }));
    }
    const message = await refuse(
      addTrack(store, { arrangementId: id, name: 'One More', engineId: 'analog' }),
    );
    expect(message).toContain('8');
    expect(message.toLowerCase()).toContain('cap');
  });

  it('refuses a second sampler track and explains the worklet reason', async () => {
    const store = createMemoryStore();
    const id = await song(store);
    await ok(addTrack(store, { arrangementId: id, name: 'Kit', engineId: 'sampler' }));
    const message = await refuse(
      addTrack(store, { arrangementId: id, name: 'Vox', engineId: 'sampler' }),
    );
    expect(message.toLowerCase()).toContain('sampler');
    expect(message).toContain('global');
  });

  it('updates gain, mute and sound on an existing track', async () => {
    const store = createMemoryStore();
    const id = await song(store);
    await ok(addTrack(store, {
      arrangementId: id, name: 'Bass', engineId: 'analog', values: { 'filter-cutoff': 900 },
    }));
    const data = await ok<{ track: { gain?: number; muted?: boolean; patch?: { values: Record<string, number> } } }>(
      updateTrack(store, {
        arrangementId: id, trackId: 'track_bass', gain: 0.3, muted: true,
        values: { 'filter-resonance': 0.7 },
      }),
    );
    expect(data.track.gain).toBe(0.3);
    expect(data.track.muted).toBe(true);
    expect(data.track.patch?.values['filter-resonance']).toBeCloseTo(0.7, 5);
    // The earlier edit survived the later one.
    expect(data.track.patch?.values['filter-cutoff']).toBe(900);
  });

  it('lists what it holds', async () => {
    const store = createMemoryStore();
    await song(store);
    const data = await ok<{ arrangements: { id: string; sections: number }[] }>(
      listArrangements(store),
    );
    expect(data.arrangements).toHaveLength(1);
    expect(data.arrangements[0]?.sections).toBe(2);
  });
});

describe('clips live in cells', () => {
  async function seeded(): Promise<{ store: ArrangementStore; id: string }> {
    const store = createMemoryStore();
    const id = await song(store);
    await ok(addTrack(store, { arrangementId: id, name: 'Keys', engineId: 'analog' }));
    return { store, id };
  }

  it('places a generated progression into a cell', async () => {
    const { store, id } = await seeded();
    const prog = await ok<{ notes: unknown[] }>(generateProgression({
      root: 'A', scale: 'minor', degrees: ['i', 'VI', 'III', 'VII'], barsPerChord: 2,
    }));
    const placed = await ok<{ clipId: string; patternId: string; warnings: string[] }>(addClip(store, {
      arrangementId: id, trackId: 'track_keys', sectionId: 'sec_drop',
      notes: prog.notes, lengthBars: 8,
    }));
    expect(placed.clipId).toBe('clip_keys_drop');
    expect(placed.warnings).toEqual([]);

    const read = await ok<{ arrangement: SerialisedArrangement; summary: { grid: string[]; clipCount: number } }>(
      getArrangement(store, { arrangementId: id }),
    );
    const clip = read.arrangement.clips[0];
    expect(clip?.trackId).toBe('track_keys');
    expect(clip?.sectionId).toBe('sec_drop');
    expect(clip?.fill).toBe('loop');
    const pattern = read.arrangement.patterns[placed.patternId];
    expect(pattern?.ppq).toBe(PPQ);
    expect(pattern?.notes.length).toBe(12);
    expect(read.summary.clipCount).toBe(1);
    expect(read.summary.grid.join('\n')).toContain('█');
  });

  it('converts bar and beat into ticks, and only ticks are stored', async () => {
    const { store, id } = await seeded();
    const placed = await ok<{ patternId: string }>(addClip(store, {
      arrangementId: id, trackId: 'track_keys', sectionId: 'sec_intro',
      lengthBars: 4,
      notes: [
        { note: 'C3', bar: 1, beat: 1, durationBeats: 1 },
        { note: 'E3', bar: 2, beat: 2.5, durationBeats: 0.5 },
        { midi: 55, startTick: 3 * 4 * PPQ },
      ],
    }));
    const read = await ok<{ arrangement: SerialisedArrangement }>(
      getArrangement(store, { arrangementId: id }),
    );
    const notes = read.arrangement.patterns[placed.patternId]?.notes ?? [];
    expect(notes.map((n) => n.startTick)).toEqual([0, 4 * PPQ + Math.round(1.5 * PPQ), 12 * PPQ]);
    expect(notes[0]?.midi).toBe(48);
    expect(notes[1]?.durationTicks).toBe(PPQ / 2);
    for (const n of notes) {
      expect(Object.keys(n)).not.toContain('bar');
      expect(Number.isInteger(n.startTick)).toBe(true);
    }
  });

  it('drops a note that falls outside the pattern and says which one', async () => {
    const { store, id } = await seeded();
    const placed = await ok<{ patternId: string; warnings: string[] }>(addClip(store, {
      arrangementId: id, trackId: 'track_keys', sectionId: 'sec_intro', lengthBars: 2,
      notes: [{ midi: 60, bar: 1 }, { midi: 62, bar: 9 }],
    }));
    expect(placed.warnings.join(' ')).toContain('dropped');
    const read = await ok<{ arrangement: SerialisedArrangement }>(
      getArrangement(store, { arrangementId: id }),
    );
    expect(read.arrangement.patterns[placed.patternId]?.notes).toHaveLength(1);
  });

  it('replaces the clip already in a cell rather than stacking two', async () => {
    const { store, id } = await seeded();
    await ok(addClip(store, {
      arrangementId: id, trackId: 'track_keys', sectionId: 'sec_intro',
      notes: [{ midi: 60, bar: 1 }],
    }));
    const second = await ok<{ warnings: string[] }>(addClip(store, {
      arrangementId: id, trackId: 'track_keys', sectionId: 'sec_intro',
      notes: [{ midi: 67, bar: 1 }],
    }));
    expect(second.warnings.join(' ')).toContain('Replaced');
    const read = await ok<{ arrangement: SerialisedArrangement }>(
      getArrangement(store, { arrangementId: id }),
    );
    expect(read.arrangement.clips).toHaveLength(1);
  });

  it('reuses a pattern by id across two sections', async () => {
    const { store, id } = await seeded();
    const first = await ok<{ patternId: string }>(addClip(store, {
      arrangementId: id, trackId: 'track_keys', sectionId: 'sec_intro',
      notes: [{ midi: 60, bar: 1 }],
    }));
    await ok(addClip(store, {
      arrangementId: id, trackId: 'track_keys', sectionId: 'sec_drop',
      patternId: first.patternId, transpose: 12,
    }));
    const read = await ok<{ arrangement: SerialisedArrangement }>(
      getArrangement(store, { arrangementId: id }),
    );
    expect(Object.keys(read.arrangement.patterns)).toHaveLength(1);
    expect(read.arrangement.clips).toHaveLength(2);
    expect(read.arrangement.clips[1]?.transpose).toBe(12);
  });

  it('names the cells that exist when given one that does not', async () => {
    const { store, id } = await seeded();
    expect(await refuse(addClip(store, {
      arrangementId: id, trackId: 'track_ghost', sectionId: 'sec_intro', notes: [],
    }))).toContain('track_keys');
    expect(await refuse(addClip(store, {
      arrangementId: id, trackId: 'track_keys', sectionId: 'sec_ghost', notes: [],
    }))).toContain('sec_intro');
    expect(await refuse(addClip(store, {
      arrangementId: id, trackId: 'track_keys', sectionId: 'sec_intro', patternId: 'pat_nope',
    }))).toContain('pat_nope');
  });
});

describe('the MCP protocol layer', () => {
  it('every tool has a schema and a description written for a model', () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(13);
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z_]*$/);
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema['type']).toBe('object');
      expect(TOOL_BY_NAME.get(tool.name)).toBe(tool);
    }
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  });

  it('answers initialize with a protocol version and instructions', async () => {
    const store = createMemoryStore();
    const res = await handleMessage(store, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    const result = res?.result as { protocolVersion: string; instructions: string };
    expect(result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.instructions).toContain('PPQ 96');
  });

  it('lists the tools', async () => {
    const store = createMemoryStore();
    const res = await handleMessage(store, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const result = res?.result as { tools: { name: string }[] };
    expect(result.tools).toHaveLength(TOOLS.length);
  });

  it('calls a tool and returns readable content', async () => {
    const store = createMemoryStore();
    const res = await handleMessage(store, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'create_arrangement', arguments: { name: 'Test Piece', bpm: 120 } },
    });
    const result = res?.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { arrangementId: string };
    expect(parsed.arrangementId).toBe('arr_test_piece');
    expect(await store.get('arr_test_piece')).not.toBeNull();
  });

  it('returns a tool refusal as readable content, not a transport error', async () => {
    const store = createMemoryStore();
    const res = await handleMessage(store, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'create_arrangement', arguments: { bpm: 120 } },
    });
    expect(res?.error).toBeUndefined();
    const result = res?.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('name');
  });

  /*
   * The whole tools/call response shape, not just the half a reader notices.
   * `structuredContent` is the field an MCP client parses; `content` is the
   * fallback a human reads. A regression that drops the structured half leaves
   * the text half working, so it is invisible unless something asserts it.
   */
  it('returns the tool data as structuredContent as well as text, on success', async () => {
    const store = createMemoryStore();
    const res = await handleMessage(store, {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'list_engines', arguments: {} },
    });
    expect(res?.jsonrpc).toBe('2.0');
    expect(res?.id).toBe(7);
    const result = res?.result as {
      content: { type: string; text: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const direct = await listEngines({});
    expect(direct.ok).toBe(true);
    // The structured half IS the tool's data, not a summary of it.
    expect(result.structuredContent).toEqual(direct.ok ? direct.data : null);
    expect(result.structuredContent).not.toBeUndefined();
    // And the text half is the same thing, readable.
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    expect(JSON.parse(result.content[0]?.text ?? 'null')).toEqual(result.structuredContent);
    expect(result.isError).toBeUndefined();
  });

  it('carries no structuredContent on a refusal — there is no data to structure', async () => {
    const store = createMemoryStore();
    const res = await handleMessage(store, {
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'describe_engine', arguments: { engineId: 'moog' } },
    });
    const result = res?.result as {
      content: { type: string; text: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect('structuredContent' in result).toBe(false);
    expect(result.content[0]?.type).toBe('text');
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { error?: string };
    expect(parsed.error).toContain('moog');
  });

  it('echoes the envelope: jsonrpc, the caller\'s id, and one of result or error', async () => {
    const store = createMemoryStore();
    const pong = await handleMessage(store, { jsonrpc: '2.0', id: 'abc', method: 'ping' });
    expect(pong?.jsonrpc).toBe('2.0');
    expect(pong?.id).toBe('abc');
    expect(pong?.result).toEqual({});
    expect(pong?.error).toBeUndefined();
    const nope = await handleMessage(store, { jsonrpc: '2.0', id: 9, method: 'nope' });
    expect(nope?.id).toBe(9);
    expect(nope?.result).toBeUndefined();
    expect(typeof nope?.error?.message).toBe('string');
  });

  it('serves initialize and tools/list with every field a client reads', async () => {
    const store = createMemoryStore();
    const init = await handleMessage(store, { jsonrpc: '2.0', id: 10, method: 'initialize' });
    const initResult = init?.result as {
      protocolVersion: string;
      capabilities: { tools?: unknown };
      serverInfo: { name: string; version: string };
    };
    expect(initResult.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(initResult.capabilities.tools).toBeDefined();
    expect(initResult.serverInfo.name).toBe('sigil');
    expect(initResult.serverInfo.version).toMatch(/^\d+\.\d+\.\d+$/);

    const listed = await handleMessage(store, { jsonrpc: '2.0', id: 11, method: 'tools/list' });
    const tools = (listed?.result as { tools: Record<string, unknown>[] }).tools;
    for (const tool of tools) {
      const spec = TOOL_BY_NAME.get(tool['name'] as string);
      expect(spec).toBeDefined();
      expect(tool['title']).toBe(spec?.title);
      expect(tool['description']).toBe(spec?.description);
      expect(tool['inputSchema']).toEqual(spec?.inputSchema);
    }
  });

  it('errors usefully on an unknown tool or method', async () => {
    const store = createMemoryStore();
    const unknownTool = await handleMessage(store, {
      jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'make_hit_record' },
    });
    expect(unknownTool?.error?.code).toBe(-32602);
    const unknownMethod = await handleMessage(store, {
      jsonrpc: '2.0', id: 6, method: 'resources/list',
    });
    expect(unknownMethod?.error?.code).toBe(-32601);
  });

  it('says nothing back to a notification', async () => {
    const store = createMemoryStore();
    expect(await handleMessage(store, { jsonrpc: '2.0', method: 'notifications/initialized' }))
      .toBeNull();
    expect(await handlePayload(store, [{ jsonrpc: '2.0', method: 'notifications/x' }])).toBeNull();
  });

  it('handles a batch and rejects a non-object message', async () => {
    const store = createMemoryStore();
    const batch = await handlePayload(store, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    expect(Array.isArray(batch) && batch).toHaveLength(2);
    const junk = await handleMessage(store, 'not a message');
    expect(junk?.error?.code).toBe(-32600);
  });
});

describe('a whole short piece, composed by tool call', () => {
  it('goes from nothing to a readable song', async () => {
    const store = createMemoryStore();
    const { arrangementId } = await ok<{ arrangementId: string }>(createArrangement(store, {
      name: 'Cold Room', bpm: 84, root: 'D', scale: 'dorian',
      sections: [{ name: 'Intro', bars: 4 }, { name: 'Body', bars: 8 }, { name: 'Outro', bars: 4 }],
    }));
    await ok(addTrack(store, {
      arrangementId, name: 'Keys', engineId: 'analog', presetId: 'frost-lattice',
    }));
    await ok(addTrack(store, { arrangementId, name: 'Bass', engineId: 'fm', gain: 0.7 }));

    const chords = await ok<{ notes: { midi: number }[]; chords: { notes: number[] }[] }>(
      generateProgression({
        root: 'D', scale: 'dorian', degrees: ['i', 'IV', 'i', 'VII'], barsPerChord: 2, spread: 1,
      }),
    );
    await ok(addClip(store, {
      arrangementId, trackId: 'track_keys', sectionId: 'sec_body',
      notes: chords.notes, lengthBars: 8,
    }));
    const roots = chords.chords.map((c, i) => ({
      midi: (c.notes[0] ?? 50) - 12, bar: i * 2 + 1, beat: 1, durationBeats: 8, velocity: 0.9,
    }));
    await ok(addClip(store, {
      arrangementId, trackId: 'track_bass', sectionId: 'sec_body',
      notes: roots, lengthBars: 8,
    }));
    await ok(addClip(store, {
      arrangementId, trackId: 'track_keys', sectionId: 'sec_intro',
      notes: chords.notes.slice(0, 3), lengthBars: 4,
    }));

    const read = await ok<{
      arrangement: SerialisedArrangement;
      summary: { totalBars: number; clipCount: number; emptyCells: number; grid: string[] };
    }>(getArrangement(store, { arrangementId }));

    expect(read.summary.totalBars).toBe(16);
    expect(read.summary.clipCount).toBe(3);
    expect(read.summary.emptyCells).toBe(3);
    expect(read.summary.grid).toHaveLength(3);
    expect(read.arrangement.version).toBe(1);
    // Serialisable with nothing exotic in it — this is a file, and a plugin will read it.
    const round = JSON.parse(JSON.stringify(read.arrangement)) as SerialisedArrangement;
    expect(round).toEqual(read.arrangement);
    expect(JSON.stringify(read.arrangement)).not.toContain('Float32Array');
  });
});
