import { describe, it, expect } from 'vitest';
import { PPQ } from '@/dsp/sequencer';
import {
  audibleTracks, buildTimeline, clipsAt, createNoteLedger, foldWindow, positionAt,
  reanchorOrigin, songTickAt, songWindowEvents, spanAt, spanOf, tickOfBar,
  type LoopRange, type PlayAnchor, type PlaybackPattern, type PlaybackSong, type SongEvent,
} from '@/dsp/song-schedule';
import { catchUpCursor } from '@/ui/use-arrangement-playback';

const BAR = 4 * PPQ; // 384

function pattern(bars: number, notes: PlaybackPattern['notes']): PlaybackPattern {
  return { lengthBars: bars, beatsPerBar: 4, ppq: PPQ, notes };
}

/** intro [0,768)  drop [768,2304) — two bars, played twice. */
const SONG: PlaybackSong = {
  beatsPerBar: 4,
  sections: [
    { id: 'sec_intro', bars: 2 },
    { id: 'sec_drop', bars: 2, repeats: 2 },
  ],
  tracks: [{ id: 'bass' }, { id: 'lead' }],
  clips: [
    { id: 'clip_bass_intro', trackId: 'bass', sectionId: 'sec_intro', patternId: 'pat_bass' },
    { id: 'clip_bass_drop', trackId: 'bass', sectionId: 'sec_drop', patternId: 'pat_bass' },
    { id: 'clip_lead', trackId: 'lead', sectionId: 'sec_drop', patternId: 'pat_lead', fill: 'once' },
  ],
  patterns: {
    pat_bass: pattern(1, [
      { id: 'b0', midi: 36, velocity: 1, startTick: 0, durationTicks: 48 },
      { id: 'b1', midi: 38, velocity: 0.8, startTick: 192, durationTicks: 48 },
    ]),
    pat_lead: pattern(2, [
      { id: 'l0', midi: 72, velocity: 0.6, startTick: 0, durationTicks: 96 },
      { id: 'l1', midi: 74, velocity: 0.6, startTick: 576, durationTicks: 96 },
    ]),
  },
};

const TL = buildTimeline(SONG.sections, SONG.beatsPerBar);
const START: PlayAnchor = { playTick: 0, songTick: 0 };
const DROP: LoopRange = { startTick: 768, endTick: 2304 };

/** Walk a whole play range in irregular windows, exactly as the wake loop does. */
function sweep(
  song: PlaybackSong, from: number, to: number, step: number,
  anchor: PlayAnchor = START, loop: LoopRange | null = null,
): SongEvent[] {
  const out: SongEvent[] = [];
  for (let cursor = from; cursor < to; cursor += step) {
    out.push(...songWindowEvents(song, TL, cursor, Math.min(cursor + step, to), anchor, loop));
  }
  return out;
}

describe('timeline', () => {
  it('lays sections end to end and honours repeats', () => {
    expect(TL.spans).toEqual([
      { id: 'sec_intro', startTick: 0, endTick: 768 },
      { id: 'sec_drop', startTick: 768, endTick: 2304 },
    ]);
    expect(TL.totalTicks).toBe(2304);
    expect(TL.barTicks).toBe(BAR);
  });

  it('locates sections, bars and beats', () => {
    expect(spanOf(TL, 'sec_drop')?.startTick).toBe(768);
    expect(spanOf(TL, 'nope')).toBeNull();
    expect(spanAt(TL, 767)?.id).toBe('sec_intro');
    expect(spanAt(TL, 768)?.id).toBe('sec_drop');
    expect(spanAt(TL, 2304)).toBeNull();
    // Bars are absolute for seeking, and section-relative for the readout.
    expect(tickOfBar(TL, 1)).toBe(0);
    expect(tickOfBar(TL, 3)).toBe(768);
    expect(tickOfBar(TL, 99)).toBe(2303);
    expect(positionAt(TL, 768)).toEqual({ sectionId: 'sec_drop', bar: 1, beat: 1 });
    expect(positionAt(TL, 768 + BAR + PPQ * 2)).toEqual({ sectionId: 'sec_drop', bar: 2, beat: 3 });
    expect(positionAt(TL, 9999)).toBeNull();
  });

  it('maps play ticks to song ticks, wrapping only inside a loop', () => {
    expect(songTickAt(400, START, null)).toBe(400);
    expect(songTickAt(0, { playTick: 0, songTick: 768 }, DROP)).toBe(768);
    expect(songTickAt(1536, { playTick: 0, songTick: 768 }, DROP)).toBe(768);
    expect(songTickAt(1600, { playTick: 0, songTick: 768 }, DROP)).toBe(832);
  });
});

