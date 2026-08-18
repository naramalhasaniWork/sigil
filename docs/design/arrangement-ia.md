# SIGIL — Arrangement information architecture

**Date:** 2026-08-18
**Status:** Design decision. Nothing here is built.
**Author:** Information architecture pass, commissioned because the owner floated "a window
on the side" and explicitly said he was not sure.

> "I dont want to recreate Ableton, i just want music making process to be simple…
> being able to switch to a timeline view that takes all the functions and opens a window
> on the side with the timeline would be great or something, im not sure, have an
> information architect find the best way."

This document answers that. It rejects the side panel, for a geometric reason, and proposes
something else in its place.

---

## 0. What is actually there today

Every claim below was read out of the files, not remembered.

**The surface.** `app/page.tsx` is 462 lines and holds the entire UI. It has **six** top-level
tabs, not five — `['sculpt', 'deep', 'fx', 'hunt', 'export', 'setup']` (app/page.tsx:185). A
left `<aside className="md:w-40">` holds `EngineRail` over `PresetPanel`. A `<footer>` holds a
layout switch (keys/pads), an octave stepper, Panic, the `ScalePicker`, and then either `Keys`
or `PadGrid`. The whole thing is `flex-col md:flex-row` — on a phone the rail is already
stacked above the centre, not beside it.

**The controller.** `src/ui/use-instrument.ts` is 824 lines and returns a 40-key object
(use-instrument.ts:802-823). It holds exactly one `hostRef: EngineHost`, one `engineId`, one
`values` record keyed by engine id, one `fxValues`, one `magicValues`. It is, in every sense,
a single-instrument controller. It is also nearly 3× the 300-line house limit, which matters
below.

**The sequencer is real and it is orphaned.** `src/dsp/sequencer.ts` is pure loop maths at
PPQ 96 — `scheduleWindow`, `notesInWindow`, `quantise`, `removePass`, `beatsInWindow` — with
27 tests in `tests/dsp/sequencer.test.ts` covering the loop-point wrap, half-open windows,
partial quantisation and immutability. `src/ui/use-sequencer.ts` wraps it in a lookahead
transport with wall-clock-derived position, per-pitch refcounted note-off, overdub passes and
per-pass undo. `grep -rn "useSequencer" src app` returns exactly one hit: the definition
itself. **Nothing calls it.** This is the largest head start in the codebase.

**The versioning discipline.** `src/audio/patch-format.ts` is the reference. Values keyed by
parameter id, a `version` field, unknown ids ignored, missing ids filled from the parameter's
`default`, everything clamped to range, and every recovery pushed onto `warnings: string[]`
rather than swallowed. Its header comment states the stakes: *"In a plugin that becomes 'my
finished track opens sounding different', which is the refund and then the review."* The
arrangement format follows this and, in one place, goes further (§3.6).

**The decisive audio fact.** `src/audio/worklet/sigil-processor.ts` builds a `VoiceManager` for
every engine up front, but `process()` renders exactly one:

```
left.fill(0);
this.active.render(left, left.length);
```

One `active` manager, one `FxChain`, one `MagicChain`, per **processor instance**. That last
word is the whole design. A processor instance is per `AudioWorkletNode`, so **N tracks = N
nodes**, each with its own engine, its own FX and its own Character chain — with *zero*
changes to the worklet. The thing that assumes one node is `src/audio/engine-host.ts`, not the
DSP. Two costs come with that and both are measurable:

- Each `SigilProcessor` preallocates a 60-second capture buffer,
  `new Float32Array(Math.floor(sampleRate * 60))`. At 48 kHz that is **11.5 MB per node**.
  Eight tracks is ~92 MB resident before a single voice sounds.
- `setActiveSample` is a module-level global inside the worklet bundle
  (`src/dsp/sampler-voice.ts`, imported at sigil-processor.ts:7). All nodes in one
  `AudioContext` share the worklet global scope, so **two sampler tracks cannot hold different
  samples.** This is a hard limit until someone moves the sample onto the VoiceManager.

**Off limits.** `src/dsp/fx.ts`, `src/dsp/fx-magic.ts` and `src/audio/worklet/` are being made
stereo by another agent. Nothing in the recommended plan touches them, except one small,
clearly-sequenced extension in §5.4 that must wait.

---

## 1. The approach

### 1.1 The five shapes

**(a) A seventh top-level tab.** `['sculpt','deep','fx','hunt','arrange','export','setup']`.

*Cognitive cost:* it lies about the hierarchy. The existing tabs are all lenses on **one
sound** — sculpt is the macro view of it, deep is every parameter of it, fx is its tail, hunt
is six mutations of it. `arrange` would be a lens on **a set of sounds over time**, which is a
different noun sitting in a list that promises the same noun. The lie surfaces immediately at
the left rail: while you are on `arrange`, what does the highlighted engine in `EngineRail`
mean? It is the global engine, but the timeline has four tracks with four different engines.
There is no answer to that question, and unanswerable questions in an IA are where the design
fails six months later.

*Code cost:* lowest of all five. One string in a union, one branch in the centre pane.

**REJECTED.** Cheapest to build, and it puts an unanswerable question in the left rail.

**(b) A side panel alongside the current surface.** The owner's own suggestion.

*Cognitive cost:* moderate and survivable. Two live regions, one focus.

*Geometric cost:* fatal, and this is the reason to say no rather than a matter of taste. **A
timeline is a wide, short object. The free space in SIGIL is wide and short. A side panel is
narrow and tall.** Concretely: on a 1280px desktop the rail takes 160px, leaving ~1100px of
centre. Eight sections across 1100px is 137px each — comfortably legible, with room for a
section name, a bar count and four clip cells. Give the timeline a 380px side panel instead
and eight sections get 45px each, which is not a section header, it is a tick mark. You would
be forced either to shrink the song to three visible sections or to rotate the timeline
vertically, and a vertical timeline is a thing nobody has ever successfully asked a musician
to read. On a phone the panel cannot exist at all and degrades to a mode switch, so you build
option (c) anyway *and* keep the panel code.

