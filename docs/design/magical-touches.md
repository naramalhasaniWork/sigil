# SIGIL — Magical touches

**Date:** 2026-08-18
**Status:** Design, top three implemented

SIGIL is capable. Six engines, 76 presets, Hunt, chords, camera play, kit export, MIDI learn,
bounce. Nothing on the feature list is missing. What is missing is the feeling that the
instrument is *with you* — and that absence has a specific address.

## Where it currently feels dead

I went looking for the effortful moments rather than the missing features.

1. **Hunt is dice.** Six cards labelled `Variation 1` … `Variation 6`, each drawn as a bar
   chart of the first twelve raw parameters. Two children of the same seed differ by a few
   percent on a handful of parameters, so the six charts look *identical*. Nothing on the
   card tells you what it is, how it differs, or which way it went. You cannot form a
   hypothesis, so you cannot learn — you can only click, listen, click. That is a slot
   machine, and slot machines get boring in ninety seconds. Hunt is billed in the foundation
   spec as "the magic is the point" and it is currently the least magical surface in the app.
2. **A found sound has no identity.** Audition a variation you love and it is called
   `Variation 4`. Save it and you must invent a name, cold, under a `window.prompt`, in the
   half-second after the sound impressed you. That is the exact moment the sound should
   become yours, and instead it becomes admin.
3. **Nothing accumulates.** Every reroll starts from scratch with the same statistics. Fifty
   generations in, the machine knows nothing about you that it did not know at generation
   one. Keeping a patch has no consequence beyond that one breeding step.
4. **Two-handed camera play is two controls, not one gesture.** The right hand drives all
   four macros at once from x, y, pinch *and* spread. Pinch and spread from a hand that is
   also translating are not independently controllable, so in practice you get four
   parameters smeared by one noisy limb.
5. **The first touch is dead.** Before Power is pressed, tapping the on-screen keys does
   nothing at all — no sound, no message. The silence before you play is currently occupied
   by a button labelled `Power`.

---

## Candidates

### 1. The true name
Every patch generates its own name from its own parameter values — deterministically, so the
same sound is always called the same thing. Two words, drawn from the four macro axes:
`Bright Tide`, `Rusted Bell`, `Dim Thread`. Prefilled the instant you go to save.

*Why magical, not gimmicky:* the name is not decoration sprinkled over the patch, it is a
*reading* of the patch. A dark heavy sound cannot come out called `Bright Tide`. So the name
tells you something true, and after a week you recognise your own vocabulary. Naming is the
act by which a found thing becomes a kept thing, and right now that act is a blank text box.

*Cost:* small. One pure module, curated word lists, a hash for determinism.

*Risk:* generated names can read as cute. Mitigation is ruthless word lists — nouns that are
materials and weather, never adjectives-as-nouns, never anything jokey — and the name stays
fully editable, so it is a suggestion, never an imposition.

### 2. The sigil
A deterministic geometric mark per patch: nine spokes at asymmetric angles whose lengths come
from the patch's own parameters, a silhouette connecting the tips, one filled node at the
longest spoke, one straight cut across the whole form. Hunt cards stop being bar charts and
become faces.

*Why magical:* the app is called SIGIL and the spec's first line says patches *are* sigils.
The mark is already promised. And it does real work: silhouettes are recognisable at a glance
in a way that twelve bars of equal height are not, so a grid of six children finally reads as
six different creatures. You start to recognise a patch before you hear it.

*Cost:* small. Pure geometry, flat strokes, no gradients — it is already the house style.

*Risk:* nine spokes from a centre is one CSS token away from a radar chart, which is a
cliché. Avoided by giving it no grid, no axes, no labels, deliberately asymmetric angles
(38.7° steps, leaving a visible gap) and the cut line, so it reads as a constructed mark.

### 3. Hunt speaks
Each variation card is labelled with the one or two largest musically meaningful moves it
made relative to its seed, in words: `Brighter`, `Longer tail`, `Looser`, `Dirtier`. Derived
from normalised parameter deltas and a keyword table over the descriptors.