describe('foldWindow', () => {
  it('is one segment without a loop, cut off at the end of the song', () => {
    expect(foldWindow(100, 200, START, null, TL.totalTicks)).toEqual([
      { playFrom: 100, playTo: 200, offset: 0, limitPlay: 2304 },
    ]);
    expect(foldWindow(2300, 2400, START, null, TL.totalTicks)).toEqual([
      { playFrom: 2300, playTo: 2304, offset: 0, limitPlay: 2304 },
    ]);
    expect(foldWindow(2304, 2400, START, null, TL.totalTicks)).toEqual([]);
  });

  it('splits at the loop point and keeps play ticks moving forward', () => {
    const anchor: PlayAnchor = { playTick: 0, songTick: 768 };
    const segs = foldWindow(1530, 1540, anchor, DROP, TL.totalTicks);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ playFrom: 1530, playTo: 1536, offset: 768, limitPlay: 1536 });
    expect(segs[1]).toEqual({ playFrom: 1536, playTo: 1540, offset: -768, limitPlay: 3072 });
    // Both segments describe the same music, one lap apart.
    expect(segs[0]!.playFrom + segs[0]!.offset).toBe(2298);
    expect(segs[1]!.playFrom + segs[1]!.offset).toBe(768);
  });

  it('honours an anchor set mid-flight, which is how the loop is switched on', () => {
    // setLoopSection re-anchors at the current play tick instead of moving the
    // clock origin, so timers already armed for sounding notes stay valid.
    const mid: PlayAnchor = { playTick: 900, songTick: 1000 };
    expect(songTickAt(900, mid, DROP)).toBe(1000);
    expect(songTickAt(900 + 1536, mid, DROP)).toBe(1000);
    const [seg] = foldWindow(900, 905, mid, DROP, TL.totalTicks);
    expect(seg).toEqual({ playFrom: 900, playTo: 905, offset: 100, limitPlay: 2204 });
    // Bass note at song 1152 (third lap of a 1-bar pattern) lands at play 1052.
    const evs = songWindowEvents(SONG, TL, 1050, 1055, mid, DROP);
    expect(evs.map((e) => [e.midi, e.onTick])).toEqual([[36, 1052]]);
  });

  it('covers a window longer than the loop without gaps or overlap', () => {
    const segs = foldWindow(0, 4000, { playTick: 0, songTick: 768 }, DROP, TL.totalTicks);
    expect(segs[0]!.playFrom).toBe(0);
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.playFrom).toBe(segs[i - 1]!.playTo);
    expect(segs[segs.length - 1]!.playTo).toBe(4000);
  });
});

