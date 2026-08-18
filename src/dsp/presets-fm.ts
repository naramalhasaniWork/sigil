import type { Preset } from '@/dsp/presets';

/**
 * The FM bank. Operator ratios sit on the DX7-style grid (0.5 or whole
 * numbers): high modulator ratios with fast mod decays make bells, low ratios
 * with feedback make basses, and detuned parallel carriers make glass pads.
 * Every algorithm in the routing table earns at least one preset here.
 */
export const FM_PRESETS: readonly Preset[] = [
  {
    id: 'cloister-bell', name: 'Cloister Bell', engineId: 'fm',
    character: ['glassy', 'metallic', 'hollow'],
    values: {
      'algorithm': 0, 'op1-ratio': 1, 'op2-ratio': 7, 'op2-level': 0.6,
      'index': 5, 'key-scale': 0.8, 'feedback': 0.05, 'spread': 0.1, 'balance': 0.3,
      'amp-attack': 0.5, 'amp-decay': 3500, 'amp-sustain': 0, 'amp-release': 4500,
      'mod-attack': 0.5, 'mod-decay': 1200, 'mod-sustain': 0, 'mod-release': 900,
    },
  },
  {
    id: 'tine-letter', name: 'Tine Letter', engineId: 'fm',
    character: ['warm', 'glassy'],
    values: {
      'algorithm': 0, 'op1-ratio': 1, 'op2-ratio': 14, 'op2-level': 0.35,
      'index': 2.2, 'key-scale': 0.75, 'feedback': 0.08, 'spread': 0.08, 'balance': 0.35,
      'amp-attack': 0.5, 'amp-decay': 2600, 'amp-sustain': 0.2, 'amp-release': 600,
      'mod-attack': 0.5, 'mod-decay': 160, 'mod-sustain': 0.05, 'mod-release': 200,
    },
  },
  {
    id: 'night-market', name: 'Night Market', engineId: 'fm',
    character: ['warm', 'plucked'],
    values: {
      'algorithm': 2, 'op1-ratio': 1, 'op2-ratio': 2, 'op2-level': 0.5,
      'op3-ratio': 1, 'op3-fine': 0.03, 'op3-level': 0.7, 'op4-ratio': 8, 'op4-level': 0.3,
      'index': 2.8, 'key-scale': 0.7, 'feedback': 0.1, 'spread': 0.15, 'balance': 0.4,
      'amp-attack': 0.5, 'amp-decay': 1800, 'amp-sustain': 0.15, 'amp-release': 450,
      'mod-attack': 0.5, 'mod-decay': 300, 'mod-sustain': 0.1, 'mod-release': 250,
    },
  },
  {
    id: 'iron-hymn', name: 'Iron Hymn', engineId: 'fm',
    character: ['dark', 'huge', 'metallic'],
    values: {
      'algorithm': 1, 'op1-ratio': 0.5, 'op2-ratio': 1, 'op2-level': 0.7,
      'op3-ratio': 3, 'op3-level': 0.5,
      'index': 4, 'key-scale': 0.6, 'feedback': 0.2, 'spread': 0.35, 'balance': 0.2,
      'amp-attack': 400, 'amp-decay': 3000, 'amp-sustain': 0.8, 'amp-release': 3000,
      'mod-attack': 800, 'mod-decay': 2000, 'mod-sustain': 0.4, 'mod-release': 1500,
    },
  },
  {
    id: 'serrated-bass', name: 'Serrated Bass', engineId: 'fm',
    character: ['aggressive', 'dark'],
    values: {
      'algorithm': 4, 'op1-ratio': 0.5, 'op2-ratio': 1, 'op2-level': 0.8,
      'op4-ratio': 1, 'op4-level': 0.85,
      'index': 5.5, 'key-scale': 0.9, 'feedback': 0.8, 'spread': 0.1, 'balance': 0.2,
      'amp-attack': 0.5, 'amp-decay': 900, 'amp-sustain': 0.65, 'amp-release': 150,
      'mod-attack': 0.5, 'mod-decay': 350, 'mod-sustain': 0.4, 'mod-release': 120,
    },
  },
  {
    id: 'copper-wasp', name: 'Copper Wasp', engineId: 'fm',
    character: ['aggressive', 'broken'],
    values: {
      'algorithm': 4, 'op1-ratio': 1, 'op2-ratio': 2, 'op2-level': 0.9,
      'op4-ratio': 11, 'op4-level': 0.8,
      'index': 9, 'key-scale': 0.85, 'feedback': 1, 'spread': 0.5, 'balance': 0.5,
      'amp-attack': 0.5, 'amp-decay': 700, 'amp-sustain': 0.7, 'amp-release': 200,
      'mod-attack': 0.5, 'mod-decay': 600, 'mod-sustain': 0.7, 'mod-release': 300,
    },
  },
  {
    id: 'frozen-choir', name: 'Frozen Choir', engineId: 'fm',
    character: ['glassy', 'huge', 'sweeping'],
    values: {
      'algorithm': 2, 'op1-ratio': 1, 'op1-fine': -0.06, 'op2-ratio': 2, 'op2-level': 0.4,
      'op3-ratio': 1, 'op3-fine': 0.06, 'op3-level': 0.9, 'op4-ratio': 2, 'op4-level': 0.4,
      'index': 2, 'key-scale': 0.7, 'feedback': 0.05, 'spread': 0.65, 'balance': 0.5,
      'amp-attack': 1900, 'amp-decay': 3000, 'amp-sustain': 0.9, 'amp-release': 5000,
      'mod-attack': 2600, 'mod-decay': 2000, 'mod-sustain': 0.5, 'mod-release': 2500,
    },
  },
  {
    id: 'glass-harmonium', name: 'Glass Harmonium', engineId: 'fm',
    character: ['glassy', 'hollow', 'warm'],
    values: {
      'algorithm': 3, 'op1-ratio': 1, 'op1-level': 1, 'op2-ratio': 2, 'op2-level': 0.5,
      'op3-ratio': 4, 'op3-level': 0.3, 'op4-ratio': 8, 'op4-level': 0.15, 'op2-fine': 0.02,
      'index': 0.8, 'key-scale': 0.5, 'feedback': 0, 'spread': 0.3, 'balance': 0.4,
      'amp-attack': 700, 'amp-decay': 2500, 'amp-sustain': 0.85, 'amp-release': 2200,
      'mod-attack': 0.5, 'mod-decay': 1000, 'mod-sustain': 0.3, 'mod-release': 800,
    },
  },
  {
    id: 'signal-fire', name: 'Signal Fire', engineId: 'fm',
    character: ['broken', 'sweeping', 'dark'],
    values: {
      'algorithm': 4, 'op1-ratio': 1, 'op2-ratio': 3, 'op2-level': 0.6,
      'op4-ratio': 5, 'op4-level': 0.9,
      'index': 7, 'key-scale': 0.65, 'feedback': 0.92, 'spread': 0.8, 'balance': 0.35,
      'amp-attack': 300, 'amp-decay': 2500, 'amp-sustain': 0.7, 'amp-release': 2000,
      'mod-attack': 1500, 'mod-decay': 1800, 'mod-sustain': 0.8, 'mod-release': 1200,
    },
  },
  {
    id: 'brass-casket', name: 'Brass Casket', engineId: 'fm',
    character: ['dark', 'warm'],
    values: {
      'algorithm': 1, 'op1-ratio': 1, 'op2-ratio': 1, 'op2-level': 0.75,
      'op3-ratio': 1, 'op3-level': 0.5,
      'index': 3.5, 'key-scale': 0.7, 'feedback': 0.3, 'spread': 0.12, 'balance': 0.25,
      'amp-attack': 30, 'amp-decay': 1200, 'amp-sustain': 0.75, 'amp-release': 500,
      'mod-attack': 140, 'mod-decay': 800, 'mod-sustain': 0.55, 'mod-release': 400,
    },
  },
  {
    id: 'mallet-court', name: 'Mallet Court', engineId: 'fm',
    character: ['wooden', 'plucked'],
    values: {
      'algorithm': 0, 'op1-ratio': 1, 'op2-ratio': 4, 'op2-level': 0.55,
      'index': 3.2, 'key-scale': 0.85, 'feedback': 0.05, 'spread': 0.05, 'balance': 0.3,
      'amp-attack': 0.5, 'amp-decay': 420, 'amp-sustain': 0, 'amp-release': 380,
      'mod-attack': 0.5, 'mod-decay': 90, 'mod-sustain': 0, 'mod-release': 100,
    },
  },
  {
    id: 'thumb-piano', name: 'Thumb Piano', engineId: 'fm',
    character: ['plucked', 'wooden', 'hollow'],
    values: {
      'algorithm': 2, 'op1-ratio': 1, 'op2-ratio': 5, 'op2-level': 0.4,
      'op3-ratio': 2, 'op3-level': 0.35, 'op4-ratio': 10, 'op4-level': 0.2,
      'index': 2.6, 'key-scale': 0.8, 'feedback': 0.12, 'spread': 0.08, 'balance': 0.3,
      'amp-attack': 0.5, 'amp-decay': 700, 'amp-sustain': 0, 'amp-release': 300,
      'mod-attack': 0.5, 'mod-decay': 60, 'mod-sustain': 0, 'mod-release': 80,
    },
  },
];
