# Running SIGIL on your own machine

## The short version

**Double-click `SIGIL.command`** in the project folder.

That is the whole thing. It installs anything missing, rebuilds only if you have
changed the code, starts a local server, and opens your browser. Close the
Terminal window to stop it.

From a terminal instead:

```bash
pnpm desktop
```

## What happens the first time

The first launch takes a few minutes because it has to build the app —
subsequent launches skip straight to serving, usually in a couple of seconds.
The launcher tells you which stage it is in, and if a step fails it stops and
shows you the actual error rather than opening a broken page.

It picks its own free port starting at 4173, so it will not collide with another
dev server you have running.

**No passcode locally.** The gate only arms itself when `SIGIL_PASSCODE` is set,
which is a deployment concern. Locally you go straight in.

## Which browser

| | Chrome / Edge | Safari | Firefox |
|---|---|---|---|
| Audio, all six engines | yes | yes | yes |
| Recording to WAV | yes | yes | yes |
| Kit export (.zip) | yes | yes | yes |
| MIDI controllers | yes | **no** | yes |
| Drag a bounce into Ableton/FL | yes | **no** | **no** |
| Route audio to a KO II over USB | yes | **no** | **no** |
| Camera hand tracking | yes | yes | yes |

Chrome or Edge is the recommended default. Safari is genuinely fine for playing
and bouncing — it just cannot do MIDI or drag-out, because those APIs do not
exist there. The app detects each case and tells you rather than failing
silently.

**One iPhone gotcha worth knowing:** iOS Web Audio obeys the physical silent
switch. If your ringer is off, SIGIL will be completely silent and look broken.

## Updating

```bash
git pull
```

Then launch as usual — the launcher notices the source is newer than the build
and rebuilds itself.

## If something goes wrong

**"Node.js is not installed"** — install the LTS build from
[nodejs.org](https://nodejs.org) and double-click again.

**macOS refuses to open the file** — right-click `SIGIL.command` → Open, once.
Gatekeeper blocks double-clicking downloaded scripts until you confirm one time.

**The browser opens but the page will not load** — the launcher prints the last
lines of the server log. That output is the real reason; the usual cause is a
port taken by something the launcher could not detect.

**Audio is silent** — click POWER first. Browsers refuse to start audio without a
deliberate user action, so nothing sounds until you do.

## Running it for someone else on your network

`next start` binds locally by default. To let a phone on the same wifi reach it:

```bash
pnpm build && pnpm exec next start --hostname 0.0.0.0 --port 4173
```

Then open `http://<your-mac's-ip>:4173` on the phone. Note that **camera hand
tracking will not work over plain HTTP** to a non-localhost address — browsers
require HTTPS for camera access. Use the deployed Railway URL for that.

## Known items

- Next 16 deprecates the `middleware.ts` convention in favour of `proxy`. It
  still works and prints a warning on build; migrating is a small, separate
  change.
- The production build uses Turbopack and takes a few minutes on first run.
  Nothing is wrong if it sits on "Creating an optimized production build".