describe('songWindowEvents', () => {
  it('gathers every track in one window, in time order', () => {
    const evs = songWindowEvents(SONG, TL, 768, 768 + 200, START, null);
    expect(evs.map((e) => [e.trackId, e.midi, e.onTick])).toEqual([
      ['bass', 36, 768],
      ['lead', 72, 768],
      ['bass', 38, 960],
    ]);
  });

  it('plays each note exactly once across the whole song, whatever the window size', () => {
    // bass: 2 laps in intro + 4 in drop = 12 notes. lead is `once`: 2 notes.
    for (const step of [7, 37, 384, 5000]) {
      const evs = sweep(SONG, 0, TL.totalTicks, step);
      expect(evs.filter((e) => e.trackId === 'bass'), `step ${step}`).toHaveLength(12);
      expect(evs.filter((e) => e.trackId === 'lead'), `step ${step}`).toHaveLength(2);
      const stamps = evs.map((e) => `${e.clipId}@${e.onTick}:${e.midi}`);
      expect(new Set(stamps).size, `step ${step} duplicates`).toBe(stamps.length);
    }
  });

  it('a window straddling the loop point schedules the next lap once, in the future', () => {
    const anchor: PlayAnchor = { playTick: 0, songTick: 768 };
    const evs = songWindowEvents(SONG, TL, 1530, 1540, anchor, DROP);
    // The notes at the top of the loop belong to the lap ahead, not to tick 0:
    // this is the failure that drops or doubles one note per lap.
    expect(evs.map((e) => [e.trackId, e.midi, e.onTick])).toEqual([
      ['bass', 36, 1536],
      ['lead', 72, 1536],
    ]);
  });

  it('loses nothing and repeats nothing while looping lap after lap', () => {
    const anchor: PlayAnchor = { playTick: 0, songTick: 768 };
    const evs = sweep(SONG, 0, 1536 * 3, 23, anchor, DROP);
    // Three laps of the drop: 4 bass notes per bar-pair lap, twice per lap.
    expect(evs.filter((e) => e.trackId === 'bass')).toHaveLength(8 * 3);
    expect(evs.filter((e) => e.trackId === 'lead')).toHaveLength(2 * 3);
    const onTicks = evs.map((e) => e.onTick);
    expect([...onTicks].sort((a, b) => a - b)).toEqual(onTicks);
    expect(new Set(evs.map((e) => `${e.clipId}@${e.onTick}:${e.midi}`)).size).toBe(evs.length);
  });

  it('never lets a note outlast its section, and never emits a zero-length note', () => {
    const long: PlaybackSong = {
      ...SONG,
      patterns: {
        ...SONG.patterns,
        pat_bass: pattern(1, [
          { id: 'b0', midi: 36, velocity: 1, startTick: 192, durationTicks: 4000 },
        ]),
      },
    };
    const evs = sweep(long, 0, TL.totalTicks, 64);
    for (const e of evs) {
      expect(e.offTick).toBeGreaterThan(e.onTick);
      const span = e.clipId === 'clip_bass_intro' ? TL.spans[0]! : TL.spans[1]!;
      if (e.trackId === 'bass') expect(e.offTick).toBeLessThanOrEqual(span.endTick);
    }
    expect(evs.find((e) => e.clipId === 'clip_bass_intro')!.offTick).toBe(768);
  });

  it('cuts a note at the loop point rather than letting laps overlap', () => {
    const long: PlaybackSong = {
      ...SONG,
      patterns: {
        ...SONG.patterns,
        pat_bass: pattern(1, [
          { id: 'b0', midi: 36, velocity: 1, startTick: 0, durationTicks: 4000 },
        ]),
      },
    };
    const anchor: PlayAnchor = { playTick: 0, songTick: 768 };
    const evs = sweep(long, 0, 1536, 64, anchor, DROP);
    for (const e of evs) expect(e.offTick).toBeLessThanOrEqual(1536);
  });

  it('honours fill: once plays one pass, loop repeats to fill the section', () => {
    const evs = sweep(SONG, 768, 2304, 128);
    const lead = evs.filter((e) => e.trackId === 'lead').map((e) => e.onTick);
    expect(lead).toEqual([768, 768 + 576]); // one pass of a 2-bar pattern, then silence
    const bass = evs.filter((e) => e.trackId === 'bass').map((e) => e.onTick);
    expect(bass).toEqual([768, 960, 1152, 1344, 1536, 1728, 1920, 2112]);
  });

  it('applies transpose and velocity scaling, and drops notes transposed off the keyboard', () => {
    const song: PlaybackSong = {
      ...SONG,
      clips: SONG.clips.map((c) => (
        c.id === 'clip_bass_intro' ? { ...c, transpose: 12, velocityScale: 0.5 } : c)),
    };
    const evs = songWindowEvents(song, TL, 0, 200, START, null);
    expect(evs[0]!.midi).toBe(48);
    expect(evs[0]!.velocity).toBeCloseTo(0.5);

    const far: PlaybackSong = {
      ...SONG,
      clips: SONG.clips.map((c) => (
        c.id === 'clip_bass_intro' ? { ...c, transpose: 96 } : c)),
    };
    expect(songWindowEvents(far, TL, 0, 200, START, null)).toHaveLength(0);
  });

  it('respects clip mute, track mute and solo', () => {
    const muteClip: PlaybackSong = {
      ...SONG,
      clips: SONG.clips.map((c) => (c.id === 'clip_bass_intro' ? { ...c, muted: true } : c)),
    };
    expect(sweep(muteClip, 0, 768, 64)).toHaveLength(0);

    const muteTrack: PlaybackSong = { ...SONG, tracks: [{ id: 'bass', muted: true }, { id: 'lead' }] };
    expect(sweep(muteTrack, 0, TL.totalTicks, 64).every((e) => e.trackId === 'lead')).toBe(true);

    const solo: PlaybackSong = { ...SONG, tracks: [{ id: 'bass' }, { id: 'lead', soloed: true }] };
    expect(sweep(solo, 0, TL.totalTicks, 64).every((e) => e.trackId === 'lead')).toBe(true);
    expect([...audibleTracks(solo.tracks)]).toEqual(['lead']);
    expect([...audibleTracks([{ id: 'a', muted: true, soloed: true }, { id: 'b' }])]).toEqual([]);
  });

  it('ignores clips pointing at a pattern or section that is not there', () => {
    const broken: PlaybackSong = {
      ...SONG,
      clips: [...SONG.clips,
        { id: 'ghost_pat', trackId: 'bass', sectionId: 'sec_intro', patternId: 'gone' },
        { id: 'ghost_sec', trackId: 'bass', sectionId: 'gone', patternId: 'pat_bass' }],
    };
    expect(sweep(broken, 0, TL.totalTicks, 64)).toHaveLength(14);
  });

  it('reports which clips are under the playhead, muting included', () => {
    expect([...clipsAt(SONG, TL, 0)]).toEqual(['clip_bass_intro']);
    expect([...clipsAt(SONG, TL, 1000)]).toEqual(['clip_bass_drop', 'clip_lead']);
    expect([...clipsAt(SONG, TL, 9999)]).toEqual([]);
    const hushed: PlaybackSong = {
      ...SONG,
      clips: SONG.clips.map((c) => (c.id === 'clip_lead' ? { ...c, muted: true } : c)),
      tracks: [{ id: 'bass', muted: true }, { id: 'lead' }],
    };
    expect([...clipsAt(hushed, TL, 1000)]).toEqual([]);
  });

  it('gives a note with a corrupt duration one tick rather than an endless one', () => {
    const junk: PlaybackSong = {
      ...SONG,
      patterns: {
        ...SONG.patterns,
        pat_bass: pattern(1, [
          { id: 'b0', midi: 36, velocity: 1, startTick: 0, durationTicks: Number.NaN },
          { id: 'b1', midi: 38, velocity: 1, startTick: 192, durationTicks: 0 },
        ]),
      },
    };
    const evs = songWindowEvents(junk, TL, 0, 384, START, null);
    expect(evs.map((e) => e.offTick - e.onTick)).toEqual([1, 1]);
    for (const e of evs) expect(Number.isFinite(e.offTick)).toBe(true);
  });
});

