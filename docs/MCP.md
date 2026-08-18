# Composing in SIGIL by tool call

SIGIL exposes a Model Context Protocol server at **`POST /api/mcp`**. A language model
connected to it can read the engine parameters, pick sounds by character, build chord
progressions that are in key by construction, and lay out a song section by section.

The point is the owner's sentence: *describe a piece and get an arrangement back.*

Three files, and the split matters if you extend it:

| File | What it is |
|---|---|
| `src/mcp/tools.ts` | Every tool body. Pure functions — arguments in, results out, storage injected. No HTTP, no React. This is what the tests exercise. |
| `src/mcp/server.ts` | The manifest a model reads, and JSON-RPC framing. Knows the protocol, knows no music. |
| `app/api/mcp/route.ts` | Twenty lines. Parse a body, call `handlePayload`, serialise the answer. |

Transport is plain HTTP POST with a JSON body — streamable HTTP without the SSE half,
which SIGIL does not need: no tool here is long-running and nothing is pushed
server-to-client. Protocol version `2025-06-18`.

---

## Pointing a model at it

**Claude Code:**

```bash
claude mcp add --transport http sigil https://sigil-production-26de.up.railway.app/api/mcp
```

**Any client that reads an `mcpServers` block:**

```json
{
  "mcpServers": {
    "sigil": {
      "type": "http",
      "url": "https://sigil-production-26de.up.railway.app/api/mcp"
    }
  }
}
```

**Locally**, `pnpm dev` then `http://localhost:3000/api/mcp`.

### The passcode gate

`proxy.ts` gates everything under `/api/` when `SIGIL_PASSCODE` is set, and `/api/mcp` is
deliberately **not** in its `OPEN_PATHS` — an unauthenticated MCP endpoint is a write
endpoint anyone can find. A client must therefore send the same cookie the browser gets:

```bash
KEY=$(printf '%s' "$SIGIL_PASSCODE" | shasum -a 256 | cut -d' ' -f1)
curl -s https://sigil-production-26de.up.railway.app/api/mcp \
  -H 'content-type: application/json' -H "cookie: sigil-key=$KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

Locally `SIGIL_PASSCODE` is unset and the gate stays open, so no header is needed. Clients
that cannot set a cookie header cannot reach the deployed server today; that is a real gap,
and the fix is a bearer token, not opening the path.

A `GET /api/mcp` returns the tool names and protocol version, which is a useful "is this
thing on" without speaking JSON-RPC.

---

## The mental model a model needs

Five rules. They are in the tool descriptions too, because a model that reads only the
manifest still has to get these right.

1. **Clips live in cells, not at offsets.** A clip is placed where a track crosses a
   section — `{trackId: "track_bass", sectionId: "sec_drop"}`. That is verifiable against
   the schema. `{"startTick": 6144}` is a number a model gets wrong with total confidence.
2. **Time is ticks at PPQ 96, and only that.** You may *write* notes as `bar` and `beat`
   (1-indexed, fractions allowed — `beat: 2.5` is the "and" of two) and the tool converts.
   Nothing bar-shaped is ever stored. Two ways to say one thing is how a compatible format
   rots.
3. **Ids are slugs.** `create_arrangement({name: "Cold Room"})` gives you `arr_cold_room`;
   a track called Bass is `track_bass`; a clip is `clip_bass_drop`. Collisions get `__2`.
   You can hold these in your head across a conversation. UUIDs you cannot.
4. **Name a sound, do not emit thirty floats.** `presetId` plus a partial `values` map is
   the intended way to specify a patch: everything you omit keeps the preset's value, or
   the parameter's default.
5. **Read the `explain` sentences.** Every parameter carries one. They are what turn
   "brighter" into `filter-cutoff` rather than `osc-drift`.

---

## The tools

| Tool | For |
|---|---|
| `list_engines` | The six engines, their macro names, how many presets each has. |
| `describe_engine` | Every parameter of one engine with units, range, default and `explain`. Also takes `"fx"` and `"character"` for the shared chains. |
| `list_presets` | The preset library by **character** tag — `glassy`, `huge`, `broken`. Call it bare to get the whole tag vocabulary. |
| `create_patch` | A sound: engine, optional preset, partial overrides in real units (Hz, ms, dB). |
| `modify_patch` | Change parameters on a patch you already have; everything unmentioned is kept. |
| `generate_progression` | Diatonic chords from `src/dsp/chords.ts`. Returns labels **and** a `notes` array you pass straight to `add_clip`. |
| `create_arrangement` | A song: one tempo, one key, sections in play order. |
| `add_section` | Append, or insert after a named section. |
| `add_track` | An instrument, with its sound. Eight maximum, one sampler. |
| `update_track` | Level, mute, solo, rename, or merge new parameter values onto its patch. |
| `add_clip` | Put notes in a cell. One clip per cell — placing into an occupied cell replaces it. |
| `get_arrangement` | The whole song back, plus total bars, duration in seconds, and an ASCII grid of what is filled. |
| `list_arrangements` | Recover an id you lost. |

---

## A worked example: composing "Cold Room"

Every response below is real output, abridged only where a patch dumps thirty parameters.

**1. Find a sound by feel.**

```json
{"name": "list_presets", "arguments": {"character": "huge"}}
```
```json
{"tags": ["aggressive","bowed","broken","dark","glassy","hollow","huge","metallic",
          "plucked","sweeping","warm","wooden"],
 "count": 14,
 "presets": [{"id": "cathedral-drift", "name": "Cathedral Drift", "engineId": "analog",
              "character": ["huge","sweeping","warm"]}, ...]}
