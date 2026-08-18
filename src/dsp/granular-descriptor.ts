import type { EngineDescriptor } from '@/audio/types';

export const GRANULAR_DESCRIPTOR: EngineDescriptor = {
  id: 'granular',
  name: 'Granular',
  colour: '#8B5CF6',
  macroNames: ['Body', 'Air', 'Grit', 'Motion'],
  params: [
    {
      id: 'grain-density', name: 'Density', group: 'Cloud', unit: 'hz',
      min: 0.5, max: 200, default: 32, curve: 'exp', macro: 3, macroDepth: 0.7,
      mutability: 0.9,
      explain: 'How many grains are thrown per second. Low counts sound like scattered droplets you can hear individually; high counts fuse into one continuous, thick texture.',
    },
    {
      id: 'grain-size', name: 'Grain Size', group: 'Cloud', unit: 'ms',
      min: 5, max: 400, default: 90, curve: 'exp', macro: 0, macroDepth: 0.6,
      mutability: 0.8,
      explain: 'How long each slice of sound lasts. Tiny grains lose their pitch and turn into buzzing texture; long grains keep the character of the source and sound smooth and vocal.',
    },
    {
      id: 'position', name: 'Position', group: 'Source', unit: 'pct',
      min: 0, max: 1, default: 0.12, curve: 'linear', macro: 1, macroDepth: 0.8,
      mutability: 0.9,
      explain: 'Where in the source material the grains are read from. Moving it walks you through different timbres, from dark and thick at one end to bright and airy at the other.',
    },
    {
      id: 'spray', name: 'Spray', group: 'Source', unit: 'pct',
      min: 0, max: 1, default: 0.12, curve: 'linear', macro: 2, macroDepth: 0.7,
      mutability: 0.9,
      explain: 'Scatters each grain randomly around the read position instead of taking them all from the same spot. A little stops the cloud sounding like a stuck loop; a lot smears everything into noise.',
    },
    {
      id: 'pitch-scatter', name: 'Pitch Scatter', group: 'Source', unit: 'semitones',
      min: 0, max: 12, default: 0.25, curve: 'linear', mutability: 0.8,
      explain: 'Detunes every grain by a random amount. Small values thicken the note like a chorus; large values spray it into a shimmering, atonal cloud that no longer has one clear pitch.',
    },
    {
      id: 'reverse', name: 'Reverse', group: 'Source', unit: 'pct',
      min: 0, max: 1, default: 0.1, curve: 'linear', mutability: 0.7,
      explain: 'The chance that any given grain plays backwards. Mixed in small amounts it removes the forward push of the sound and makes the texture feel suspended rather than moving.',
    },
    {
      id: 'window-shape', name: 'Window', group: 'Cloud', unit: 'pct',
      min: 0, max: 1, default: 1, curve: 'linear', mutability: 0.6,
      explain: 'How gently each grain fades in and out. Fully up is a soft bell shape that sounds smooth; turned down the grains hold flat for longer, which sounds punchier and more percussive.',
    },
    {
      id: 'amp-attack', name: 'Attack', group: 'Envelope', unit: 'ms',
      min: 0.5, max: 4000, default: 25, curve: 'exp', mutability: 0.6,
      explain: 'How long the whole cloud takes to reach full volume. Long attacks let the grains gather gradually, which is what turns this engine into a slow-blooming pad.',
    },
    {
      id: 'amp-decay', name: 'Decay', group: 'Envelope', unit: 'ms',
      min: 1, max: 8000, default: 700, curve: 'exp', mutability: 0.6,
      explain: 'How quickly the cloud settles from its loudest point down to the level it holds at while the key is down.',
    },
    {
      id: 'amp-sustain', name: 'Sustain', group: 'Envelope', unit: 'pct',
      min: 0, max: 1, default: 0.75, curve: 'linear', mutability: 0.5,
      explain: 'The level the cloud holds while you keep the key down. Drop it to zero and each note becomes a single burst of grains rather than a sustained texture.',
    },
    {
      id: 'amp-release', name: 'Release', group: 'Envelope', unit: 'ms',
      min: 1, max: 8000, default: 900, curve: 'exp', mutability: 0.6,
      explain: 'How long the cloud takes to disperse after you let go. Long releases let overlapping notes blur into a continuous wash, which is most of the appeal of granular sound.',
    },
  ],
};
