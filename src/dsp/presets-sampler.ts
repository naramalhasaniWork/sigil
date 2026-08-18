import type { Preset } from '@/dsp/presets';

/**
 * The sampler bank. A sampler preset cannot ship a sample, so every entry here
 * is a TREATMENT: a start/loop/pitch/filter/envelope/character stance that does
 * something recognisable and musical to whatever the player has just recorded
 * or dropped in. Each one was validated offline against five deliberately
 * different sources — a pure sine, an analog pluck, a slow pad, a noise-burst
 * drum and a reedy formant tone — and kept only if its character survived the
 * change of source. Loops anchor at the head of the sample because the head is
 * the one region guaranteed to contain energy on an arbitrary recording.
 */
export const SAMPLER_PRESETS: readonly Preset[] = [
  {
    id: 'smp-tape-memory', name: 'Tape Memory', engineId: 'sampler',
    character: ['warm', 'broken'],
    values: {
      'wobble': 0.3, 'wobble-rate': 0.9, 'filter-cutoff': 5500, 'drive': 0.3,
      'crush': 12, 'amp-attack': 8, 'amp-decay': 1200, 'amp-sustain': 0.8,
      'amp-release': 350,
    },
  },
  {
    id: 'smp-eight-bit', name: 'Eight Bit', engineId: 'sampler',
    character: ['broken', 'aggressive'],
    values: {
      'crush': 7, 'drive': 0.55, 'filter-cutoff': 11000, 'filter-resonance': 0.2,
      'amp-decay': 700, 'amp-sustain': 0.9, 'amp-release': 80,
    },
  },
  {
    id: 'smp-undertow', name: 'Undertow', engineId: 'sampler',
    character: ['sweeping', 'hollow'],
    values: {
      'reverse': 1, 'amp-attack': 250, 'amp-sustain': 1, 'amp-release': 1400,
      'filter-cutoff': 7000, 'drive': 0.15,
    },
  },
  {
    id: 'smp-stone-choir', name: 'Stone Choir', engineId: 'sampler',
    character: ['huge', 'dark'],
    values: {
      'loop-mode': 1, 'loop-start': 0, 'loop-length': 0.12, 'loop-fade': 120,
      'tune': -12, 'filter-cutoff': 3800, 'drive': 0.25,
      'amp-attack': 350, 'amp-sustain': 1, 'amp-release': 2500,
    },
  },
  {
    id: 'smp-flint', name: 'Flint', engineId: 'sampler',
    character: ['plucked', 'wooden'],
    values: {
      'amp-attack': 0.5, 'amp-decay': 150, 'amp-sustain': 0, 'amp-release': 100,
      'filter-cutoff': 3000, 'filter-resonance': 0.25, 'drive': 0.35,
    },
  },
  {
    id: 'smp-numbers-station', name: 'Numbers Station', engineId: 'sampler',
    character: ['broken', 'metallic'],
    values: {
      'loop-mode': 1, 'loop-start': 0, 'loop-length': 0.2, 'loop-fade': 60,
      'crush': 8, 'drive': 0.6, 'wobble': 0.5, 'wobble-rate': 6.5,
      'filter-cutoff': 2800, 'filter-resonance': 0.5,
      'amp-sustain': 1, 'amp-release': 300,
    },
  },
];