*Code cost:* highest. Two layout paths, two responsive regimes, plus the mode switch you end
up building for mobile regardless.

**REJECTED.** The window should open **above**, not beside — same instinct, correct axis.

**(c) A mode switch that swaps the centre while rail and footer persist.**

*Cognitive cost:* one new concept — "am I working on the sound or on the song" — which is a
distinction musicians already hold. The rail and footer never move, so the app never feels
like it became a different program.

*Code cost:* moderate. One scope in `app/page.tsx`, a re-scoped rail, a new centre component,
a new controller hook. `EngineRail` and `PresetPanel` need **no prop changes at all** — their
props are already ids and callbacks (`{engines, activeId, onSelect}` at
engine-rail.tsx:12-16), so pointing them at a track instead of a global is a change in
`use-instrument.ts` only.

**This is the base of the recommendation.** See §1.2 for what has to be added to it.

**(d) An overlay floating over everything.**

*Cognitive cost:* an overlay says "you are doing a different thing now, finish and dismiss."
That is exactly wrong: arranging and playing are the same activity, alternating second by
second. Worse, it covers the footer, which is where the keyboard is — so you cannot play a
part while looking at where it goes. On an iPhone an overlay sitting on top of 44px touch
targets is the failure mode of every mobile DAW ever shipped.

*Code cost:* low-moderate, plus a focus trap, plus a scroll lock, plus a dismiss gesture that
must not collide with the pad grid.

**REJECTED.** It hides the instrument at the moment you need the instrument.

**(e) A session/clip-launcher grid.** SIGIL already has a 4×4 `PadGrid`; reusing it as a
scene launcher is genuinely tempting and costs almost nothing.

**REJECTED**, and specifically: it is a *performance* model, not a *finish a track* model. You
still cannot hand anyone a WAV of a fixed piece from a clip launcher — Ableton needed both
Session and Arrangement views for precisely this reason, and building both is how you end up
recreating Ableton. The owner asked for the opposite.

**(f) A section table rather than a canvas.** Not a rival to (c) — it is the *content* of (c),
and it is the most important decision in this document. See §1.3.

### 1.2 What ships: SONG SCOPE

**A two-state scope switch at the head of the existing tab strip. In SONG scope the centre
pane splits horizontally — song above, instrument below — the left rail re-scopes from engines
to tracks, and the footer is untouched.**

```
┌──────────────────────────────────────────────────────────────┐
│ AppHeader — unchanged (power, record, bounce, engine name)   │
├──────────┬───────────────────────────────────────────────────┤
│ TRACKS   │ ┃ SOUND │ SONG ┃ sculpt deep fx hunt export setup │
│  ▸ Bass  │ ┌───────────────────────────────────────────────┐ │
│  ▸ Keys  │ │  SongGrid   intro  A   B   A   drop  out      │ │  ← the "window",
│  ▸ Hats  │ │  Bass        ██   ██  ██  ██   ██     ·       │ │    opened ABOVE
│  + TRACK │ │  Keys         ·   ██  ██  ██   ██    ██       │ │
│──────────│ └───────────────────────────────────────────────┘ │
│ ENGINE   │  ── chevron: RIBBON / HALF / FULL ──              │
│  analog  │                                                   │
│  fm ...  │  tab content for the SELECTED TRACK               │
│──────────│  (sculpt / deep / fx / hunt, exactly as today)    │
│ PRESETS  │                                                   │
├──────────┴───────────────────────────────────────────────────┤
│ LoopStrip:  ● REC │ ▶ │ BARS 2 │ Q 1/16 50% │ UNDO │ CLEAR   │  ← new footer row
│ keys/pads · octave · Panic · ScalePicker · Keys or PadGrid   │  ← unchanged
└──────────────────────────────────────────────────────────────┘
```

Three parts, and each one is load-bearing:

**1. The scope switch, not a tab.** Two 44px buttons at the left of the tab strip, separated
from the tabs by a doubled 3px border so the eye reads them as a different *kind* of control.
`SOUND` is byte-for-byte today's app. `SONG` adds the grid above and re-points the rail.

**2. The split, not a swap.** The tabs keep meaning exactly what they mean — sculpt is still
the macros, deep is still every parameter — they just now edit **the selected track**. This is
why a mode switch that *replaces* the centre (naive option (c)) is not enough: you would have
to leave the song to change the sound of a track in it, which is the exact seam that makes
DAWs feel like two programs. The grid has three heights, cycled by one chevron, no drag
handle: `RIBBON` (44px, one row, playhead only), `HALF` (38% of the centre), `FULL` (tab
content hidden, tabs greyed; tapping a tab drops to HALF). Default: HALF on desktop, RIBBON
on phone.

**3. The loop pedal lives in the footer, not in the timeline.** This is the part that is
usually got wrong. You cannot arrange clips you never captured, and capturing a loop is a
*playing* gesture — your eyes are on the keyboard, not on the grid. So `use-sequencer.ts`
surfaces as a strip attached to the play surface, and the single most important interaction in
the whole feature is:

> **Hit REC. Play. You now have a clip in the song.**
> The loop records into whatever cell the playhead is over, on the selected track. If the cell
> is empty it is created. That is the entire path from "I found a sound" to "it is in a piece
> of music", and it is one button.

### 1.3 Clips do not float

**A clip is `(trackId, sectionId, patternId)`. Nothing else.**

