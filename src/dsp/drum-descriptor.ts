import type { EngineDescriptor } from '@/audio/types';

/**
 * The Drum engine's control surface.
 *
 * One engine, twelve instruments: every semitone of the octave is a different
 * drum voice (kick on C, snare on C#, hats on D and D#, and so on, repeating
 * each octave), which is how hardware drum synths have always worked and what
 * makes a whole kit playable from one keyboard row. Per-instrument controls
 * exist only where they earn their place — the kick and snare, the two drums
 * everyone tunes — and the rest of the kit is shaped by kit-wide gestures:
 * tune, spread, decay, colour, drive, and three grouped level trims.
 *
 * Parameter INDEX is a wire format: entries never move, new ones are appended.
 */
export const DRUM_DESCRIPTOR: EngineDescriptor = {
  id: 'drum',
  name: 'Drum',
  colour: '#E8A33D',
  macroNames: ['Body', 'Air', 'Grit', 'Motion'],
  params: [
    {
      id: 'kick-tune', name: 'Kick Tune', group: 'Kick', unit: 'hz',
      min: 30, max: 100, default: 48, curve: 'exp', mutability: 0.6,
      explain: 'Where the kick sits once its pitch dive has finished, in cycles per second. Around 50 is a club kick you feel in your chest; higher becomes a tighter, punchier thump.',
    },
    {
      id: 'kick-sweep', name: 'Kick Sweep', group: 'Kick', unit: 'pct',
      min: 0, max: 1, default: 0.6, curve: 'linear', mutability: 0.8,
      explain: 'How far above its resting pitch the kick starts before diving down. The dive is the punch: none is a dull sine tone, a lot is the hard falling thwack of a techno kick.',
    },
    {
      id: 'kick-click', name: 'Kick Click', group: 'Kick', unit: 'pct',
      min: 0, max: 1, default: 0.4, curve: 'linear', mutability: 0.7,
      explain: 'A tiny burst of filtered noise at the very front of the kick. It is what lets the kick cut through a busy mix on small speakers that cannot reproduce the low end at all.',
    },
    {
      id: 'kick-decay', name: 'Kick Decay', group: 'Kick', unit: 'ms',
      min: 80, max: 1500, default: 450, curve: 'exp', mutability: 0.6,
      explain: 'How long the kick rings after the hit. Short is a tight thud for fast patterns; long is a booming 808-style tail that starts acting like a bassline of its own.',
    },
    {
      id: 'snare-tone', name: 'Snare Tone', group: 'Snare', unit: 'pct',
      min: 0, max: 1, default: 0.5, curve: 'linear', mutability: 0.8,
      explain: 'Balance between the drum body and the rattle. Low is all shell — a boxy, tom-like knock; high is all wires — a bright crack. Real snares live somewhere in between.',
    },
    {
      id: 'snare-decay', name: 'Snare Decay', group: 'Snare', unit: 'ms',
      min: 60, max: 900, default: 260, curve: 'exp', mutability: 0.6,
      explain: 'How long the snare rattle rings. Short is a dry funk hit; long is a roomy rock backbeat that fills the space between the kicks.',
    },
    {
      id: 'hat-decay', name: 'Hat Decay', group: 'Metals', unit: 'ms',
      min: 100, max: 2500, default: 700, curve: 'exp', mutability: 0.7,
      explain: 'How long the open hat rings before fading; the closed hat is always a short slice of the same sound. Playing either hat cuts the other dead, like a real pair on one stand.',
    },
    {
      id: 'air', name: 'Air', group: 'Metals', unit: 'pct',
      min: 0, max: 1, default: 0.5, curve: 'linear', macro: 1, macroDepth: 0.8,
      mutability: 0.85,
      explain: 'Brightness of every metal sound in the kit — hats, cymbals, their sizzle. Turn it down for dusty lo-fi metals, up for crisp modern ones that sit on top of the mix.',
    },
    {
      id: 'tune', name: 'Kit Tune', group: 'Kit', unit: 'semitones',
      min: -12, max: 12, default: 0, curve: 'linear', mutability: 0.3,
      explain: 'Shifts the whole kit up or down in semitones. Drums are pitched material like everything else: tuning the kit to the song is the difference between drums that sit in the track and drums that fight it.',
    },
    {
      id: 'tune-spread', name: 'Spread', group: 'Metals', unit: 'pct',
      min: 0, max: 1, default: 0.5, curve: 'linear', mutability: 0.85,
      explain: 'How far apart the six oscillators inside the metallic sounds are pushed. Low makes hats and cymbals ring almost like a bell; high smears them into a dense, inharmonic sheet of metal.',
    },
    {
      id: 'decay-scale', name: 'Decay Scale', group: 'Kit', unit: 'ratio',
      min: 0.25, max: 4, default: 1, curve: 'exp', macro: 3, macroDepth: 0.7,
      mutability: 0.7,
      explain: 'Stretches or tightens every decay in the kit at once. This is the room the kit lives in: short is a dead, dry booth; long lets every hit bloom and ring into the next.',
    },
    {
      id: 'noise-colour', name: 'Noise Colour', group: 'Kit', unit: 'pct',
      min: 0, max: 1, default: 0.6, curve: 'linear', mutability: 0.8,
      explain: 'The tone of the noise inside snares, claps and cymbal sizzle, from dark rumble to bright hiss. Darker noise reads as bigger and further away; brighter reads as closer and sharper.',
    },
    {
      id: 'drive', name: 'Drive', group: 'Kit', unit: 'pct',
      min: 0, max: 1, default: 0.15, curve: 'linear', macro: 2, macroDepth: 0.85,
      mutability: 0.9,
      explain: 'Pushes every drum into a saturating amplifier. A little glues the kit together and adds weight; a lot crushes it into aggressive, distorted territory.',
    },
    {
      id: 'level-low', name: 'Drums Level', group: 'Levels', unit: 'pct',
      min: 0, max: 1, default: 0.85, curve: 'linear', macro: 0, macroDepth: 0.8,
      mutability: 0.3,
      explain: 'Volume of the kick and toms — the weight of the kit. Raise it when the low end has to carry the track, lower it when the drums should sit behind a bassline.',
    },
    {
      id: 'level-mid', name: 'Snares Level', group: 'Levels', unit: 'pct',
      min: 0, max: 1, default: 0.8, curve: 'linear', mutability: 0.3,
      explain: 'Volume of the snare, clap and rim — the backbeat. This is how loudly the kit answers back on two and four; mix it against the kick to set the balance of the groove.',
    },
    {
      id: 'level-high', name: 'Metals Level', group: 'Levels', unit: 'pct',
      min: 0, max: 1, default: 0.7, curve: 'linear', mutability: 0.3,
      explain: 'Volume of the hats, cymbals and cowbell — the timekeepers. Lower it to push the metals into the background, raise it when the top end has to drive the groove.',
    },
  ],
};
