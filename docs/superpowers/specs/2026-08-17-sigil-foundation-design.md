# SIGIL — Slice 0: Foundation

**Date:** 2026-08-17
**Status:** Design — awaiting approval
**Slice:** 0 of 6 (see *Deferred scope* for the rest)

> Name: SIGIL — a geometric mark that carries power. Patches are sigils.

---

## 1. What this is

A browser-based sound-design platform: a deep synthesizer whose purpose is producing
*material* — one-shots, chords, melodic phrases — that ends up on a Teenage Engineering
EP-133 K.O. II. Runs on Mac, iPad and phone. Hosted on Railway. Multi-user, so it can be
shared with friends.

The long-term system spans four synthesis engines, three kinds of tuning, generative
exploration, and a learning layer. **This spec covers only Slice 0**, the vertical slice
that proves the whole architecture end to end.

### The organising principle

Most soft synths reward people who already know synthesis. This one has to be usable by
someone learning, without capping what an expert can do. That resolves into **three depths
of the same surface**, not three different apps:

| Depth | Knowledge needed | What you see |
|---|---|---|
| **Sculpt** | none | Four macros, always in the same place, whatever the engine |
| **Deep** | growing | Every parameter, grouped, each with a plain-language explanation of what it does and *why it matters* |
| **Bounce** | none | Pick a region, name it, get a WAV at the KO II's native format |

The explanation text is not documentation bolted on afterward — it is a **required field on
every parameter descriptor**. An engine cannot ship a parameter without explaining it. That
is how the learning layer stays honest as the system grows.

### Slice 0 goals

1. One synthesis engine (**Analog**) tuned until it genuinely sounds expensive.
2. A **module contract** so engines 2–4 plug in without touching app code.
3. A **descriptor-driven UI** so a new engine gets a usable interface for free.
4. Playable input: keyboard, on-screen keys, chords.
5. Tuning: alternate temperaments, exact numeric parameter entry, per-voice character.
6. Curated presets, organised by character.
7. Bounce to KO II-spec WAV.
8. Accounts, patch persistence, deployed on Railway.
9. **Hunt** — mutation-driven discovery, and the tape. Moved into the foundation at naram's
   direction: the magic is the point, and an instrument you explore by taste is the
   difference between this and a parameter editor.

### Hunt

No parameters on screen. Seed from a preset, a character word, or chance. The machine
returns **six living variations** as geometric cards; touch one to audition it. Keep the
ones you like, breed them, get six children. Stop when something makes you stop — that
patch opens in Sculpt.

Mutation is a constrained random walk in normalised parameter space, weighted per parameter
by a `mutability` field on the descriptor, so musically destructive parameters (tuning,
output level) move little and character parameters (filter model, drift, index) move a lot.
Breeding is per-parameter crossover plus jitter. This is deterministic and needs no model.

**The tape**: every sound the machine renders for you is captured to a rolling history you
can scrub back through. You never lose the one you liked three mutations ago. This is what
makes exploration safe enough to be reckless in.

### Slice 0 non-goals

Explicitly **not** in this slice, to keep it shippable: engines 2–4, progression and melody
*generation*, 16-pad kit assembly and zip export, camera gesture control, patch sharing UI,
LLM text→patch.

---

## 2. Audio architecture

### 2.1 Runtime decision: TypeScript AudioWorklet, not WASM

Measured on this machine (Node 22, V8, warm JIT) with a realistic voice — 2× polyBLEP
antialiased saw, 4-pole ladder filter with saturating feedback, per-sample modulated
cutoff, ADSR:

| Voices | CPU per 10 s of audio | Realtime factor | % of one core |
|---|---|---|---|
| 8 | 0.077 s | 129× | 0.77% |
| 16 | 0.149 s | 67× | 1.49% |
| 64 | 0.606 s | 16.5× | 6.06% |

Heap growth across a 5 s render: none.

**Decision:** plain TypeScript in AudioWorklets. Rationale beyond the headroom — a WASM
build step lengthens the edit→hear loop, and sound quality comes from running that loop
hundreds of times. A slower iteration loop produces a worse-sounding instrument.

**Escape hatch:** the module contract is implementation-agnostic. If granular or spectral
synthesis (Slice 2) needs it, that single module moves to WASM without touching anything
else. This is a per-module decision, not a platform-wide one.

**Caveat to verify on device:** these numbers are V8-in-Node, not JavaScriptCore in an
AudioWorklet on iOS Safari, and throughput is not the same as meeting a 2.67 ms per-block
deadline. Slice 0 carries a mandatory on-device measurement task on naram's iPhone and iPad
before the engine is declared done.

### 2.2 Zero-allocation discipline