The song is a list of named sections — `intro 8 bars`, `A 16`, `drop 16`, `out 8`. Every
section × track pair is one cell, and a cell either holds a clip or is empty. A clip shorter
than its section loops to fill it. There are no free-floating rectangles, no sub-bar offsets,
no independent clip lengths, no crossfades.

Why this and not a canvas:

- **It deletes the entire hard half of the feature.** No zoom, no scroll-lock, no snap
  settings, no grid divisions, no pixel-per-tick arithmetic, no drag hit-testing beyond
  "which cell". Those five things are most of what makes a timeline expensive to build and
  most of what makes it intimidating to use.
- **It is the same object on a phone and on a desktop.** A canvas is not; a table is. §6
  depends entirely on this decision.
- **It is what a language model can write.** `{"track":"bass","section":"drop","pattern":"p3"}`
  is a sentence an LLM emits correctly on the first try. `{"startTick": 6144}` is a sentence it
  gets wrong, and gets wrong silently. §3.7.
- **It matches how the owner describes songs.** Intro, verse, drop. Not tick 6144.

The cost is real and worth naming: you cannot have a fill that starts three beats before the
chorus. You can have a one-bar section called `fill`. That is a worse tool and a much better
product, and it is exactly the trade the owner asked for.

---

## 2. Where the instrument lives inside it

This is the join, and this is where the design fails if it fails. Every question below gets a
single answer, not an option.

### 2.1 A track owns a patch, and selecting a track loads it

**Yes — clicking a track loads its patch into the existing Sculpt surface, and into deep, fx
and hunt, unchanged.** There is exactly one live instrument at any moment; the arrangement
decides which patch is loaded into it. Anything else gives you two apps in one window.

Mechanically: `TrackRecord.patch` is a `SerialisedPatch` — the *same* type from
`src/audio/patch-format.ts`, not a parallel one. Selecting a track calls the existing
`loadPatch()` and pushes the result through the existing `loadValues` / `setFxParam` /
`setMagicParam` path (use-instrument.ts:209, :100, :110). Editing a parameter writes back to
the selected track. This is the same code path `importPatch` already uses at
use-instrument.ts:777.

### 2.2 The engine rail becomes track-scoped

In SONG scope the rail stacks: `TrackRail` on top, then `EngineRail`, then `PresetPanel`.
`EngineRail` now reads "engine of the selected track"; `PresetPanel` reads "presets for the
selected track's engine". **Neither component changes.** Their props are already
selection-agnostic — `EngineRail` takes `{engines, activeId, onSelect}` and knows nothing
about global state. The only file that has to learn about tracks is `use-instrument.ts`.

Changing a track's engine wipes that track's notes? No — notes are pitches, they survive an
engine change exactly as they do today when you hit a different engine mid-phrase. Changing
the engine resets that track's patch to the new engine's defaults, with the previous engine's
values retained in `values[engineId]` per-track, which is the behaviour `use-instrument.ts`
already has for the global case.

### 2.3 The footer keyboard when a track is selected

- **It plays the selected track**, with that track's patch, through that track's node,
  immediately, whether or not the song is rolling. No arm, no click-to-enable.
- **If the song is rolling and REC is lit**, what you play is written into the cell under the
  playhead on the selected track. If that cell is empty, the clip is created on the first
  note.
- **Octave, scale, root and keys/pads stay global.** They are properties of the play surface,
  not of a track — you do not want the octave to jump when you tap a different track row.
  Loading an arrangement *seeds* them from `KeySpec` (§3.2), and after that they are yours.
- **Mute mutes both.** Playing a muted track's keys makes no sound and the mute button
  flashes. The alternative — live monitoring survives mute — needs a second concept (monitor
  vs. arrangement mute) and buys nothing here. One rule, and the unmute is one tap away in the
  same row you are already looking at.
- **Solo is a radio, not a checkbox.** At most one soloed track. Multi-solo is a mixing
  workflow and this app has no mixer.
- **Panic kills every track**, not the selected one. `TrackPool.allNotesOff()`. The button's
  held-note count (`inst.held.size` at app/page.tsx:361) becomes the sum across tracks.

### 2.4 The audio graph

One `AudioContext`. One `AudioWorkletNode` per track, each `setEngine`'d independently, each
carrying its own `FxChain` and `MagicChain` for free (§0). All nodes sum into one master
`GainNode` → the existing `AnalyserNode` → destination, so `Scope` and `Spectrum` show the mix
without changing (they take `analyser` as a prop, app/page.tsx:229).

**No worklet change is required for live multi-track playback.** That is the whole reason this
plan is affordable and the reason it does not collide with the stereo agent.

Constraints inherited from §0, restated as product rules:

| Constraint | Product rule |
|---|---|
| 11.5 MB capture buffer per node at 48 kHz | Hard cap of **8 tracks**. See §5.4. |
| `setActiveSample` is a worklet-module global | **At most one sampler track per song.** The UI must refuse the second and say why. |
| Voices are mono until the stereo work lands | `TrackRecord.pan` is in the format from day one, ignored by the renderer until it can be honoured. |
| No bus/send node exists | No master FX. Master is one gain. §5.1. |

### 2.5 The transport

Do **not** run one `useSequencer` per track. Each instance owns its own `originRef` and its
own 25 ms `setInterval` (use-sequencer.ts:212-217); eight of them would drift apart and each
would independently machine-gun on tab resume.

Instead: **one clock, N pattern queries.** `src/dsp/sequencer.ts` is already the right shape
for this — `scheduleWindow(pattern, from, to)` is stateless and per-pattern. A new
`use-song-transport.ts` keeps one wall-clock origin and, on each 25 ms wake, calls
`scheduleWindow` once per sounding clip with the window translated into that clip's local
ticks. `src/dsp/sequencer.ts` is reused **verbatim**; its loop-wrapping behaviour is exactly
what a clip-fills-its-section needs. `src/ui/use-sequencer.ts` stays what it is — the loop
pedal for a single cell.

