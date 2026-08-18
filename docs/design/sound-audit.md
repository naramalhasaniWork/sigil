# SIGIL sound audit — measured, 2026-08-18

Every claim below is backed by an offline render: 48 kHz, velocity 1, 4 s note with
release at 2 s, engines driven directly through the same voice API the worklet uses.
Metrics: peak dBFS (pk), RMS of first 300 ms (r300), RMS at 1–2 s (sus), attack to 80%
of envelope max, decay to 1% of envelope max (dec40), spectral centroid (Hann, 8k/16k
FFT), alias ratio at C7, THD+N through the FX chain. ~330 renders total. The library
before this audit was 76 presets (not 88 as sometimes stated): 16 analog + 12 each
FM/physical/granular/wavetable/percussion.

## 1. Defaults, engine by engine

| engine | pk @C4 | r300 | attack | verdict |
|---|---|---|---|---|
| analog | -15.2 | -21.2 | instant | Good voicing, too quiet (see gain table) |
| fm | -9.2 | -14.5 | instant | Best first impression in the instrument |
| physical | -5.0 (C3 -3.4) | -14.3 | instant | Good struck default; hot relative to analog |
| granular | -13.9 | -24.1 | 50 ms | Characterful cloud; fine |
| sampler | -6.7 | -12.2 | instant | Built-in strike tone is a genuinely nice touch |
| wavetable | -15.1 | -19.3 | instant | Good voicing, too quiet |

Aliasing at C7 (non-harmonic vs harmonic energy, sub's half-harmonics correctly
masked): analog -36 dB, wavetable -42 dB, FM -80 dB, physical -81 dB. No engine has
an audible aliasing problem; the polyBLEP and sub oscillator are clean. (First
measurement said -9.5 dB for analog — that was the sub's legitimate half-harmonics
being miscounted; always mask at f0/2 when the sub is in the default patch.)

**The one real defect in the defaults is loudness disparity, and it is engine gain,
not voicing.** Switching engines is a ±6 dB volume ride. Per-preset values cannot fix
it (analog/wavetable/granular have no level parameter). Recommended engine trims to
land every default near -10 dBFS peak:

| engine | change | effect |
|---|---|---|
| analog | VOICE_GAIN 0.35 → 0.55 (analog-voice.ts:31) | +3.9 dB |
| wavetable | VOICE_GAIN 0.35 → 0.55 (wavetable-voice.ts:18) | +3.9 dB |
| sampler | VOICE_GAIN 0.85 → 0.7 (sampler-voice.ts:21) | -1.7 dB |
| fm, granular, physical | leave | already in band |

**Second engine-level defect: "compensated" drive is an attenuator.** analog,
wavetable and sampler all use `gain = 1+6*drive` with makeup `1/sqrt(gain)`. At these
engines' operating levels the saturator is nearly linear, so the makeup is pure loss:
up to -7 dB at high drive. Measured consequence: every preset tagged "aggressive"
is QUIETER than its bank (switchblade pk -21.9, wt-iron-lung -20.5, wt-splintered
-20.0, wt-furnace -20.5) — the Grit macro turns sounds down. Fix in the voices:
compute makeup from the actual saturator response at the operating level (or simply
use 1/sqrt(1+2.5*drive)). I part-fixed switchblade in preset space; the wavetable
aggressives are unfixable from presets and are waiting on this.

**Third: long-release pads occupy voices for 12+ s.** The envelope release ends at
1e-5 (-100 dB); a 5–6 s release setting therefore runs 10–12 s before isFinished().
Stealing hides it, but a chord retriggered over a stolen slot hard-resets the voice.
Consider ending release at 1e-3 with a 5 ms fade, or scaling threshold with release.

## 2. FX chain transparency (measured, and worth acting on)

The "why does it sound slightly veiled" question has a measured answer. MagicChain at
defaults is bit-exact (max |out-in| = 0.0). FxChain at defaults is NOT:

| input 997 Hz sine | THD+N | level |
|---|---|---|
| -20 dBFS | -48 dB | -0.01 dB |
| -12 dBFS | -47 dB | -0.05 dB |
| -6 dBFS | -41 dB | -0.21 dB |
| -3 dBFS | -36 dB | -0.41 dB |
| 0 dBFS | **-30 dB (3.2%)** | **-0.80 dB** |

Two always-on stages cause it (fx.ts): the bitcrusher quantises every sample even at
16 bits/rate 0 (`Math.floor(held*half+0.5)/half` — the -48 dB floor), and the final
safety saturator `sat(x/1.5)*1.5` shapes every sample (the level-dependent THD).
Hot sources — physical percussion peaks at -1.6 dBFS per voice, chords stack above
that — sit in the -30 dB THD region permanently. Recommended: bypass the quantiser
when bits=16 and rate=0; give the final saturator a knee (pass-through below |x|=1).