*Why magical:* it converts a slot machine into a menu of directions. You can now form a
hypothesis ("the darker ones are working, go that way"), which is the difference between
gambling and hunting. It also quietly teaches synthesis — the same job the mandatory `explain`
field does in Deep view — because you hear `Brighter` and see which parameter moved.

*Cost:* small-medium. A pure ranking function plus a curated word table over the ~120
parameters across seven descriptors.

*Risk:* the label can lie. The biggest *numerical* mover is not always the biggest *audible*
mover, so a card might say `Brighter` when what you hear is the release. Mitigation: rank by
normalised delta, ignore anything under a threshold, and never show more than two words — an
honest partial description beats a confident wrong one.

### 4. The lineage trail
The patch carries the story of how it was found: `Glass Bell → brighter → longer tail →
bred`. Auditioning a sibling *replaces* the last word rather than appending, because a
sibling is a lateral move, not a step deeper. Shown live in Sculpt, stamped onto the patch
when you name it.

*Why magical:* provenance is what makes a thing yours. "I made this" is weak; "this came from
Glass Bell by way of two mutations and a breeding" is a story you can retell, and stories are
what you keep.

*Cost:* small, on top of #3 — the trail is made of #3's words.

*Risk:* it can become a log. Capped at four visible steps with an ellipsis, one line, no
timestamps, no tree view. The moment it needs scrolling it has failed.

### 5. Taste — the machine loads the dice
The pool learns from what you keep. Every breeding, the mean normalised offset between the
seed and the patches you kept is folded into a persistent taste vector, and the next
generation is seeded from that direction. By the fifth generation the machine is proposing
sounds in the region you have been choosing, and it says what it thinks you want:
`Following your ear: darker, looser`. One button to forget.

*Why magical:* this is the single largest gap between "generative feature" and "collaborator".
Nothing else on this list changes what the instrument *does* over time. It converts Keep from
a checkbox into a vote, which retroactively makes every earlier click meaningful.

*Cost:* medium. Pure vector maths, an exponential blend, plumbing into reroll and breed.

*Risk:* real, and worth naming. A taste vector that only accumulates walks parameters to the
walls — always keep the brighter one and cutoff pins at 18 kHz, at which point every child is
identical and the hunt dies. Mitigations: the vector is clamped to ±0.5 in normalised space,
decays each generation, and is applied at partial strength so the seed is nudged, not
teleported. It also resets on engine change, because a taste vector is indexed by parameter
and parameter 7 means something different in FM than in Analog.

### 6. The gap between your hands
Replace the right hand's four-macro smear with one axis computed from the *relationship*
between the hands: hands together = closed and dark, hands apart = open and bright. Two hands
become one instrument — left picks the note, the space between shapes it.

*Why magical:* it is the only idea here that changes what your body does. And it is the
correct diagnosis: the current mapping fails because four axes from one noisy limb is three
too many.

*Cost:* small in code, large in verification.

*Risk:* **I cannot test this.** It needs a camera, two hands, and an iPhone, and a gesture
mapping that is not tuned against a real hand is worse than the mapping it replaced. Shipping
a blind rewrite of the one surface I cannot verify is how you break a working feature.

### 7. The tape
The foundation spec promises it and it does not exist: a rolling, scrubbable history of every
patch state the instrument has passed through.

*Risk / cost:* medium-large, and the payoff is already 80% covered — `use-secrets` stores an
A/B snapshot, and Hunt's kept pool preserves what you liked. What remains is a new surface
with a scrub control that produces no new sound. It buys safety, not magic.

### 8. Motion record on the XY pad
Draw a gesture, it loops, the sound keeps moving.

*Risk:* it is a second modulation system parallel to the LFOs that already exist per engine,
with none of their per-sample resolution. Two overlapping ways to make a parameter wobble is
worse than one good one.

### 9. First touch is never dead
Tapping a key before Power starts the audio context *and* sounds the note.

*Honest read:* this is correct and should be done, but it is a bug fix wearing a feature's
clothes. It removes a dead moment; it does not create a live one.

### 10. The invocation — a cold-open screen
Replace the Power button with a ceremonial full-bleed sigil of the day.

*Risk:* decoration over a dead touch. Ceremony in front of a broken first interaction makes
the break feel deliberate. Fix #9 and the cold open is unnecessary.