### 2.6 The one-track invariant

**With exactly one track, SIGIL must behave identically to today.** This is a testable
promise, and it is the whole "do not wreck the thing that works" guarantee.

On first run the arrangement contains one track named `Scratch`, holding whatever is in
`sigil.session.v2` (use-instrument.ts:42). SOUND scope renders precisely today's app. The app
becomes a song at exactly one gesture — `+ TRACK` — and not before.

Migration is one-way and non-destructive: read `sigil.session.v2`, write
`sigil.arrangement.v1`, and **leave the old key in place** for at least one release so a
rollback does not eat anyone's sound.

### 2.7 Where `use-instrument.ts` has to give

`use-instrument.ts` is 824 lines against a 300-line house rule and it currently owns
`hostRef`. Rather than growing it, take one surgical change: it accepts an **injected host and
patch**, so it can be pointed at the selected track's node instead of creating its own. Track
state, selection, the song and persistence live in a new `use-arrangement.ts`. That is the
seam; nothing else in `use-instrument.ts` moves in this pass. Splitting the rest of it is
worth doing and is a separate task.

---

## 3. The arrangement data model

`src/audio/arrangement-format.ts`. **Zero React imports, zero DOM imports, zero
`Float32Array` in the serialised shape** — same discipline as `patch-format.ts` and
`sequencer.ts`, because this file is one of the ones that ports to C++.

### 3.1 Top level

```ts
export const ARRANGEMENT_FORMAT_VERSION = 1;

export interface SerialisedArrangement {
  version: number;
  id: string;
  name: string;
  savedAt?: string;
  tempo: TempoSpec;
  key: KeySpec;
  /** Song order IS array order. See §3.5. */
  sections: readonly SectionRecord[];
  tracks: readonly TrackRecord[];
  /** Keyed by pattern id so several clips can share one pattern. */
  patterns: Readonly<Record<string, PatternRecord>>;
  clips: readonly ClipRecord[];
  master?: MasterRecord;
  /** Anything a newer build wrote and this one does not understand. Preserved
   *  verbatim across a load→save round trip. See §3.6. */
  meta?: Readonly<Record<string, unknown>>;
}
```

### 3.2 Tempo and key

```ts
export interface TempoSpec {
  /** 20..300, matching MIN_BPM/MAX_BPM in src/ui/use-sequencer.ts. */
  bpm: number;
  /** Matches Pattern.beatsPerBar in src/dsp/sequencer.ts. */
  beatsPerBar: number;
  /** Must equal PPQ (96). A different value is rescaled on load, with a warning. */
  ppq: number;
}

export interface KeySpec {
  /** Pitch class 0..11, same convention as scale-picker.tsx NOTE_NAMES. */
  root: number;
  /** A key of SCALES in src/dsp/chords.ts. */
  scale: ScaleName;
}
```

One tempo and one time signature per song. §5.1.

### 3.3 Sections, tracks, patterns, clips

```ts
export interface SectionRecord {
  id: string;
  /** "Intro", "A", "Drop". Displayed in --ink, never --muted. */
  name: string;
  /** 1..64. */
  bars: number;
  /** Play the whole section this many times. Default 1. */
  repeats?: number;
  colour?: string;
}

export interface TrackRecord {
  id: string;
  name: string;
  /** An id from ENGINES in src/dsp/registry.ts. */
  engineId: string;
  /** The full sound. Same type as a saved preset — not a parallel format. */
  patch?: SerialisedPatch;
  /** Alternative to `patch`: a PRESETS id, resolved through presetToValues()
   *  at load. Lets a composer name a sound instead of emitting 30 floats. §3.7.
   *  If both are present, `patch` wins. */
  presetId?: string;
  /** 0..1, default 0.8. */
  gain?: number;
  /** -1..1, default 0. Stored now, honoured once voices are stereo. */
  pan?: number;
  muted?: boolean;
  soloed?: boolean;
  colour?: string;
  /** Sampler tracks: the sample's NAME only. Bytes never enter this file —
   *  same reason the kit and export tray are excluded from the session
   *  (see the SESSION_KEY comment in src/ui/use-instrument.ts). */
  sampleRef?: string;
}

export interface NoteRecord {
  id: string;
  /** 0..127. */
  midi: number;
  /** 0..1, matching SeqNote.velocity. */
  velocity: number;
  /** Clip-local, in [0, patternTicks). */
  startTick: number;
  durationTicks: number;
  /** Overdub layer, default 0. Present so a recorded pattern round-trips
   *  through SeqNote losslessly and per-pass undo survives a save. */
  pass?: number;
}

export interface PatternRecord {
  id: string;
  name?: string;
  lengthBars: number;
  beatsPerBar: number;
  ppq: number;
  notes: readonly NoteRecord[];
}

export interface ClipRecord {
  id: string;
  trackId: string;
  sectionId: string;
  patternId: string;
  /** 'loop' repeats the pattern to fill the section (default); 'once' plays it
   *  from the top of the section and then stops. */
  fill?: 'loop' | 'once';
  /** Semitones, -24..24. The one editing affordance the timeline gets. §5.1. */
  transpose?: number;
  /** 0..2. */
  velocityScale?: number;
  muted?: boolean;
}

export interface MasterRecord {
  /** 0..1, default 0.9 to match EngineHost's master gain. */
  gain?: number;
}
```

`NoteRecord` is deliberately `SeqNote` plus an optional `pass`, so
`src/dsp/sequencer.ts` needs no adapter and no change.

### 3.4 Runtime shape and load result