Non-negotiable inside `process()`:

- All buffers preallocated at construction; no array/object literals, no closures, no
  string operations, no `Array.prototype` methods that allocate.
- No `try/catch` in hot loops (deoptimises).
- Denormal guard: flush values below 1e-20 to zero in every filter state.
- NaN guard at the voice output; a NaN voice is silenced and reported rather than allowed
  to poison the bus.

Enforced by an automated allocation test (§7), not by good intentions.

### 2.3 Parameter transport

Two paths, chosen deliberately:

- **UI-rate changes** (knob drags, preset loads, gestures): `postMessage` carrying a packed
  `Float32Array` of changed `(paramIndex, value)` pairs. UI changes cap at ~60 Hz over a
  handful of parameters; this is far below any bandwidth concern and avoids
  `SharedArrayBuffer`'s COOP/COEP header requirements entirely.
- **Audio-rate modulation** (LFOs, envelopes, per-sample movement): computed *inside* the
  worklet. Modulation never crosses the thread boundary.

Every parameter passes through a one-pole smoother in the worklet. Un-smoothed parameter
changes produce zipper noise, which is the single most common reason a digital synth sounds
cheap.

`SharedArrayBuffer` is deliberately deferred; if gesture streaming in Slice 5 needs it, it
is an additive change plus two response headers.

### 2.4 Signal topology

```
note events ──▶ VoiceManager ──▶ [Voice × N] ──▶ EngineBus ──▶ FX chain ──▶ output
                    │                                              │
                 tuning                                      bounce tap
                  table                                  (OfflineAudioContext)
```

- **VoiceManager**: allocation, stealing (oldest-quietest-first), glide, per-voice character
  offsets. Owns polyphony, engines do not.
- **Voice**: one engine instance plus its envelopes and per-voice modulation.
- **FX chain**: fixed for Slice 0 — drive, filter-adjacent tone shaping, reverb, delay.
  A modular chain is a later slice.

### 2.5 Module contract

An engine is a class implementing:

```ts
interface EngineModule {
  readonly descriptor: EngineDescriptor;   // static: identity, params, groups
  allocVoice(sampleRate: number): EngineVoice;
}

interface EngineVoice {
  noteOn(freq: number, velocity: number, voiceIndex: number): void;
  noteOff(): void;
  setParam(index: number, value: number): void;
  render(out: Float32Array, offset: number, count: number): void;  // additive; zero-alloc
  isFinished(): boolean;
}
```

`EngineDescriptor` carries the parameter table:

```ts
interface ParamDescriptor {
  id: string;
  name: string;
  group: string;            // drives Deep-view grouping
  unit: 'hz' | 'db' | 'ms' | 'ratio' | 'pct' | 'semitones' | 'none';
  min: number; max: number; default: number;
  curve: 'linear' | 'exp' | 'log' | 'stepped';
  steps?: number;
  macro?: 0 | 1 | 2 | 3;   // which macro this parameter answers to, and how much
  macroDepth?: number;
  explain: string;          // REQUIRED — plain language, why it matters
}
```

The UI reads descriptors and builds itself. Adding an engine = adding a module + a
descriptor. No app code changes. This is the concrete meaning of "add more and more."

### 2.6 The Analog engine

What separates a good VA from a bad one is specific and testable:

- **Oscillators**: polyBLEP-antialiased saw/pulse/triangle, plus sine. Per-oscillator
  drift (slow, correlated random walk) — the single cheapest thing that makes digital
  oscillators stop sounding sterile.
- **Filter models**, switchable, all with saturating feedback:
  - *Ladder* — transistor-ladder character, 24 dB/oct, self-oscillates musically at high
    resonance
  - *State-variable* — cleaner, 12 dB/oct, LP/BP/HP continuous morph
  - *Diode* — squelchier, asymmetric saturation
- **Envelopes**: analog-style exponential curves with adjustable curvature, not linear ramps.
- **Character models** are presets over this engine (oscillator drift amount, filter model,
  envelope curvature, drive character) — descriptive names, never brand names. Circuits and
  algorithms are fair to model; trademarks are not.

### 2.7 Tuning — all three kinds

1. **Temperaments.** A tuning table maps note number → frequency. 12-TET default; N-TET
   (19, 24, 31), just intonation, Scala `.scl` import, stretched octaves, per-note cent
   offsets. Lives in `VoiceManager`, so every engine gets it for free, forever.
2. **Exact parameter entry.** Every control accepts typed numeric input in its real unit,
   plus fine-drag modifier and per-parameter curve display. Dragging is for exploring;
   typing is for finishing.
3. **Per-voice character.** Each voice in a chord can carry its own detune, pan, envelope
   scaling and filter offset, so a chord is four related instruments rather than one sound
   played four times.