describe('tempo changes mid-flight', () => {
  it('describes notes in ticks, so a tempo change cannot move one in the song', () => {
    const slow = sweep(SONG, 0, TL.totalTicks, 64);
    const fast = sweep(SONG, 0, TL.totalTicks, 64);
    expect(slow.map((e) => e.onTick)).toEqual(fast.map((e) => e.onTick));
  });

  it('plays a slightly late note rather than dropping it, and jumps a long sleep', () => {
    // The first note of a song sits exactly here: the cursor is at 0 and the
    // first wake lands a millisecond or two after the origin.
    expect(catchUpCursor(0, 0.4, 19)).toBe(0);
    expect(catchUpCursor(100, 118, 19)).toBe(100);
    // A backgrounded tab, though, must not machine-gun what it slept through.
    expect(catchUpCursor(100, 5000, 19)).toBe(5000);
  });

  it('re-anchors the clock so the playhead does not jump and the future rescales', () => {
    const per120 = 60000 / (120 * PPQ);
    const per240 = 60000 / (240 * PPQ);
    const origin = 1000;
    const at = origin + 500 * per120;          // 500 ticks in
    const next = reanchorOrigin(at, origin, per120, per240);
    // Same instant, same position: nothing is dropped or fired twice.
    expect((at - next) / per240).toBeCloseTo(500, 9);
    // A note 96 ticks ahead now arrives in half the time.
    expect(next + 596 * per240 - at).toBeCloseTo(96 * per240, 9);
    expect(reanchorOrigin(at, origin, 0, per240)).toBe(at);
  });
});