```ts
export interface ArrangementLoadResult {
  arrangement: Arrangement;
  /** Every recovery, in the order it happened. Surfaced, never swallowed —
   *  same contract as LoadResult.warnings in patch-format.ts. */
  warnings: string[];
  /** Entities that could not be attached, kept verbatim so a re-save loses
   *  nothing that was in the file we opened. */
  quarantined: readonly unknown[];
}

export function serialiseArrangement(a: Arrangement): SerialisedArrangement;
export function loadArrangement(raw: unknown): ArrangementLoadResult | null;

/** Runtime indices for the UI. Built once per load, never serialised. */
export function indexArrangement(a: Arrangement): {
  trackById: ReadonlyMap<string, Track>;
  sectionById: ReadonlyMap<string, Section>;
  patternById: ReadonlyMap<string, PatternRecord>;
  cellAt: (trackId: string, sectionId: string) => Clip | null;
  /** Absolute tick at which each section begins, honouring `repeats`. */
  sectionStartTick: ReadonlyMap<string, number>;
  totalTicks: number;
};
```

### 3.5 Why ids for reference and array order for sequence

Cross-references are **always by id, never by index** — `clip.trackId`, `clip.sectionId`,
`clip.patternId`. This is the same lesson `patch-format.ts` learned the hard way: inserting a
track must not silently re-point every clip, exactly as inserting a parameter must not
reinterpret every patch.

Section *order*, by contrast, is array order. There is no `order: number` field, because the
order of the sections array **is the song** — it is the meaning, not a rendering hint. An
explicit order field would introduce a second source of truth, and the first time the two
disagreed the song would play in an order nobody chose.

### 3.6 Recovery rules — what happens when the file is wrong

Stated exhaustively, because "tolerant" without a table is a wish.

| Situation | What happens |
|---|---|
| `version` > current | Warn; load what is understood; everything unrecognised preserved in `meta`. |
| Unknown top-level key | **Preserved** into `meta`, warned. Not dropped. |
| Unknown `engineId` on a track | **Track kept**, flagged `unplayable`, its patch preserved byte-for-byte, warned. Its clips remain. Dropping the track would delete the user's arrangement to punish them for a missing engine. |
| Track has neither `patch` nor `presetId` | Engine defaults, warned. |
| `presetId` not in `PRESETS` | Engine defaults, warned. |
| Track patch body | Delegated to `loadPatch()` verbatim; its warnings are re-emitted prefixed with the track name. |
| Clip names a missing track/section/pattern | Clip dropped, warned, **and pushed to `quarantined`** so a re-save does not lose it. |
| Pattern `ppq` ≠ 96 | Tick positions rescaled by `96 / ppq`, rounded, warned. |
| Note outside `[0, patternTicks)` | **Dropped**, warned — consistent with `setLengthBars` in use-sequencer.ts, whose comment states that silently re-homing a note "would be worse than losing them". |
| Any number out of range | Clamped, warned — same as `fromKeyed`. |
| Duplicate id | First wins; later ones renamed `${id}__2`; warned. |
| More than 8 tracks | Extra tracks loaded but flagged `unplayable`, warned. Never silently deleted. |
| Two sampler tracks | Second flagged `unplayable` with the reason (§2.4), warned. |
| `raw` is not an object | Return `null`, exactly like `loadPatch`. |

**One deliberate strengthening over `patch-format.ts`.** That module *ignores* unknown
parameter ids (`"ignored N unknown parameter(s) — saved by a newer build"`). Losing one unknown
knob is survivable. Losing an unknown **track** is not — you would open a friend's song in an
older build, save it, and hand back a shorter piece of music. So the arrangement format is
**preserve-and-warn** at entity level, not ignore-and-warn. Round-tripping an unmodified file
through `loadArrangement` → `serialiseArrangement` must be lossless, and there should be a
test that asserts exactly that with a payload containing fields the build does not know.

### 3.7 Serving three consumers

**Web UI.** Needs indices and hit-testing, which is what `indexArrangement()` is for. The
serialised shape is never mutated in place; the UI holds the runtime `Arrangement` and
serialises on save.

**MCP server** (a language model composing directly). Three affordances, all in the format:

1. **Human-readable slug ids, not UUIDs** — `track_bass`, `sec_chorus`, `pat_bass_a`. A model
   can reference `track_bass` from three messages ago; it cannot reference
   `a7f3c2e1-...`. Generated ids must be slugs of the name plus a numeric suffix on collision.
2. **`presetId` as an alternative to `patch`** — `{"engineId":"analog","presetId":"glass-bell"}`
   is a sound a model can specify correctly. Thirty floats is not. And because `fromKeyed`
   already fills gaps from defaults, a *partial* `patch.values` is legal too, so a model can
   say "this preset but the cutoff at 800" without emitting the rest.
3. **Cells, not tick offsets** — this is §1.3's payoff. `{"track":"bass","section":"drop"}`
   is verifiable from the schema. `{"startTick":6144}` is a number a model will get wrong
   with total confidence.

**One hard rule for the MCP layer:** the file has exactly one representation of time — ticks
at PPQ 96. If the MCP tools want to accept `"2.1.0"` bar-beat-tick strings, that conversion
lives in the tool layer and never in the file. Two ways to say one thing is how a compatible
format becomes an incompatible one.

**Plugin.** `arrangement-format.ts` must stay free of browser types (no `Float32Array`, no
`File`, no `Blob` in the serialised shape), free of sample bytes (`sampleRef` by name only),
expressed in real parameter units rather than normalised ones (which `patch-format.ts` already
guarantees), and deterministically ordered so two saves of the same song produce identical
JSON and the file diffs cleanly.

---

## 4. The UI contract

Written so two engineers building different halves cannot disagree about the seam.

### 4.1 Ownership, stated once

