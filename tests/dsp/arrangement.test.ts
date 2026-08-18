import { describe, it, expect } from 'vitest';
import { PPQ } from '@/dsp/sequencer';
import {
  MAX_TRACKS,
  addPattern,
  addSection,
  addTrack,
  arrangementTotalTicks,
  clearCell,
  clipLocalTick,
  createArrangement,
  indexArrangement,
  locateTick,
  moveClip,
  placeClip,
  removeSection,
  removeTrack,
  resolveWindow,
  setClipTranspose,
  setKey,
  setPatternNotes,
  setSolo,
  setTempo,
  setTrackMuted,
  slugId,
  toSeqNotes,
  trimClip,
  type Arrangement,
  type ClipRecord,
  type NoteRecord,
} from '@/dsp/arrangement';

const BAR = 4 * PPQ; // 384 ticks of 4/4 at PPQ 96.

function note(id: string, midi: number, startTick: number): NoteRecord {
  return { id, midi, velocity: 0.8, startTick, durationTicks: PPQ };
}

/**
 * Intro (2 bars) then Drop (1 bar, played twice) — 1536 ticks in all. One
 * one-bar pattern with a note on the downbeat and one on beat 3, placed in both
 * sections, so every interesting boundary in the model is somewhere in here.
 */
function song(): Arrangement {
  const base = createArrangement({
    name: 'Test Song',
    sections: [
      { id: 'sec_intro', name: 'Intro', bars: 2 },
      { id: 'sec_drop', name: 'Drop', bars: 1, repeats: 2 },
    ],
  });
  const added = addTrack(base, { name: 'Bass', engineId: 'analog' });
  if (!added.ok) throw new Error(added.reason);
  const withPattern = addPattern(added.arrangement, {
    name: 'A',
    lengthBars: 1,
    notes: [note('n1', 36, 0), note('n2', 43, PPQ * 2)],
  });
  if (!withPattern.ok) throw new Error('pattern');
  let a = withPattern.arrangement;
  for (const sectionId of ['sec_intro', 'sec_drop']) {
    const placed = placeClip(a, added.id, sectionId, withPattern.id);
    if (!placed.ok) throw new Error(placed.reason);
    a = placed.arrangement;
  }
  return a;
}

function ticks(a: Arrangement, from: number, to: number, loop = false): number[] {
  return resolveWindow(a, from, to, { loop }).map((e) => e.absTick);
}

describe('ids', () => {
  it('generates human-readable slugs, never uuids', () => {
    const a = createArrangement({ name: 'Test' });
    const first = addTrack(a, { name: 'Deep Bass', engineId: 'analog' });
    expect(first.ok && first.id).toBe('track_deep_bass');
    if (!first.ok) return;
    const second = addTrack(first.arrangement, { name: 'Deep Bass', engineId: 'fm' });
    expect(second.ok && second.id).toBe('track_deep_bass_2');
  });

  it('never returns an empty slug', () => {
    expect(slugId('pat', '???', [])).toBe('pat_x');
  });
});

