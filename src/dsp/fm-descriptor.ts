import type { EngineDescriptor, ParamDescriptor } from '@/audio/types';

/**
 * Four-operator FM, DX7 lineage. Parameter order is load-bearing: fm-voice.ts
 * indexes this table by position, and the per-operator block is a repeating
 * stride of three (ratio, fine, level) starting at index 1.
 */

function op(n: number, ratio: number, level: number, why: string): ParamDescriptor[] {
  return [
    {
      id: `op${n}-ratio`, name: `Op ${n} Ratio`, group: `Operator ${n}`, unit: 'ratio',
      min: 0.5, max: 16, default: ratio, curve: 'stepped', steps: 17, mutability: 0.7,
      explain: `How fast operator ${n} runs compared to the note you played. Whole numbers stay musical and harmonic; the half-speed setting adds an octave-below weight. ${why}`,
    },
    {
      id: `op${n}-fine`, name: `Op ${n} Fine`, group: `Operator ${n}`, unit: 'semitones',
      min: -0.5, max: 0.5, default: 0, curve: 'linear', mutability: 0.8,
      explain: `Nudges operator ${n} slightly off its exact ratio. Tiny amounts make the tone breathe and beat slowly instead of standing dead still; large amounts sound out of tune.`,
    },
    {
      id: `op${n}-level`, name: `Op ${n} Level`, group: `Operator ${n}`, unit: 'pct',
      min: 0, max: 1, default: level, curve: 'linear', mutability: 0.8,
      explain: `How loud operator ${n} is. When it is a carrier this is volume; when it is a modulator this is how hard it bends the operator below it, which means brightness.`,
    },
  ];
}

export const FM_DESCRIPTOR: EngineDescriptor = {
  id: 'fm',
  name: 'FM',
  colour: '#4ECDC4',
  macroNames: ['Body', 'Air', 'Grit', 'Motion'],
  params: [
    {
      id: 'algorithm', name: 'Algorithm', group: 'Routing', unit: 'none',
      min: 0, max: 4, default: 2, curve: 'stepped', steps: 5, mutability: 0.6,
      explain: 'Which operators feed which: 0 is a two-operator stack, 1 a three-operator stack, 2 two stacks side by side, 3 four plain sines together, 4 a feedback branch. This is the single biggest change to the character of the sound.',
    },
    ...op(1, 1, 1.0, 'Operator 1 is a carrier in every algorithm, so its ratio sets the pitch you actually hear.'),
    ...op(2, 2, 0.75, 'As a modulator its ratio decides which overtones appear above the note.'),
    ...op(3, 1, 0.9, 'It is a carrier in the twin-stack and parallel algorithms, a modulator elsewhere.'),
    ...op(4, 3, 0.7, 'This is the operator that can feed back into itself, so odd ratios here get noisy fast.'),
    {
      id: 'index', name: 'Index', group: 'Tone', unit: 'pct',
      min: 0, max: 12, default: 3, curve: 'exp', macro: 1, macroDepth: 0.7, mutability: 0.9,
      explain: 'How hard the modulating operators bend the carriers. At zero you get plain sine tones; raise it and overtones pile on, turning soft bells into bright metallic attacks. This is the brightness control of an FM synth.',
    },
    {
      id: 'key-scale', name: 'Key Scale', group: 'Tone', unit: 'pct',
      min: 0, max: 1, default: 0.6, curve: 'linear', mutability: 0.5,
      explain: 'Pulls the index back down as you play higher notes. Without it a patch that sounds rich in the bass turns into harsh fizz at the top of the keyboard, because the overtones run past what your ears can take.',
    },
    {
      id: 'feedback', name: 'Feedback', group: 'Tone', unit: 'pct',
      min: 0, max: 1, default: 0.15, curve: 'linear', macro: 2, macroDepth: 0.6, mutability: 0.9,
      explain: 'Feeds operator 4 back into itself. A little roughens the tone the way a bowed string is rough; pushed hard the sine collapses toward noise, which is how FM makes cymbals and breath.',
    },
    {
      id: 'spread', name: 'Spread', group: 'Tone', unit: 'pct',
      min: 0, max: 1, default: 0.2, curve: 'linear', macro: 3, macroDepth: 0.6, mutability: 0.9,
      explain: 'Detunes the four operators away from each other by small, different amounts. The overtones then drift in and out of step, so a held note keeps moving instead of freezing into a dead tone.',
    },
    {
      id: 'balance', name: 'Balance', group: 'Mix', unit: 'pct',
      min: 0, max: 1, default: 0.45, curve: 'linear', macro: 0, macroDepth: 0.5, mutability: 0.7,
      explain: 'Tilts the mix between the lower and upper carriers. Turn it down for weight and fundamental; turn it up for the thinner, brighter carrier on top. With a single-carrier algorithm it simply sets how much body the note has.',
    },
    {
      id: 'amp-attack', name: 'Attack', group: 'Carrier Envelope', unit: 'ms',
      min: 0.5, max: 4000, default: 3, curve: 'exp', mutability: 0.6,
      explain: 'How long the note takes to reach full volume. Very short is what makes FM pianos and basses snap; long turns the same patch into a glass pad.',
    },
    {
      id: 'amp-decay', name: 'Decay', group: 'Carrier Envelope', unit: 'ms',
      min: 1, max: 8000, default: 700, curve: 'exp', mutability: 0.6,
      explain: 'How quickly the note falls from its peak toward the sustain level. Short decays with no sustain give you the classic FM bell and electric piano.',
    },
    {
      id: 'amp-sustain', name: 'Sustain', group: 'Carrier Envelope', unit: 'pct',
      min: 0, max: 1, default: 0.55, curve: 'linear', mutability: 0.5,
      explain: 'The level the note holds at while the key is down. Set it to zero and every note decays away on its own like a struck object.',
    },
    {
      id: 'amp-release', name: 'Release', group: 'Carrier Envelope', unit: 'ms',
      min: 1, max: 8000, default: 400, curve: 'exp', mutability: 0.6,
      explain: 'How long the note takes to fade after you let go. Longer releases let chords ring into each other, which flatters bell and mallet tones.',
    },
    {
      id: 'mod-attack', name: 'Mod Attack', group: 'Modulator Envelope', unit: 'ms',
      min: 0.5, max: 4000, default: 1, curve: 'exp', mutability: 0.7,
      explain: 'How long the modulating operators take to reach full strength. Slow it down and the note fades in from dull to bright, which reads as a bowed or blown attack.',
    },
    {
      id: 'mod-decay', name: 'Mod Decay', group: 'Modulator Envelope', unit: 'ms',
      min: 1, max: 8000, default: 400, curve: 'exp', mutability: 0.8,
      explain: 'How fast the brightness falls away after the attack. A short mod decay with a long carrier decay is the whole trick behind FM electric pianos: bright strike, mellow tail.',
    },
    {
      id: 'mod-sustain', name: 'Mod Sustain', group: 'Modulator Envelope', unit: 'pct',
      min: 0, max: 1, default: 0.3, curve: 'linear', mutability: 0.7,
      explain: 'How much brightness remains while you hold the note. Low values keep held notes calm no matter how extreme the initial attack was.',
    },
    {
      id: 'mod-release', name: 'Mod Release', group: 'Modulator Envelope', unit: 'ms',
      min: 1, max: 8000, default: 300, curve: 'exp', mutability: 0.6,
      explain: 'How the overtones fade once you let go. Making this shorter than the carrier release means notes soften into pure sine as they die away.',
    },
  ],
};