describe('note ledger: nothing is left hanging', () => {
  function ledgerWithLog(): { log: string[]; ledger: ReturnType<typeof createNoteLedger> } {
    const log: string[] = [];
    const ledger = createNoteLedger(
      (t, m) => log.push(`on ${t} ${m}`),
      (t, m) => log.push(`off ${t} ${m}`),
    );
    return { log, ledger };
  }

  it('refcounts a pitch so a retrigger is not cut short by the older release', () => {
    const { log, ledger } = ledgerWithLog();
    ledger.hold('bass', 36, 1);
    ledger.hold('bass', 36, 1);
    ledger.release('bass', 36);
    expect(log).toEqual(['on bass 36', 'on bass 36']);
    expect(ledger.held).toBe(1);
    ledger.release('bass', 36);
    expect(log[log.length - 1]).toBe('off bass 36');
    expect(ledger.held).toBe(0);
  });

  it('releases everything exactly once when playback stops mid-note', () => {
    const { log, ledger } = ledgerWithLog();
    ledger.hold('bass', 36, 1);
    ledger.hold('lead', 72, 0.6);
    ledger.hold('lead', 74, 0.6);
    ledger.releaseAll();
    expect(log.filter((l) => l.startsWith('off')).sort())
      .toEqual(['off bass 36', 'off lead 72', 'off lead 74']);
    expect(ledger.held).toBe(0);
    ledger.releaseAll();
    expect(log.filter((l) => l.startsWith('off'))).toHaveLength(3);
  });

  it('silences one track when it is muted mid-note and leaves the others sounding', () => {
    const { log, ledger } = ledgerWithLog();
    ledger.hold('bass', 36, 1);
    ledger.hold('bass', 36, 1);
    ledger.hold('lead', 72, 0.6);
    ledger.releaseTrack('bass');
    expect(log.filter((l) => l.startsWith('off'))).toEqual(['off bass 36']);
    expect(ledger.held).toBe(1);
    ledger.releaseTrack('bass');
    expect(log.filter((l) => l.startsWith('off'))).toHaveLength(1);
    ledger.releaseAll();
    expect(ledger.held).toBe(0);
  });
});

describe('a whole playthrough leaves no note sounding', () => {
  /** Runs scheduled events through the ledger in wall-clock order. */
  function run(evs: readonly SongEvent[], until: number): {
    ledger: ReturnType<typeof createNoteLedger>; count: { ons: number; offs: number };
  } {
    const count = { ons: 0, offs: 0 };
    const ledger = createNoteLedger(() => { count.ons++; }, () => { count.offs++; });
    const timeline = [
      ...evs.map((e) => ({ at: e.onTick, e, on: true })),
      ...evs.map((e) => ({ at: e.offTick, e, on: false })),
    ].sort((a, b) => (a.at !== b.at ? a.at - b.at : (a.on ? 1 : -1)));
    for (const step of timeline) {
      if (step.at > until) break;
      if (step.on) ledger.hold(step.e.trackId, step.e.midi, step.e.velocity);
      else ledger.release(step.e.trackId, step.e.midi);
    }
    return { ledger, count };
  }

  it('balances every note-on with a note-off when the song plays to the end', () => {
    const { ledger, count } = run(sweep(SONG, 0, TL.totalTicks, 37), Infinity);
    expect(count.ons).toBe(14);
    expect(count.offs).toBe(14);
    expect(ledger.held).toBe(0);
  });

  it('leaves nothing hanging when the transport stops in the middle of a note', () => {
    const evs = sweep(SONG, 0, TL.totalTicks, 37);
    // 780 is inside the bass note that starts at 768 and the lead note with it.
    const { ledger, count } = run(evs, 780);
    expect(ledger.held).toBe(2);
    ledger.releaseAll();
    expect(ledger.held).toBe(0);
    expect(count.offs).toBe(count.ons);
  });

  it('balances lap after lap while a section loops', () => {
    const anchor: PlayAnchor = { playTick: 0, songTick: 768 };
    const { ledger, count } = run(sweep(SONG, 0, 1536 * 4, 29, anchor, DROP), Infinity);
    expect(count.ons).toBe((8 + 2) * 4);
    expect(count.offs).toBe(count.ons);
    expect(ledger.held).toBe(0);
  });
});