```

**2. Start the song.** Sections are the timeline; their order in this array *is* the order
of the piece.

```json
{"name": "create_arrangement", "arguments": {
  "name": "Cold Room", "bpm": 84, "root": "D", "scale": "dorian",
  "sections": [{"name": "Intro", "bars": 4}, {"name": "Body", "bars": 8},
               {"name": "Outro", "bars": 4}]}}
```
```json
{"arrangementId": "arr_cold_room",
 "arrangement": {"version": 1, "tempo": {"bpm": 84, "beatsPerBar": 4, "ppq": 96},
                 "key": {"root": 2, "scale": "dorian"},
                 "sections": [{"id": "sec_intro", "name": "Intro", "bars": 4}, ...]}}
```

**3. Two instruments.** A preset for the character, one override for the specific.

```json
{"name": "add_track", "arguments": {
  "arrangementId": "arr_cold_room", "name": "Keys", "engineId": "analog",
  "presetId": "frost-lattice", "values": {"filter-cutoff": 900}}}
```
```json
{"trackId": "track_keys", "warnings": [], "remainingSlots": 7,
 "track": {"id": "track_keys", "engineId": "analog", "gain": 0.8,
           "patch": {"version": 2, "values": {"filter-cutoff": 900, ...}}}}
```

```json
{"name": "add_track", "arguments": {
  "arrangementId": "arr_cold_room", "name": "Bass", "engineId": "fm",
  "presetId": "serrated-bass", "gain": 0.7}}
```

**4. The harmony.** Roman numerals or numbers; the quality comes from the scale, so you
cannot write a chord that is out of key.

```json
{"name": "generate_progression", "arguments": {
  "root": "D", "scale": "dorian", "degrees": ["i","IV","i","VII"],
  "barsPerChord": 2, "spread": 0.5}}
```
```json
{"key": {"root": 2, "scale": "dorian", "rootNote": "D3"},
 "lengthBars": 8, "ppq": 96,
 "chords": [
   {"degree": 1, "label": "Dm", "quality": "min", "notes": [50,53,69],
    "noteNames": ["D3","F3","A4"], "startTick": 0,    "durationTicks": 730},
   {"degree": 4, "label": "G",  "quality": "maj", "notes": [55,59,74],
    "noteNames": ["G3","B3","D5"], "startTick": 768,  "durationTicks": 730},
   {"degree": 1, "label": "Dm", "quality": "min", "notes": [50,53,69],
    "noteNames": ["D3","F3","A4"], "startTick": 1536, "durationTicks": 730},
   {"degree": 7, "label": "C",  "quality": "maj", "notes": [60,64,79],
    "noteNames": ["C4","E4","G5"], "startTick": 2304, "durationTicks": 730}],
 "notes": [{"id": "n1_1", "midi": 50, "velocity": 0.8, "startTick": 0,
            "durationTicks": 730}, ...12 in total]}
```

`spread` is octaves per voice: `0` is close position, `0.5` lifts the top voice an octave,
`1` lifts each voice by its own index — which at `notesPerChord: 4` spans four octaves and
almost certainly is not what you meant.

**5. Put it in a cell.** Pipe `notes` straight through.

```json
{"name": "add_clip", "arguments": {
  "arrangementId": "arr_cold_room", "trackId": "track_keys",
  "sectionId": "sec_body", "notes": [...the 12 notes...], "lengthBars": 8}}
```
```json
{"clipId": "clip_keys_body", "patternId": "pat_keys_body", "warnings": [],
 "clip": {"trackId": "track_keys", "sectionId": "sec_body", "fill": "loop"}}
```

**6. A bass line written by hand,** in bars and beats — the roots of the same chords, an
octave down, each held nearly two bars.

```json
{"name": "add_clip", "arguments": {
  "arrangementId": "arr_cold_room", "trackId": "track_bass", "sectionId": "sec_body",
  "lengthBars": 8, "notes": [
    {"midi": 38, "bar": 1, "beat": 1, "durationBeats": 7.5},
    {"midi": 43, "bar": 3, "beat": 1, "durationBeats": 7.5},
    {"midi": 38, "bar": 5, "beat": 1, "durationBeats": 7.5},
    {"midi": 48, "bar": 7, "beat": 1, "durationBeats": 7.5}]}}