describe('tracks', () => {
  it('refuses a ninth track and says why', () => {
    let a = createArrangement({ name: 'Full' });
    for (let i = 0; i < MAX_TRACKS; i += 1) {
      const r = addTrack(a, { name: `T${i}`, engineId: 'analog' });
      expect(r.ok).toBe(true);
      if (r.ok) a = r.arrangement;
    }
    const overflow = addTrack(a, { name: 'One More', engineId: 'analog' });
    expect(overflow.ok).toBe(false);
    expect(overflow.ok === false && overflow.reason).toContain('limit');
  });

  it('refuses a second sampler track, because the sample is a worklet global', () => {
    const a = createArrangement({ name: 'Kit' });
    const first = addTrack(a, { name: 'Kick', engineId: 'sampler' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = addTrack(first.arrangement, { name: 'Snare', engineId: 'sampler' });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toContain('sampler');
  });

  it('removing a track removes its clips but keeps the patterns', () => {
    const a = song();
    const gone = removeTrack(a, 'track_bass');
    expect(gone.tracks).toHaveLength(0);
    expect(gone.clips).toHaveLength(0);
    expect(Object.keys(gone.patterns)).toEqual(Object.keys(a.patterns));
  });

  it('solo is a radio, not a checkbox', () => {
    const a = addTrack(song(), { name: 'Lead', engineId: 'fm' });
    if (!a.ok) throw new Error(a.reason);
    const soloed = setSolo(setSolo(a.arrangement, 'track_bass'), 'track_lead');
    expect(soloed.tracks.filter((t) => t.soloed === true).map((t) => t.id)).toEqual(['track_lead']);
  });
});

describe('sections and clips', () => {
  it('inserts a section after the named one and nowhere else', () => {
    const r = addSection(song(), 'sec_intro', { name: 'Verse', bars: 4 });
    expect(r.ok && r.arrangement.sections.map((s) => s.id))
      .toEqual(['sec_intro', 'sec_verse', 'sec_drop']);
  });

  it('removing a section removes the clips in it', () => {
    const gone = removeSection(song(), 'sec_drop');
    expect(gone.clips.map((c) => c.sectionId)).toEqual(['sec_intro']);
  });

  it('one clip per cell: placing over a cell replaces what was there', () => {
    const a = song();
    const second = addPattern(a, { name: 'B', lengthBars: 1, notes: [note('n3', 48, 0)] });
    if (!second.ok) throw new Error('pattern');
    const placed = placeClip(second.arrangement, 'track_bass', 'sec_intro', second.id);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const cell = placed.arrangement.clips.filter(
      (c) => c.trackId === 'track_bass' && c.sectionId === 'sec_intro',
    );
    expect(cell).toHaveLength(1);
    expect(cell[0]?.patternId).toBe(second.id);
  });

  it('moving a clip onto an occupied cell replaces the occupant', () => {
    const a = song();
    const clipId = a.clips[0]?.id ?? '';
    const moved = moveClip(a, clipId, 'track_bass', 'sec_drop');
    expect(moved.clips).toHaveLength(1);
    expect(moved.clips[0]?.id).toBe(clipId);
    expect(moved.clips[0]?.sectionId).toBe('sec_drop');
  });

  it('refuses to place a clip against ids that are not there', () => {
    const a = song();
    expect(placeClip(a, 'track_nope', 'sec_intro', 'pat_a').ok).toBe(false);
    expect(placeClip(a, 'track_bass', 'sec_nope', 'pat_a').ok).toBe(false);
    expect(placeClip(a, 'track_bass', 'sec_intro', 'pat_nope').ok).toBe(false);
  });

  it('clearCell returns the same object when there was nothing to clear', () => {
    const a = song();
    expect(clearCell(a, 'track_bass', 'sec_nope')).toBe(a);
  });
});

describe('trimming', () => {
  it('a trim to zero or below floors at one bar rather than going negative', () => {
    // One clip only, so the pattern is not shared and trimming edits it in place.
    const a = removeSection(song(), 'sec_drop');
    const longer = trimClip(a, a.clips[0]?.id ?? '', 4);
    expect(longer.patterns['pat_a']?.lengthBars).toBe(4);
    const trimmed = trimClip(longer, longer.clips[0]?.id ?? '', -8);
    expect(trimmed.patterns['pat_a']?.lengthBars).toBe(1);
    expect(arrangementTotalTicks(trimmed)).toBeGreaterThan(0);
  });

  it('drops the notes past the new end rather than re-homing them', () => {
    const wide = addPattern(createArrangement({ name: 'T' }), {
      name: 'Wide',
      lengthBars: 2,
      notes: [note('n1', 36, 0), note('n2', 43, BAR + PPQ)],
    });
    if (!wide.ok) throw new Error('pattern');
    const withTrack = addTrack(wide.arrangement, { name: 'Bass', engineId: 'analog' });
    if (!withTrack.ok) throw new Error(withTrack.reason);
    const placed = placeClip(withTrack.arrangement, withTrack.id, 'sec_a', wide.id);
    if (!placed.ok) throw new Error(placed.reason);
    const trimmed = trimClip(placed.arrangement, placed.id, 1);
    expect(trimmed.patterns[wide.id]?.notes.map((n) => n.id)).toEqual(['n1']);
  });

  it('forks a shared pattern so trimming one clip cannot shorten another', () => {
    const a = song();
    const clipId = a.clips[0]?.id ?? '';
    const trimmed = trimClip({ ...a, patterns: { ...a.patterns } }, clipId, 1);
    // Both clips share pat_a, so the trimmed clip must now point somewhere else.
    const [first, second] = [trimmed.clips[0], trimmed.clips[1]];
    expect(first?.patternId).not.toBe(second?.patternId);
    expect(trimmed.patterns['pat_a']?.lengthBars).toBe(1);
    expect(Object.keys(trimmed.patterns)).toHaveLength(2);
  });
});

describe('tempo, key and length', () => {
  it('clamps bpm to the transport range and the root to a pitch class', () => {
    expect(setTempo(song(), 999).tempo.bpm).toBe(300);
    expect(setTempo(song(), 1).tempo.bpm).toBe(20);
    expect(setKey(song(), 99, 'dorian').key).toEqual({ root: 11, scale: 'dorian' });
  });

  it('total length counts repeats', () => {
    expect(arrangementTotalTicks(song())).toBe(2 * BAR + 2 * BAR);
  });

  it('sectionStartTick is where a section first begins, with earlier repeats counted', () => {
    const a = addSection(song(), 'sec_drop', { name: 'Outro', bars: 1 });
    if (!a.ok) throw new Error('section');
    const index = indexArrangement(a.arrangement);
    expect(index.sectionStartTick.get('sec_intro')).toBe(0);
    expect(index.sectionStartTick.get('sec_drop')).toBe(2 * BAR);
    // sec_drop plays twice before the outro can start.
    expect(index.sectionStartTick.get('sec_outro')).toBe(4 * BAR);
    expect(index.occurrences).toHaveLength(4);
    expect(index.cellAt('track_bass', 'sec_drop')?.sectionId).toBe('sec_drop');
    expect(index.cellAt('track_bass', 'sec_outro')).toBeNull();
  });

  it('maps an absolute tick to a section, a repeat and a bar/beat readout', () => {
    const a = song();
    expect(locateTick(a, 0)).toMatchObject({ sectionId: 'sec_intro', bar: 1, beat: 1 });
    expect(locateTick(a, BAR + PPQ * 2))
      .toMatchObject({ sectionId: 'sec_intro', bar: 2, beat: 3 });
    expect(locateTick(a, 2 * BAR)).toMatchObject({ sectionId: 'sec_drop', occurrence: 0 });
    expect(locateTick(a, 3 * BAR)).toMatchObject({ sectionId: 'sec_drop', occurrence: 1 });
    expect(locateTick(a, 4 * BAR)).toBeNull();
    expect(locateTick(a, -1)).toBeNull();
  });

  it('maps an absolute tick into clip-local time, per fill mode', () => {
    const a = song();
    const clipId = a.clips[0]?.id ?? '';
    expect(clipLocalTick(a, clipId, 0)).toBe(0);
    // A one-bar pattern in a two-bar section: bar 2 is the second lap.
    expect(clipLocalTick(a, clipId, BAR + PPQ)).toBe(PPQ);
    expect(clipLocalTick(a, clipId, 2 * BAR)).toBeNull();
    const once: Arrangement = {
      ...a,
      clips: a.clips.map((c) => (c.id === clipId ? { ...c, fill: 'once' as const } : c)),
    };
    expect(clipLocalTick(once, clipId, BAR + PPQ)).toBeNull();
  });
});

describe('resolveWindow', () => {
  it('walks the whole song once, in time order', () => {
    const a = song();
    const events = resolveWindow(a, 0, arrangementTotalTicks(a));
    expect(events.map((e) => e.absTick)).toEqual([
      0, PPQ * 2, BAR, BAR + PPQ * 2, 2 * BAR, 2 * BAR + PPQ * 2, 3 * BAR, 3 * BAR + PPQ * 2,
    ]);
    expect(events[0]).toMatchObject({ trackId: 'track_bass', midi: 36, velocity: 0.8 });
  });

  it('is half-open: the start tick is in, the end tick is not', () => {
    const a = song();
    expect(ticks(a, 0, PPQ * 2)).toEqual([0]);
    expect(ticks(a, PPQ * 2, PPQ * 2 + 1)).toEqual([PPQ * 2]);
  });

  it('loops a short pattern to fill its section, and once plays it once', () => {
    const a = song();
    expect(ticks(a, 0, 2 * BAR)).toEqual([0, PPQ * 2, BAR, BAR + PPQ * 2]);
    const once: Arrangement = {
      ...a,
      clips: a.clips.map((c) => (c.sectionId === 'sec_intro' ? { ...c, fill: 'once' as const } : c)),
    };
    expect(ticks(once, 0, 2 * BAR)).toEqual([0, PPQ * 2]);
  });

  it('carries a window straight across a section boundary', () => {
    const a = song();
    // The last note of the intro and the first of the drop, in one window.
    expect(ticks(a, BAR + PPQ * 2, 2 * BAR + 1)).toEqual([BAR + PPQ * 2, 2 * BAR]);
  });

  it('stops at the end of the arrangement when not looping', () => {
    const a = song();
    const total = arrangementTotalTicks(a);
    expect(ticks(a, total - PPQ, total + 4 * BAR)).toEqual([]);
  });

  it('wraps at the end when looping, on an unwrapped timeline', () => {
    const a = song();
    const total = arrangementTotalTicks(a);
    const events = resolveWindow(a, total - PPQ, total + PPQ, { loop: true });
    // The song's first note comes back as "next lap", not as ancient history.
    expect(events.map((e) => e.absTick)).toEqual([total]);
    expect(events[0]?.midi).toBe(36);
  });

  it('a window longer than the song yields each note at most once', () => {
    const a = song();
    const total = arrangementTotalTicks(a);
    const events = resolveWindow(a, 0, total * 3, { loop: true });
    expect(events).toHaveLength(8);
    expect(new Set(events.map((e) => e.absTick)).size).toBe(8);
  });

  it('sounds every clip in a cell when two overlap on one track', () => {
    const a = song();
    const extra = addPattern(a, { name: 'B', lengthBars: 1, notes: [note('n9', 60, 0)] });
    if (!extra.ok) throw new Error('pattern');
    const overlapping: ClipRecord = {
      id: 'clip_overlap',
      trackId: 'track_bass',
      sectionId: 'sec_intro',
      patternId: extra.id,
    };
    const doubled: Arrangement = {
      ...extra.arrangement,
      clips: [...extra.arrangement.clips, overlapping],
    };
    const events = resolveWindow(doubled, 0, 1);
    expect(events.map((e) => e.midi)).toEqual([36, 60]);
    expect(events.map((e) => e.clipId)).toEqual(['clip_track_bass_sec_intro', 'clip_overlap']);
  });

  it('honours mute, clip mute and solo', () => {
    const a = song();
    expect(ticks(setTrackMuted(a, 'track_bass', true), 0, 4 * BAR)).toEqual([]);
    const clipMuted: Arrangement = {
      ...a,
      clips: a.clips.map((c) => ({ ...c, muted: c.sectionId === 'sec_intro' })),
    };
    expect(ticks(clipMuted, 0, 2 * BAR)).toEqual([]);
    const withLead = addTrack(a, { name: 'Lead', engineId: 'fm' });
    if (!withLead.ok) throw new Error(withLead.reason);
    expect(ticks(setSolo(withLead.arrangement, 'track_lead'), 0, 4 * BAR)).toEqual([]);
  });

  it('is silent for a track this build cannot play', () => {
    const a = song();
    const broken: Arrangement = {
      ...a,
      tracks: a.tracks.map((t) => ({ ...t, unplayable: 'unknown engine "zither"' })),
    };
    expect(ticks(broken, 0, 4 * BAR)).toEqual([]);
  });

  it('transposes and scales velocity per clip, and drops notes pushed off the keyboard', () => {
    const a = setClipTranspose(song(), song().clips[0]?.id ?? '', 12);
    const first = resolveWindow(a, 0, 1)[0];
    expect(first?.midi).toBe(48);
    const scaled: Arrangement = {
      ...a,
      clips: a.clips.map((c) => ({ ...c, velocityScale: 2 })),
    };
    expect(resolveWindow(scaled, 0, 1)[0]?.velocity).toBe(1);
    const off: Arrangement = {
      ...a,
      clips: a.clips.map((c) => ({ ...c, transpose: -24 })),
      patterns: { pat_a: { ...a.patterns['pat_a']!, notes: [note('low', 3, 0)] } },
    };
    expect(resolveWindow(off, 0, 1)).toEqual([]);
  });

  it('is deterministic: the same window twice is the same array', () => {
    const a = song();
    const once = resolveWindow(a, 0, 4 * BAR);
    const twice = resolveWindow(a, 0, 4 * BAR);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    // And clip order in the arrangement must not change what comes out.
    const reordered: Arrangement = { ...a, clips: [...a.clips].reverse() };
    expect(JSON.stringify(resolveWindow(reordered, 0, 4 * BAR))).toBe(JSON.stringify(once));
  });

  it('returns nothing for an empty or backwards window', () => {
    const a = song();
    expect(resolveWindow(a, 100, 100)).toEqual([]);
    expect(resolveWindow(a, 100, 10)).toEqual([]);
    expect(resolveWindow(createArrangement({ name: 'Empty', sections: [] }), 0, 999)).toEqual([]);
  });
});

describe('patterns', () => {
  it('drops notes that fall outside the pattern instead of re-homing them', () => {
    const a = setPatternNotes(song(), 'pat_a', [
      note('in', 36, 0),
      note('late', 40, BAR * 4),
      note('early', 41, -1),
    ]);
    expect(a.patterns['pat_a']?.notes.map((n) => n.id)).toEqual(['in']);
  });

  it('hands the sequencer SeqNotes with pass filled in', () => {
    const a = song();
    const pattern = a.patterns['pat_a'];
    expect(pattern).toBeDefined();
    if (pattern === undefined) return;
    expect(toSeqNotes(pattern).every((n) => n.pass === 0)).toBe(true);
  });
});