### 11. Warmer / colder
Replace the six-card grid with one sound and two directions.

*Risk:* it is a redesign of Hunt's shape rather than a finishing touch, it throws away
breeding, and six *legible* cards give you the same steering with more information per click.

### 12. The instrument notices your habits
"You have bounced six sounds in C minor — build a kit?"

*Risk:* thin data, creepy tone, and it arrives as a nag over the pads mid-phrase. #5 is the
same instinct done where there is real signal (explicit Keep votes) and no interruption.

### 13. Kits that name themselves
EP-133 slots named from their patches' true names rather than `sigil-analog-60-63-67`.

*Honest read:* good, cheap, and a free consequence of #1 once names exist. Not a finishing
touch on its own — a follow-up.

---

## Ranking and the three

**Chosen: #1+#2 as one feature (identity), #3+#4 as one feature (story), #5 (taste).**

Ideas 1 and 2 are one design move, not two — a patch's identity is its name and its face, and
shipping either alone leaves the other conspicuously missing. Same for 3 and 4: the lineage
trail is literally assembled out of the direction words, so building 3 and not 4 means writing
the hard part and throwing away the payoff.

The argument for these three over the rest is that they are the three stages of one loop, and
that loop is both the deadest surface in the app and the one the spec stakes the whole design
on:

| Stage | Question the player is asking | Feature |
|---|---|---|
| Browse | "which of these six is which?" | The sigil and the true name |
| Understand | "which way did that one go?" | Hunt speaks, and the trail |
| Converge | "does this thing know what I like yet?" | Taste |

They compound. The sigil makes the cards distinguishable; the words make them steerable; taste
makes the steering accumulate; and the trail means that when you finally stop, the thing you
stopped on already has a name and a story and is one press from being yours. Any one of the
three alone is an improvement. All three change what Hunt *is*.

**Rejected, and why not:**

- **#6, the gap between your hands** is the idea I most want to build and the one I should not.
  It needs a camera and a real hand to tune, and I have neither. A blind rewrite of the only
  input surface I cannot verify trades a working feature for an untested one. The diagnosis is
  in this document so it can be built by someone holding the phone.
- **#7, the tape** is promised by the spec, but A/B snapshot and the kept pool already provide
  the safety it is for. It is a surface that produces no sound.
- **#8, #11** each add a second system that competes with one already working (LFOs, breeding).
- **#9** is right and small; it is a bug, and it should be filed as one rather than dressed up.
- **#10, #12, #13** are decoration, surveillance, and a follow-up respectively.

Three things that feel inevitable: a sigil has a name and a face; a hunt has a direction; and
an instrument you keep choosing with should eventually know what you keep choosing.

---

## What was built

| Module | Contents | Tests |
|---|---|---|
| `src/dsp/signature.ts` | macro-axis signature, deterministic hash, `sigilName`, `sigilOf` geometry, `uniqueName` | `tests/dsp/signature.test.ts` |
| `src/dsp/lineage.ts` | `PARAM_WORDS` table, `rankedMoves`, `topLabels`, `renderTrail`, `appendStep` | `tests/dsp/lineage.test.ts` |
| `src/dsp/taste.ts` | `tasteFrom`, `blendTaste`, `applyTaste`, `decayTaste`, `tasteStrength` | `tests/dsp/taste.test.ts` |
| `src/ui/use-hunt-lore.ts` | lineage steps, tentative step, taste accumulation, seed biasing | covered via the pure modules |
| `src/ui/components/sigil-glyph.tsx` | the mark, flat strokes | — |
| `src/ui/components/hunt-card.tsx` | one variation: face, name, direction words, keep | — |
| `src/ui/components/hunt-grid.tsx` | rebuilt grid, trail line, taste line, forget | — |
| `src/ui/components/sigil-card.tsx` | the current sound's face, name, trail, and `Name it` | — |

Reached in the UI: **Hunt** tab for cards, trail, taste line and `Forget`; **Sculpt** tab for
the current sound's sigil card and `Name it`; the Save prompt in the preset rail arrives
prefilled with the true name.