- **`use-arrangement.ts` owns all arrangement state.** Nothing else mutates it.
- **`TrackPool` owns all audio nodes.** Nothing else creates an `AudioWorkletNode`.
- **Components own nothing.** State down as props, events up as callbacks. No component
  imports `use-arrangement`.
- **Every callback takes ids, never indices.**
- **Every time-carrying prop carries ticks at PPQ 96.** Pixels are computed inside `SongGrid`
  and nowhere else. Milliseconds never cross a component boundary.
- **Components receive `colour` as a prop** and never look up engine colour themselves —
  matching `EngineRail`, `PresetPanel`, `HuntGrid` today.
- **Selection is exactly one track and at most one cell**, both owned by `use-arrangement`.

### 4.2 New non-React modules

```ts
// src/audio/arrangement-format.ts   — §3. Pure. No React, no DOM.

// src/audio/track-pool.ts           — sibling of engine-host.ts, same style.
export class TrackPool {
  constructor(maxTracks: number);
  start(): Promise<void>;
  attach(trackId: string, engineId: string): void;   // creates the node
  release(trackId: string): void;
  setEngine(trackId: string, engineId: string): void;
  setAllParams(trackId: string, values: Float32Array): void;
  setParam(trackId: string, address: number, value: number): void;
  setGain(trackId: string, gain: number): void;
  noteOn(trackId: string, midi: number, velocity: number): void;
  noteOff(trackId: string, midi: number): void;
  allNotesOff(): void;                                // Panic, every track
  get analyser(): AnalyserNode | null;                // the MIX, for Scope/Spectrum
  get context(): AudioContext | null;
}

// src/audio/bounce-arrangement.ts   — §5.4. Offline render of the whole song.
```

### 4.3 New hooks

```ts
// src/ui/use-arrangement.ts
export interface ArrangementController {
  arrangement: Arrangement;
  scope: 'sound' | 'song';        setScope: (s: 'sound' | 'song') => void;
  selectedTrackId: string;        selectTrack: (id: string) => void;
  selectedCell: { trackId: string; sectionId: string } | null;
  selectCell: (trackId: string, sectionId: string) => void;

  addTrack: (engineId: string) => string | null;   // null when at the cap
  removeTrack: (id: string) => void;
  renameTrack: (id: string, name: string) => void;
  setTrackGain: (id: string, gain: number) => void;
  toggleMute: (id: string) => void;
  toggleSolo: (id: string) => void;

  addSection: (afterId: string | null) => string;
  editSection: (id: string, patch: Partial<SectionRecord>) => void;
  removeSection: (id: string) => void;

  placeClip: (trackId: string, sectionId: string, patternId: string) => void;
  moveClip: (clipId: string, toTrackId: string, toSectionId: string) => void;
  clearCell: (trackId: string, sectionId: string) => void;
  setClipTranspose: (clipId: string, semitones: number) => void;

  setTempo: (bpm: number) => void;
  setKey: (root: number, scale: ScaleName) => void;

  save: () => SerialisedArrangement;
  load: (raw: unknown) => string[];   // returns warnings, surfaced via setStatus
  warnings: readonly string[];
}

// src/ui/use-song-transport.ts   — §2.5. One clock, scheduleWindow per clip.
export interface SongTransport {
  isPlaying: boolean;
  play: () => void; stop: () => void;
  /** null when stopped. */
  position: { sectionId: string; bar: number; beat: number } | null;
  /** Loop the section under the playhead instead of advancing. */
  loopSection: boolean; setLoopSection: (v: boolean) => void;
  soundingClipIds: ReadonlySet<string>;
}
```

### 4.4 New components

```ts
// src/ui/components/scope-switch.tsx
interface ScopeSwitchProps {
  scope: 'sound' | 'song';
  onScope: (s: 'sound' | 'song') => void;
  colour: string;
}
// Two 44px buttons. Lives as the first child of the tab strip div in app/page.tsx,
// with a doubled 3px right border. Renders nothing else.

// src/ui/components/track-rail.tsx
export interface TrackSummary {
  id: string; name: string; engineId: string; colour: string;
  muted: boolean; soloed: boolean; unplayable?: boolean;
}
interface TrackRailProps {
  tracks: readonly TrackSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
  onToggleMute: (id: string) => void;
  onToggleSolo: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onAdd: () => void;
  /** null hides the + button and shows the cap. */
  remainingSlots: number;
  colour: string;
}
// Reuses <EngineMark engineId=... /> for the per-row glyph, exactly as EngineRail does.
// flex-row on phone, flex-col from md. Track names in --ink, never --muted.

// src/ui/components/song-grid.tsx
export interface CellSummary {
  clipId: string | null;
  /** 0..1 note density, for the block fill. Not a piano roll. */
  density: number;
  noteCount: number;
  muted: boolean;
  playing: boolean;
}
interface SongGridProps {
  sections: readonly SectionSummary[];
  tracks: readonly TrackSummary[];
  /** cells[trackId][sectionId]. Dense, precomputed by use-arrangement. */
  cells: Readonly<Record<string, Readonly<Record<string, CellSummary>>>>;
  playhead: { sectionId: string; bar: number; beat: number } | null;
  selected: { trackId: string; sectionId: string } | null;
  height: 'ribbon' | 'half' | 'full';
  onHeight: (h: 'ribbon' | 'half' | 'full') => void;
  onSelectCell: (trackId: string, sectionId: string) => void;
  onMoveClip: (clipId: string, toTrackId: string, toSectionId: string) => void;
  onClearCell: (trackId: string, sectionId: string) => void;
  onAddSection: (afterId: string | null) => void;
  onEditSection: (id: string, patch: Partial<SectionRecord>) => void;
  colour: string;
}
// RESPONSIBILITY: layout, hit-testing, and the three height states. It never
// touches audio, never owns state, and never imports a hook other than React's.

// src/ui/components/section-header.tsx
interface SectionHeaderProps {
  section: SectionSummary;
  width: number;              // px, computed by SongGrid
  active: boolean;
  onEdit: (patch: Partial<SectionRecord>) => void;
  onRemove: () => void;
  colour: string;
}
// Name, bar count, and 44px +/- steppers for bars.

// src/ui/components/clip-cell.tsx
interface ClipCellProps {
  cell: CellSummary;
  width: number;
  selected: boolean;
  onSelect: () => void;
  onClear: () => void;
  colour: string;
}

// src/ui/components/loop-strip.tsx
interface LoopStripProps {
  /** The EXISTING Sequencer handle from src/ui/use-sequencer.ts, passed straight
   *  through. Do not re-implement its controls and do not wrap it in an adapter. */
  seq: Sequencer;
  /** "Bass · drop" — what this loop will be written into. */
  targetLabel: string;
  colour: string;
}
// Lives in <footer>, ABOVE ScalePicker. Desktop: REC / play / bars / quantise /
// undo / clear. Phone: REC · BARS · UNDO · CLR, bars and quantise behind a tap.

// src/ui/components/song-transport.tsx
interface SongTransportProps {
  transport: SongTransport;
  bpm: number; onBpm: (v: number) => void;
  colour: string;
}
// NAME COLLISION, ON PURPOSE, SO NOBODY MERGES THEM: the existing
// src/ui/components/transport.tsx is power / record / bounce and stays in
// AppHeader untouched. This one is song play / stop / position / bpm and lives
// in the SongGrid header row.
```