### 2.8 Input

- **Computer keyboard** — two-octave mapping, octave shift, sustain.
- **On-screen keys** — always available; the only option on phone.
- **Chord pad** — pick root and quality (maj/min/7/sus/add9/…), one press plays the voiced
  chord. Chord *generation* is Slice 3; chord *playing* is here, because chords are how you
  judge whether a patch is actually good.
- **WebMIDI** on desktop — cheap to add, and playing a real keyboard changes how well you
  can judge a sound. Absent on iOS; the on-screen keys cover that.

### 2.9 How Slice 0 delivers "easy"

Hunt (mutation-driven discovery) is Slice 1, so easiness in Slice 0 rests on two things,
deliberately: a **curated preset library organised by character** — "glassy," "broken,"
"huge," "wooden" rather than by engine — and **four macros that never move**, so the first
thing anyone touches produces a musical change rather than a parameter change. Every preset
is a starting point to be mangled, not a destination.

---

## 3. Interaction and design

Direction is locked: **midnight neo-brutalism** — Bauhaus shape-language, neo-brutalist
physics, night canvas.

### 3.1 Tokens

| Token | Value | Role |
|---|---|---|
| `--bg` | `#0E0E0E` | canvas |
| `--panel` | `#171717` | raised surface |
| `--ink` | `#F5F1E6` | text, borders, hard shadows |
| `--analog` | `#FF6B6B` | Analog engine identity |
| `--fm` | `#C4B5FD` | FM identity (reserved) |
| `--physical` | `#FFD93D` | Physical identity (reserved) |
| `--muted` | `#7D786C` | disabled/inactive only |

Type: Space Grotesk, weights 400/500/700. Borders 3–4 px desktop, 2–3 px mobile. Shadows
hard-offset in `--ink`, zero blur, **reserved for pressable controls** so they mean
"actionable" rather than decorating.

### 3.2 Rules that carry meaning

- **Colour is functional.** An engine's colour follows it everywhere — rail, modulation
  chips, macro values, pad grid. A patch is readable at a glance.
- **Shape is semantic.** Circle = continuous, square = discrete/stepped, triangle =
  envelope. Modulation is dragging a coloured shape onto a control.
- **No submenus for the interesting parts.** Everything that changes the sound lives on one
  surface. Deep view expands in place; it does not navigate away.
- **Two documented rule-breaks**, because the alternative is worse: inactive engine labels
  use `--muted` (pure black-or-colour would make the rail unreadable), and motion respects
  `prefers-reduced-motion`.

### 3.3 Accessibility

Non-optional, checked in review: WCAG AA contrast on every pairing (`--fm` violet on black
is a block/accent colour only, never body text); visible focus rings on all controls;
full keyboard operation of every parameter; 44 px minimum touch targets; every knob is a
real ARIA slider with readable value text.

---

## 4. Data model

```
User      ── id, email, name, createdAt
Patch     ── id, ownerId, name, engineId, params(jsonb), tuningId?,
             visibility('private'|'unlisted'), character[], createdAt, updatedAt
Tuning    ── id, ownerId?, name, kind, data(jsonb), builtIn
Render    ── id, ownerId, patchId, name, url, sampleRate, bitDepth, durationMs, createdAt
Preset    ── built-in patches, seeded, ownerId null, readable by all
```

`ownerId` and `visibility` exist from day one specifically so sharing (Slice 6) is a UI
addition rather than a migration.

**Stack:** Next.js 15 App Router, TypeScript strict (no `any`), Tailwind for tokens,
Prisma + Postgres, Auth.js with an OAuth provider. Server components by default.

---

## 5. Bounce pipeline

1. Render offline via `OfflineAudioContext`, ideally at the KO II's native **46 875 Hz**.
   Safari has historically restricted non-standard offline rates — so: attempt native, and
   on failure render at 48 kHz and resample with a windowed-sinc resampler. Which path ran
   is recorded on the `Render` row, never silently guessed.
2. Trim to nearest zero-crossings both ends (removes clicks).
3. Optional short fades; peak-normalise with configurable headroom.
4. Dither, then quantise to 16-bit.
5. Encode WAV, store, offer download.

Kit assembly and zip export are Slice 4. Slice 0 produces one clean sample at a time.

---

## 6. Deployment

Railway: web service (Next.js) + Postgres. `railway.toml` in-repo, migrations run on
deploy, secrets as Railway variables — never committed. Health check endpoint. The Railway
CLI is already installed locally.

---

## 7. Testing

Ordinary unit and integration tests, plus DSP-specific tests that exist because "sounds
good" needs to become "measurably correct":