```

**7. Thin the intro** — the first chord only, in the intro cell — then read the song back.

```json
{"name": "get_arrangement", "arguments": {"arrangementId": "arr_cold_room",
                                          "includePatterns": false}}
```
```json
{"summary": {"totalBars": 16, "seconds": 45.71, "trackCount": 2, "sectionCount": 3,
             "clipCount": 3, "emptyCells": 3,
             "grid": ["SECTION Intro Body Outro",
                      "Keys    █     █    ·",
                      "Bass    ·     █    ·"]}}
```

The grid is the fastest way for a model to see what it forgot. Here: nothing plays in the
outro, and the bass never enters the intro.

### When you get it wrong

A tool refusal comes back as readable content, not a transport error, so the model can act
on it:

```json
{"error": "No track \"track_lead\". This arrangement has: track_keys, track_bass."}
```

Every message names what was wrong *and* what would have been right — the legal engine
ids, the character tags that exist, the range a number had to be in. That is deliberate:
a model cannot recover from `TypeError: undefined`.

---

## What you cannot do through MCP

Being precise about this is more useful than a feature list.

**You cannot hear anything.** There is no render, preview or bounce tool, and there will
not be one soon. `src/audio/bounce.ts` carries a measured finding — an `OfflineAudioContext`
finishes rendering before `port.postMessage` is ever delivered, so all state has to travel
in `processorOptions` at node construction, and today that carries exactly *one* chord with
a single release frame. An arrangement needs note events spread over three minutes. The fix
is about forty lines inside `src/audio/worklet/sigil-processor.ts`, which is being made
stereo by someone else and is off limits. Realtime capture is not a workaround either: the
worklet's capture buffer is a hard 60-second ceiling and folds to mono on the way out.

**The browser app cannot open what you compose — yet.** This server emits exactly the
shape specified in `docs/design/arrangement-ia.md` §3, but the pieces that consume it
(`src/audio/arrangement-format.ts`, `use-arrangement.ts`, `SongGrid`) are a parallel pass.
Until they land, an arrangement from MCP is a well-formed JSON document, not a session you
can press play on. The tool layer keeps a **mirror** of those types at the top of
`src/mcp/tools.ts`; when the real module merges, delete the mirror and import it.

**Nothing is saved.** Storage is `createMemoryStore()` — one `Map`, process-local. A deploy
or a restart loses every arrangement, and two server instances do not see each other's
work. `ArrangementStore` in `src/mcp/tools.ts` is the seam: four async methods, and a
database implementation drops in without a single tool changing.

**No per-user auth.** One shared passcode gates the whole app. Anyone through that door can
edit anyone's arrangement.

**Structural limits that are on purpose, not missing work:**

- **Eight tracks.** Each track is its own `AudioWorkletNode`, and each processor
  preallocates an 11.5 MB capture buffer at 48 kHz — eight is ~92 MB resident before a
  note sounds, and eight nodes × sixteen voices is already at the edge of what a phone
  renders inside a 128-frame quantum.
- **One sampler track.** `setActiveSample` is a module-level global inside the worklet
  bundle, and every node in one `AudioContext` shares that scope, so two sampler tracks
  physically cannot hold different samples. The second one is refused with that reason.
- **No sample bytes.** `sampleRef` carries a name; the audio must already be loaded in the
  browser. Songs stay small and diffable, and no file travels through a tool call.
- **One tempo, one key, one time signature per song.** No mid-song changes.
- **Sections, not a canvas.** You cannot write a fill that starts three beats before the
  chorus. You can write a one-bar section called "fill". That is a genuinely worse tool and
  a much better product, and it is the trade the IA document makes deliberately.
- **`pan` is stored but silent** until the stereo work lands.

**Not built (and worth asking for if you need them):** removing a track, section or clip —
you can only mute, or replace a cell; editing individual notes after placement — rewrite
the cell; automation, per-clip effects, swing/groove, humanisation; the Hunt mutation
engine and the macro controls; MCP *resources* and *prompts* (this server offers tools
only); progress notifications, cancellation, or any server-initiated message.

---

## Extending it

Add a tool in two places: the function in `src/mcp/tools.ts` (validate arguments yourself,
return `{ok: false, error}` with a sentence rather than throwing), and an entry in `TOOLS`
in `src/mcp/server.ts` with a description written for a reader who has no other context.
Tests go in `tests/mcp/tools.test.ts` and call the function directly — never through HTTP.

The one rule that must not bend: **the arrangement carries exactly one representation of
time.** Bar-and-beat input is an ergonomic convenience that is converted inside the tool
layer and never stored. If a future tool wants `"2.1.0"` strings, that conversion lives
here too, and the file keeps its ticks.