### 4.5 Where the existing files change

| File | Change |
|---|---|
| `app/page.tsx` | Add `ScopeSwitch` to the tab strip; render `SongGrid` above the tab content in SONG scope; swap `EngineRail` for `TrackRail` + `EngineRail` in the aside; add `LoopStrip` to the footer. |
| `src/ui/use-instrument.ts` | Accept an injected host and patch (§2.7). No other change in this pass. |
| `src/ui/use-sequencer.ts` | **None.** |
| `src/dsp/sequencer.ts` | **None.** |
| `src/audio/patch-format.ts` | **None.** |
| `src/dsp/fx.ts`, `fx-magic.ts`, `src/audio/worklet/` | **None**, except §5.4, which waits for the stereo work. |

### 4.6 Tests

The existing 568 tests are overwhelmingly DSP and audio; there are exactly two UI tests
(`tests/ui/hand-play.test.ts`, `tests/ui/hand-control-version.test.ts`). Keep that balance.

Unit-test, thoroughly: `arrangement-format.ts` (every row of the §3.6 table, plus the lossless
round-trip of an unknown-field payload), `indexArrangement`'s `sectionStartTick` against
`repeats`, and the pure song-position function that maps an absolute tick to
`(sectionId, clipLocalTick)`. Do not write render tests for `SongGrid`.

---

## 5. What not to build

### 5.1 Refused outright

1. **Audio warping, time-stretch, audio clips on the timeline.** There are no audio clips.
   Tracks are patterns plus patches. The only audio in the whole feature is the final render.
2. **A piano roll.** No note editing in the timeline, at all. Notes get in exactly one way:
   you play them. Editing is `UNDO PASS` (already built — `removePass`), `CLEAR CELL`, or play
   it again. This is the largest refusal in the document and the one that keeps the app
   simple. **One concession:** `ClipRecord.transpose`, because it is a single integer and it
   saves re-recording a whole part a fifth up.
3. **Comping and take lanes.** The looper's per-pass overdub with per-pass undo *is* the take
   model, and it is already written and tested.
4. **Automation curves, parameter envelopes, macro recording.** The macro row and the XY pad
   are performance controls; recording them means a second timeline with a second edit model
   and a second set of hit-testing. If a parameter should move, `src/dsp/lfo.ts` already moves
   it, inside the sound, where it belongs.
5. **Sends, returns, buses, master FX.** Per-track FX comes free because each node owns its
   own chains. A bus is a new node graph and a new mental model, and `MasterRecord` is
   therefore gain only.
6. **A mixer view.** Gain, mute and solo live on the track row. There is no second page.
7. **Plugin hosting, third-party effects, sample import into clips.** Six engines, one FX
   chain, one Character chain. Nothing loads.
8. **Tempo automation, time-signature changes, per-track swing.** One tempo, one signature.
9. **Zoom, scroll-lock, snap settings, grid divisions, ruler units.** Sections are the grid.
   There is nothing to snap to and nothing to zoom.
10. **MIDI file import.** Arbitrary tempo maps, 16 channels, multiple signatures — a can of
    complexity for a workflow nobody described. (MIDI *export* is a cheap, defensible
    stretch goal; it is not v1.)
11. **A clip launcher / scene mode.** §1.1(e).
12. **Cloud, collaboration, arrangement-wide undo history, version branching.** Single-level
    undo per action, same as everywhere else in the app.

### 5.2 The track cap is a feature

**Eight tracks. Hard.** The justification is measured, not aesthetic: each `SigilProcessor`
preallocates `sampleRate * 60` floats for capture — 11.5 MB at 48 kHz — so eight nodes is
~92 MB resident before a voice sounds, and eight nodes × 16 voices is already past what a
phone renders inside a 128-frame quantum. A cap that is explained is a design; a cap that is
discovered is a bug. The `+ TRACK` button shows `3 LEFT` and then disables with the reason.

