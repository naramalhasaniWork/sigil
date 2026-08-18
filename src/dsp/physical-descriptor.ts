import type { EngineDescriptor } from '@/audio/types';

export const PHYSICAL_DESCRIPTOR: EngineDescriptor = {
  id: 'physical',
  name: 'Physical',
  colour: '#FFD93D',
  macroNames: ['Body', 'Air', 'Grit', 'Motion'],
  params: [
    {
      id: 'material', name: 'Material', group: 'Body', unit: 'pct',
      min: 0, max: 1, default: 0.62, curve: 'linear', macro: 0, macroDepth: 0.9,
      mutability: 0.9,
      explain: 'Morphs the resonator between four real objects: drum head, wood bar, struck metal and glass. It reshapes the whole set of ringing frequencies, so it changes what the sound IS rather than how it is filtered.',
    },
    {
      id: 'structure', name: 'Structure', group: 'Body', unit: 'pct',
      min: 0, max: 1, default: 0.25, curve: 'linear', mutability: 0.8,
      explain: 'Stretches the upper partials sharp, the way a stiff or thick object goes out of tune with itself. A little makes the body feel solid and real; a lot makes it clangy and bell-like.',
    },
    {
      id: 'decay', name: 'Decay', group: 'Body', unit: 'ms',
      min: 20, max: 3000, default: 900, curve: 'exp', mutability: 0.7,
      explain: 'How long the object rings after it is hit, before it falls silent. Short is a tap on a table, long is a struck cymbal left to ring out.',
    },
    {
      id: 'damping', name: 'Damping', group: 'Body', unit: 'pct',
      min: 0, max: 1, default: 0.35, curve: 'linear', macro: 3, macroDepth: 0.55,
      mutability: 0.9,
      explain: 'Muffles the object, killing high partials much faster than low ones — exactly what happens when you rest a hand on a cymbal or wrap a drum in cloth. It makes a bright ring turn into a dull thud over time.',
    },
    {
      id: 'position', name: 'Position', group: 'Body', unit: 'pct',
      min: 0.02, max: 0.98, default: 0.28, curve: 'linear', mutability: 0.9,
      explain: 'Where on the object you strike it. Near the edge you wake up the higher, thinner partials; nearer the middle you get the fat fundamental. It is the difference between a rim shot and a centre hit.',
    },
    {
      id: 'air', name: 'Air', group: 'Body', unit: 'pct',
      min: 0, max: 1, default: 0.55, curve: 'linear', macro: 1, macroDepth: 0.7,
      mutability: 0.9,
      explain: 'How many partials the object is allowed to ring with, and how loud the high ones are. Low is a small dead object, high is a big shimmering one with lots of overtones in the air.',
    },
    {
      id: 'exciter-type', name: 'Exciter', group: 'Exciter', unit: 'none',
      min: 0, max: 2, default: 0, curve: 'stepped', steps: 3, mutability: 0.5,
      explain: 'What sets the object moving: a mallet strike, a burst of noise like a scrape, or a continuous bow that keeps feeding it energy for as long as you hold the note.',
    },
    {
      id: 'grit', name: 'Grit', group: 'Exciter', unit: 'pct',
      min: 0, max: 1, default: 0.4, curve: 'linear', macro: 2, macroDepth: 0.6,
      mutability: 0.9,
      explain: 'How rough and noisy the contact is. Turn it up for scratchy, dirty, hand-made attacks; turn it down for a clean, polished, almost synthetic hit.',
    },
    {
      id: 'hardness', name: 'Hardness', group: 'Exciter', unit: 'ms',
      min: 0.2, max: 80, default: 3, curve: 'exp', mutability: 0.8,
      explain: 'How long the exciter stays in contact with the object. A very short contact is a hard stick and sounds bright and clicky; a long one is a soft felt beater and only wakes the low partials.',
    },
    {
      id: 'exciter-tone', name: 'Exciter Tone', group: 'Exciter', unit: 'hz',
      min: 200, max: 16000, default: 4500, curve: 'exp', mutability: 0.8,
      explain: 'Filters the exciter before it reaches the object, deciding which partials it is able to wake up. Lower it for a soft muted knock, raise it for a sharp bright crack.',
    },
    {
      id: 'release', name: 'Release', group: 'Exciter', unit: 'ms',
      min: 5, max: 2000, default: 120, curve: 'exp', mutability: 0.6,
      explain: 'How quickly the bow lifts off when you let go of the note. It only matters for the bowed exciter, where you are feeding the object continuously and have to stop.',
    },
    {
      id: 'level', name: 'Level', group: 'Output', unit: 'pct',
      min: 0, max: 1, default: 0.75, curve: 'linear', mutability: 0.4,
      explain: 'Output volume of the voice, with gentle saturation as it is pushed. Useful for balancing this engine against the others rather than for shaping the sound.',
    },
  ],
};
