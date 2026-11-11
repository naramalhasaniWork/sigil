# SIGIL

A sound-design instrument. Six synthesis engines that run in a browser tab, and
the same six as a VST3 plugin — the plugin's audio is checked against the web
version sample-for-sample on every build.

- **Web:** https://sigil-production-26de.up.railway.app/start
- **Plugin:** macOS, VST3, Apple Silicon. `$49` when it goes on sale.

---

## What is in here

| | |
|---|---|
| `src/dsp/` | The synthesis. Plain TypeScript, zero allocation in render loops, no browser APIs. |
| `src/audio/` | The bridge between the DSP and whatever is hosting it — an AudioWorklet in a browser, a plugin processor in a DAW. |
| `src/ui/` | The interface. React, used by both the web app and the plugin. |
| `app/` | Next 16 routes: the instrument at `/`, the landing page at `/start`, `/admin`, the API. |
| `native/` | The C++ port of `src/dsp`, and the JUCE plugin built around it. |
| `docs/` | Design rulings, the sound audit, and the business material. |

### Six engines

`analog` · `fm` · `physical` · `granular` · `wavetable` · `sampler`

Plus an effects chain and a character chain, both available on every engine.
Around 84 presets across the six banks.

---

## Running it

```bash
pnpm install
pnpm dev            # http://localhost:3000
```

There is only ever **one** dev server — `next dev` refuses a second instance, so
if a start fails, one is already up.

`SIGIL.command` in the repo root is a double-clickable launcher for the desktop
app; `docs/RUNNING-LOCALLY.md` covers it, including which browsers support what.

### The gate

Set `SIGIL_PASSCODE` and the whole app sits behind a shared passcode. Leave it
unset locally and the gate stays open.

Set `NEXT_PUBLIC_SIGIL_PUBLIC=1` and it becomes the public build instead: no
gate at all, the arranger hidden, a `by naram` byline. One environment variable
rather than a fork, because a fork would be behind on every fix within a week.

---

## The two implementations, and the gate that keeps them honest

`src/dsp/` is the reference. `native/src/` is a hand-written C++ port of it. They
have to make **the same sound**, and the only way to know that is to measure it:

```bash
pnpm run drift      # regenerate goldens from the TS, then measure the C++
```

That renders golden buffers from the **current** TypeScript and compares the C++
against them — 197 checks. Change a coefficient in `src/dsp/` and it goes red
until `native/src/` is changed to match. That is the gate doing its job.

Checked-in goldens that were trusted rather than regenerated would defeat the
whole point: they drift with the code that produced them and nobody notices.

**So: any change to `src/dsp/` must be mirrored in `native/src/`.**

---

## Tests

```bash
pnpm test                                   # ~954 tests
NODE_OPTIONS=--expose-gc npx vitest run     # what CI runs
```

The `--expose-gc` matters. Several tests assert that render loops allocate
nothing, and without a real `gc()` they silently pass while measuring nothing —
which is exactly what happened for a while before it was caught.

Two disciplines worth knowing before adding to the suite:

- **A test that cannot fail is worse than no test.** Three were found here that
  passed against deliberately broken code. When you add one, break the thing it
  covers and watch it go red.
- **Green tests are not a working app.** More than one agent has reported a
  passing suite while the instrument was visibly broken in a browser. Look at it.

---

## The plugin

```bash
node scripts/build-plugin-ui.mjs                    # MUST run first if the UI changed
cmake --build native/build-plugin --config Release
cd native/build-plugin && ctest                     # 6 tests
```

Then copy `native/build-plugin/SIGIL_artefacts/Release/VST3/SIGIL.vst3` to
`~/Library/Audio/Plug-Ins/VST3/`.

**Skipping the UI build step is a real trap** — it went unnoticed for a day once,
and every "rebuilt and reinstalled" in that window was quietly shipping a
fortnight-old page.

A Standalone `.app` is built alongside the VST3 and is the fastest way to try a
change without a DAW.

### Ableton

Quit Live completely before testing a new build — a running Live holds the plugin
it loaded at launch. Then **Settings → Plug-Ins → "Use VST3 Plug-In System
Folders" must be ON**; if it is off, Live never looks in the folder the plugin is
in and nothing else you do will help. `docs/ableton-today.md` has the rest.

### Diagnostics

The plugin can log its own lifecycle — state save and restore, editor open, and
every parameter the page writes:

```bash
mkdir -p ~/Library/Logs/SIGIL && touch ~/Library/Logs/SIGIL/on
# launch the host; the flag is read once per process
# ... reproduce ...
rm ~/Library/Logs/SIGIL/on
```

It writes to `~/Library/Logs/SIGIL/plugin.log`, is off unless that flag exists,
and never touches `processBlock`.

---

## Design rules

Midnight neo-brutalism, and these are not preferences:

- `--bg #0E0E0E` · `--panel #171717` · `--ink #F5F1E6`
- 3px borders, sharp corners, flat fills. **No gradients, no blur, no soft
  shadows.** Hard offset shadows only on things you can press.
- **`--muted` (#7D786C) on `--panel` is 4.14:1 and fails WCAG AA.** Anything
  meant to be read is `--ink`. `--muted` is for hairlines.
- **44px minimum touch targets.** The instrument is used on a phone.
- Max 300 lines per file. TypeScript strict, no `any`.

---

## Things that will bite you

**Parameters are appended, never inserted.** The plugin maps descriptor
parameters to VST3 parameters by index, so inserting one mid-list silently
re-targets automation in every saved project. Patches themselves are keyed by
id — that is what `src/audio/patch-format.ts` is for — but the host's automation
is not.

**The worklet is a separate realm.** It is bundled independently and holds its
own copy of every module. Module state set on the main thread never reaches it.

**Denormal and NaN guards in the DSP are load-bearing**, not defensive noise.
Carry them across when porting.

**`--muted` text and sub-44px targets keep coming back.** Both have been fixed
more than once.

---

## License

Source-available, all rights reserved. You may read the code and run it locally
for yourself. Redistribution, resale, or shipping it in another product needs
written permission.