Unit gain staging at engage (997 Hz, -12 dBFS): drive .5 **+3.9 dB**, drive 1.0
+5.3 dB, delay .35 +1.9 dB, reverb .35 +0.8 dB, chorus .5 -0.8 dB; magic: tape wear
.5 +2.5 dB, stutter -0.2 dB, freeze .5 -2.5 dB, shift .5 -3.0 dB, vowel .5 **-5.5 dB**,
shimmer .5 **-6.1 dB**. Turning the Shimmer or Speak macros up halves the level —
that reads as "the sound died", not "an effect came in". Those three wet paths need
+3..6 dB makeup.

## 3. The presets, triaged

Full loudness map in the manifest / verified render table. Summary of the triage:

**Genuinely excellent (keep untouched).** The FM bank is the strongest in the
instrument — 11 of 12 are distinct, in-band, and speak instantly (cloister-bell,
tine-letter, night-market, iron-hymn, serrated-bass, copper-wasp, frozen-choir,
glass-harmonium, signal-fire, brass-casket, thumb-piano; mallet-court is the weakest
but earns its slot as the only dry FM mallet). Physical melodic: gamelan-court,
glass-orchard, horsehair-winter, bowed-antenna, winter-chapel, clay-circle,
paper-drum. Granular: dust-archive, sleet, static-garden, insect-cathedral,
cinder-field, loom, rain-on-wires, frozen-letter, rust-chorus. Analog: cathedral-drift,
black-tide, hearth, paper-lantern, chapel-of-ash, tape-ghost, frost-lattice,
hollow-bones, broken-transmitter. Wavetable: pale-sun, glass-organ, tidewater,
copper-bell, sub-shelf, reed-choir, slow-tide. Percussion: taiko, snare-sheet,
log-drum, steel-tongue, anvil, brake-drum, glass-bell, bamboo-knock, clay-shaker.

**Broken → fixed (15).** splinter was a 15 ms click; muffled-parade a 40 ms thump;
bronze-meridian a "huge" gong 12 dB quieter than its neighbours; rosewood-steps a
55 ms dead knock; pc-floor-kick rang 45 ms (a tick, not a kick); pc-hat-foil was
15 dB under the kick; vapor-column and murmuration pinned the granular saturator and
sat 8–12 dB louder than their bank; tide-pool was a measured duplicate of
frozen-letter (feature distance 0.041); switchblade was an "aggressive" preset
quieter than the pads. Values and after-measurements in the manifest.

**Deleted (4).** glass-rain, slow-weather, rust-and-teeth, wt-cold-wire — each a
measured near-duplicate of a stronger neighbour (distances 0.04–0.16 on
attack/decay/centroid/loudness features). Reasoning per-preset in the manifest.

**Blocked on engine fixes (6).** matchstick, oak-hammer, battery-acid (new),
wt-iron-lung, wt-splintered, wt-furnace, wt-tin-pluck are all voiced correctly but
sit at -18..-21 dBFS peak because of the engine gain + drive-compensation defects
above. Do not preset-tweak these; fix the engines and they land in band together.

## 4. Gaps filled, and the one that remains

The analog bank used 10 of its 32 parameters — every preset was saw+saw through the
ladder; no preset in the library used unison, the sub oscillator modes, alternate
waveforms, the diode filter, or glide. For someone making tracks the three missing
staples were: a supersaw wall (aurora-wall — first use of unison), a sine sub bass
(bedrock — first use of sine waves + sine sub, keytrack 0 so it is identical at C2
and C3), and an acid line (battery-acid — first use of the diode filter and glide).

The sampler had no presets at all. It now has six treatments — see manifest; each was
validated against five deliberately different sources (sine, pluck, pad, noise hit,
reed formant) and kept only if its character survived every source. Two candidate
designs failed that test and were redesigned: mid-sample loop points rendered dead
silence on short sources, and 5-bit crush quantised quiet sources to nothing.

Remaining gap, deliberately not filled: nothing in the library is a proper e-piano/
keys sound with velocity expression beyond tine-letter, and there is no wavetable
chord-stab. Both are worth one slot each — after the engine gain fix, so they can be
voiced against honest levels.

## 5. How to keep this true

The measurement harness lives in the session scratchpad (audit.ts / verify.ts,
esbuild-bundled, no repo deps). It renders every default and preset and prints
pk/r300/sus/attack/decay/centroid plus test-constraint checks in ~30 s. Worth
promoting into tests/dsp/ as a loudness-band regression (per-bank peak within
±4 dB of bank median; every preset audible: r300 > -40 dB; every note ends) once
the engine gains are settled.
