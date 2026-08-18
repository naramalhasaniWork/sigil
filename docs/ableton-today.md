# SIGIL in Ableton — what works today

## The honest position first

**A real VST3/AU plugin cannot be built today.** `docs/business/plugin-packaging.md`
puts the port at 29 engineer-weeks for desktop alone and 38 with contingency for
desktop + iOS. That is not pessimism about this codebase — the DSP is already
portable C++-shaped TypeScript — it is the plugin plumbing, the state
serialisation, the wrapper UI, code signing, notarisation and the DAW test
matrix. Nobody ships a first plugin port in a day.

**But SIGIL can be played as an instrument inside Ableton today, with no new
code.** Everything below works right now, on the build that is already
deployed. The trade is latency and one extra window, not capability.

---

## 1. Ableton plays SIGIL — MIDI in

SIGIL already listens to **every** connected Web MIDI input, on every channel,
and handles notes, CC, pitch bend and MIDI clock. It does not care which
controller or which application is sending. So Ableton can drive it.

**Setup, once:**

1. Open **Audio MIDI Setup** (in `/Applications/Utilities`).
2. Menu **Window → Show MIDI Studio**.
3. Double-click **IAC Driver**. Tick **Device is online**. Keep the default
   port, "Bus 1".
4. In Ableton: **Settings → Link/Tempo/MIDI**. Find `IAC Driver (Bus 1)` in the
   Output list and switch **Track** on.
5. Make a MIDI track. Set its **MIDI To** to `IAC Driver (Bus 1)`, channel 1.
6. Open SIGIL in Chrome. Power it on. Go to **setup → MIDI** and confirm
   `IAC Driver Bus 1` is listed under MIDI inputs.

Play the MIDI track and SIGIL sounds. Clips, arpeggios, chord progressions,
automation via CC — all of it drives SIGIL.

> **Chrome or Edge only.** Safari has no Web MIDI at all, and never has. This is
> the single hardest constraint on the whole browser-instrument approach.

## 2. Ableton records SIGIL — audio back in

SIGIL's audio goes to your system output. To get it into a Live track you need a
virtual audio device.

1. Install **BlackHole 2ch** — free and open source, from Existential Audio.
2. Open **Audio MIDI Setup → Window → Show Audio Devices**.
3. Click **+ → Create Multi-Output Device**. Tick both your real output (so you
   can still hear it) and **BlackHole 2ch**. Put your real output first — it is
   the clock master.
4. Set the Mac's system output to that Multi-Output Device.
5. In Ableton: **Settings → Audio**, set **Audio Input Device** to
   `BlackHole 2ch`.
6. Make an **Audio track**. **Audio From** → `BlackHole 2ch`. Monitor **In**.

Arm and record. You are now resampling SIGIL into Live like any hardware synth.

**Latency.** BlackHole itself adds effectively none, but the browser's audio
graph adds roughly 10–25 ms depending on buffer size, and Live's own input
latency stacks on top. For recording parts that is fine — record, then nudge the
clip. For tight live playing against a busy project it will feel soft. Live's
**Reduce Latency When Monitoring** helps.

## 3. SIGIL inside the Ableton window — Max for Live

This is the "pops up in Ableton like the other stuff" experience, and it is real
but partial.

**Requires Ableton Suite, or Max for Live bought separately.**

Max's `jweb` object loads a URL inside a device. So a small M4L device can host
the deployed SIGIL UI in a panel on the Live track, giving you one window
instead of two.

1. In Live, drag **Max Instrument** onto a MIDI track. Click the edit (pencil)
   button to open the Max editor.
2. Delete the default contents between the `midiin` and `midiout` objects, but
   **leave those two objects in place** — removing them breaks the device.
3. Put an object (`n` key) and type: `jweb @url https://YOUR-SIGIL-HOST/`
4. Resize the jweb panel in Presentation mode to something like 900×600.
5. Save the device with a name — it now appears in your User Library.

**What this gives you:** the SIGIL interface docked in Live, opening with the
set, saved with the set.

**What it does not give you:** audio does not come back through the device.
`jweb` is a web view, not an audio path — the sound still goes out via step 2's
BlackHole route. Nor does the patch save into the Live set; SIGIL saves its own
session to browser storage. So it is a hosted panel, not a true plugin.

Be clear-eyed about that: it is a genuinely nicer workflow than alt-tabbing, and
it is not the same thing as an instrument Live owns.

---

## Distribution — how people would get it

### What you can distribute today

**A Max for Live device (.amxd)** pointing at the hosted URL. It is a few
kilobytes; all the actual work stays on your server.

| Channel | Cost | Notes |
|---|---|---|
| **maxforlive.com** | Free to list | The place M4L users actually look. Free and paid devices both. |
| **Gumroad / Lemon Squeezy** | ~5–10% + fees | You own the customer relationship. Lemon Squeezy acts as merchant of record, which handles EU VAT for you. |
| **Your own site** | Payment fees only | Highest margin, zero discovery. |
| **Isotonik Studios** | Revenue share, unpublished | An established M4L storefront with an existing audience. |

**The catch that decides the price:** a hosted device is only alive while your
server is. That makes it a subscription in substance whether or not you call it
one, and buyers of one-off M4L devices do not expect that. Either price it as a
subscription and say so plainly, or budget for keeping the host up
indefinitely — Railway is cheap, but "indefinitely" is a real commitment to
someone who paid once.

### What you cannot list yet

**Plugin Boutique, ADSR, Splice, and Ableton's own Packs all require a real
binary** — VST3, AU or AAX. None of them will list a web app or a device that is
a wrapper around a URL. Ableton Packs additionally require a partnership
arrangement, not a submission form.

So the marketplace answer is: **the M4L route today gets you users; the
marketplace route needs the port.** They are not alternatives, they are
sequential. Ship the M4L device, find out whether people want it, and let that
answer decide whether 38 engineer-weeks is worth spending.

### If and when you do port

From `plugin-packaging.md`: **iPlug2** if iOS AUv3 matters from day one,
**JUCE** otherwise — the tiebreaker is that JUCE's talent pool is an order of
magnitude larger if any of it gets contracted out. Ship **CLAP** alongside VST3
either way; it is free in both frameworks and one extra CI target. **Skip AAX**
at launch.

---

## What is missing to make this genuinely good

Ranked by how much they would improve the Ableton experience specifically:

1. **Tempo sync.** SIGIL reads MIDI clock already, but delay time and LFO rates
   are in absolute ms/Hz rather than note divisions. Sync'd delay and LFO would
   make it sit in a project properly.
2. **Latency compensation.** Nothing measures or reports the round trip, so
   there is no number to put in Live's track delay.
3. **Program change.** Ableton could switch SIGIL presets from the timeline.
   Cheap to add — the preset list already exists.
4. **A stable audio buffer setting.** The AudioContext takes whatever the
   browser gives it. Exposing latency hint would let you trade stability against
   responsiveness deliberately.

None of these are large. All of them matter more, day to day, than the port
does.