(If the cap ever needs to rise, the cheap win is making the capture buffer lazily allocated on
`recordStart` rather than in the constructor. That is a worklet change and it is not this
task's.)

### 5.3 What "finish a track" means

**Concretely, and this is the acceptance criterion for the whole feature:**

> A named arrangement of 2–8 tracks and 3–8 sections, one to five minutes long, that renders
> to a single stereo WAV with one button, alongside a `.sigil.json` you can reopen and hear
> the same thing. **You can hand someone the WAV.**

**It explicitly does not mean:** mastered. Mixed against a reference. Containing recorded
audio or vocals. Exported as a DAW session. Stem-separated (stems are nearly free from the
same render loop and are a reasonable follow-up, but they are not the definition). Published,
uploaded, or shared from inside SIGIL. Loudness-normalised beyond the 1 dB headroom
`bouncePatch` already applies.

### 5.4 The one thing that is genuinely blocked

Rendering the arrangement offline **does** need a worklet change, and it is worth stating
precisely so it can be sequenced rather than discovered.

`src/audio/bounce.ts` carries a measured finding: an `OfflineAudioContext` finishes rendering
before `port.postMessage` is ever delivered, so every piece of state travels through
`processorOptions` at node construction. `BounceProcessorOptions` today carries *one* chord —
`midiNotes` plus a single `releaseFrame`. An arrangement needs note events spread over three
minutes.

The fix is small and contained: extend `BounceProcessorOptions` with

```ts
readonly events?: readonly {
  frame: number; type: 'on' | 'off'; note: number; velocity: number;
}[];
```

and drain it by frame inside `process()`. Perhaps forty lines. But it is in
`src/audio/worklet/sigil-processor.ts`, which the stereo agent currently owns, so it **must
wait for that work to land**.

Two consequences worth planning around:

- **The live half of the arrangement can ship first**, and should. Multi-track playback,
  looping, clip placement and persistence all work with zero worklet changes.
- **Realtime capture is not a workaround.** The worklet's capture buffer is a hard 60-second
  ceiling and folds to mono on the way out. A three-minute stereo piece cannot come out that
  way.

---

## 6. Mobile

**Yes, the timeline exists on the phone.** It is the reason §1.3 refuses the canvas: a canvas
does not survive the trip to 375px, and a table does.

**The rail already handles it.** `app/page.tsx` is `flex-col md:flex-row` with the aside
carrying `border-b-4 md:border-b-0 md:border-r-4` — the rail is already stacked above the
centre on a phone. `TrackRail` becomes a horizontally scrolling strip of 44px track chips,
same component, CSS only (`flex-row md:flex-col`).

**The grid transposes.** On desktop, sections run across and tracks run down. On a phone,
**sections run down and tracks run across**, because a phone is tall and a song has more
sections than tracks. Each row is 56px: a sticky left gutter with the section name and bar
count, then one cell per track. You scroll through the song vertically, which is what
scrolling on a phone is for.

**The width budget, at 375px:** a 64px sticky section gutter leaves 311px, so **four tracks
are visible at once** at ~76px each. Tracks 5–8 scroll horizontally inside the grid while the
gutter stays pinned (`position: sticky; left: 0`).

**Drag is removed, not shrunk.** Dragging a clip between 44px cells on a touchscreen is the
single worst interaction in every mobile DAW. Replace it: select the cell, tap `MOVE` in the
footer, tap the destination. Two taps, works every time, works one-handed.

**Everything you need lives in the bottom third.** The `LoopStrip` is in the footer by design
(§1.2), and when a cell is selected its actions — `MOVE`, `CLEAR`, `±12` — appear in that same
footer strip rather than as a popover pinned to a 76px cell you are covering with your thumb.

**What degrades, exactly:**

| Desktop | Phone |
|---|---|
| Sections across, tracks down | Sections down, tracks across |
| Grid at `HALF` by default | Grid at `RIBBON` by default — one row, playhead and section name |
| 8 tracks visible | 4 visible, 5–8 scroll horizontally |
| Drag a clip between cells | Select → `MOVE` → tap destination |
| Inline section rename | System `prompt`, as `PresetPanel` already does (preset-panel.tsx:57) |
| Full `LoopStrip` (6 controls) | 4 controls; bars and quantise behind one tap |
| Keyboard shortcuts (`src/ui/shortcuts.ts`) | Absent, as today |
| `keys` layout default | `pads` default — already the behaviour, via `matchMedia('(max-width: 767px)')` in use-instrument.ts |

**What does not degrade:** every touch target stays ≥44px, the 3px borders and hard offset
shadows stay (they are the identity), and every piece of text that has to be *read* — track
names, section names, bar counts, the position readout — uses `--ink`, never `--muted`, which
is 4.14:1 on `--panel` and fails AA at these sizes.

---

## 7. Sequencing, if it helps whoever builds this

1. `arrangement-format.ts` + its tests. Pure, no UI, unblocks the MCP server immediately.
2. `track-pool.ts` + `use-arrangement.ts`. One track only. Assert the §2.6 invariant: with one
   track, the app is byte-identical to today.
3. `ScopeSwitch`, `TrackRail`, multi-track live play. Now it is a multi-timbral instrument.
4. `LoopStrip` — wire up the sequencer that has been sitting there. **This is the step where
   it becomes fun**, and it is worth reaching quickly.
5. `SongGrid`, `SectionHeader`, `ClipCell`, `use-song-transport.ts`. Now it is a song.
6. `bounce-arrangement.ts` — after the stereo work lands (§5.4). Now it is finished.

Steps 1–5 need no changes to any file the stereo agent is holding.

---

## 8. One optional flourish

`src/dsp/signature.ts` already derives a true name and a drawn sigil from a patch
(`nameOf`, `sigilOf`). An arrangement of six patches could compose one mark from its tracks'
marks, and a finished piece could arrive already named. It costs a small function and it is
consistent with `docs/design/magical-touches.md`. It blocks nothing, and it should not be
built before step 5.