- **Filter response**: measured magnitude response vs analytical reference, per model,
  within tolerance.
- **Aliasing**: render a rising sweep, FFT, assert image energy above Nyquist stays below
  threshold — this is what catches oscillators that sound harsh on high notes.
- **Stability sweep**: sweep every parameter across its full range at extremes; assert no
  NaN, no denormal stalls, no runaway output.
- **Allocation**: assert zero heap growth across a sustained render.
- **Performance budget**, concrete so it can actually fail: 8 voices of Analog under **5%
  of one core on desktop** and **under 15% on an iPhone**, measured in an AudioWorklet, not
  in Node. Regression fails the build.
- **Golden render**: fixed patch renders compared to a stored reference by RMS difference
  with tolerance (not hash equality — floating point differs across platforms). Catches
  unintended changes to the sound.
- **Listening protocol**: a written checklist per engine, because the last mile is not
  automatable — does the filter self-oscillate musically, does it stay musical at extremes,
  is there zipper noise on fast automation, does it survive an hour without fatigue.

### Quality gates per increment

naram requested that many agents scrutinise the build at every step. Concretely, each
increment faces adversarial review passes across **correctness, DSP quality, performance
budget, accessibility, and design fidelity**, with findings independently verified before
anything is called done. Findings that survive verification block the increment.

---

## 8. Risks

| Risk | Response |
|---|---|
| iOS AudioWorklet slower than V8 benchmark suggests | Mandatory on-device measurement before the engine is signed off; module contract allows a WASM swap |
| Safari rejects 46 875 Hz offline rendering | Resample fallback, path recorded per render |
| **`postMessage` never arrives during offline render** — measured 2026-08-17: an `OfflineAudioContext` completes faster than port messages are delivered, so a worklet configured by `postMessage` renders pure silence. The live path measured peak 0.110 under identical settings. | The bounce pipeline must pass patch state via `processorOptions` at node construction, never by `postMessage`. A bounce that returns silence is the failure signature. |
| Four engines all end up mediocre | One engine per slice, each individually tuned and gated |
| Descriptor-driven UI becomes generic and soulless | Descriptors carry layout hints and grouping; the Analog surface is hand-designed first, and the generic renderer must reproduce it |
| Scope growth (this already happened once) | Slice boundaries are contractual; new ideas queue into later slices |

---

## 8.5 Build order within Slice 0

Slice 0 is large for one plan, so it stages. Each stage is independently verifiable, and
each faces the review gate before the next begins:

1. **Audio spine** — AudioContext, worklet host, parameter transport, smoothing,
   VoiceManager, allocation + stability tests. No UI beyond a debug harness.
2. **Analog engine** — oscillators, three filter models, envelopes, drift. Filter-response,
   aliasing and performance tests. On-device iOS/iPad measurement. Listening protocol run.
3. **Design system + Sculpt surface** — tokens, primitives, hand-designed Analog surface.
   Accessibility pass.
4. **Descriptor-driven Deep view** — generic renderer that must reproduce the hand-designed
   surface; parameter explanations; exact numeric entry.
5. **Tuning + input** — tuning tables, temperaments, per-voice character, keyboard/chords/MIDI.
6. **Persistence + bounce + deploy** — Prisma schema, passcode + Google OAuth, patch
   save/load, presets seeded, bounce pipeline, Railway.
7. **Hunt + the tape** — mutation, breeding, six-card exploration surface, rolling render
   history. Built last within the slice because breeding is only worth doing once the
   engine underneath sounds excellent.

---

## 9. Deferred scope

| Slice | Contents |
|---|---|
| 1 | LLM text→patch seeding (Hunt itself moved into Slice 0) |
| 2 | FM, Physical, Granular engines + character models; per-module WASM if needed |
| 3 | Progression/melody generation, voicings, phrase sequencer, phrase bounce |
| 4 | 16-pad kit assembly, zip export, KO II conventions, live USB-audio sampling |
| 5 | Touch/iPad parity surface, XY gesture fields, camera hand-tracking modulation |
| 6 | Sharing: friends' accounts, patch links, public read-only play |

---

## 10. Open questions

1. ~~Name~~ — settled: SIGIL.
2. **`/goal`.** naram invoked this twice; no such skill exists in their setup. Intent
   unknown; if it should be a real command, it can be built.

Decided rather than left open: **auth is Google OAuth**, plus a **single passcode account**
for immediate testing so the app is usable before Google credentials exist. The passcode is
read from an environment variable — never committed, never generated by Claude. Google
OAuth requires a client ID and secret that only naram can create in Google Cloud Console;
until those exist, the passcode path is the way in. Auth.js makes both providers coexist.
