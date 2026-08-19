import type { Preset } from '@/dsp/presets';

/**
 * The FM bank. Operator ratios sit on the DX7-style grid (0.5 or whole
 * numbers): high modulator ratios with fast mod decays make bells, low ratios
 * with feedback make basses, and detuned parallel carriers make glass pads.
 * Every algorithm in the routing table earns at least one preset here.
 *
 * Voiced chord-first: the app defaults to chord play, so every sustained
 * preset here is measured as a four-note stack as well as a single note, and
 * levels are set so a four-voice chord stays under ~-1.5 dBFS (the always-on
 * FX safety saturator distorts audibly at 0 dBFS). Presets that are
 * monophonic by nature (ballast, serrated-bass) are voiced well mono and
 * simply are that.
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
    // Tubular bell: inharmonic partials from fine-detuned 3:1 and 5:1
    // modulators over prime and nominal carriers. Deep toll where
    // cloister-bell is a bright chime; decays under a chord without clipping.
    id: 'hour-bell', name: 'Hour Bell', engineId: 'fm',
    character: ['metallic', 'dark'],
    values: {
      'algorithm': 2, 'op1-ratio': 1, 'op1-level': 0.8, 'op2-ratio': 3, 'op2-fine': 0.45,
      'op2-level': 0.55, 'op3-ratio': 2, 'op3-level': 0.45, 'op4-ratio': 5, 'op4-fine': -0.4,
      'op4-level': 0.35,
      'index': 4, 'key-scale': 0.85, 'feedback': 0.06, 'spread': 0.15, 'balance': 0.35,
      'amp-attack': 0.5, 'amp-decay': 6000, 'amp-sustain': 0, 'amp-release': 4500,
      'mod-attack': 0.5, 'mod-decay': 1800, 'mod-sustain': 0.04, 'mod-release': 1500,
    },
  },
  {
    // Electric piano, twin-stack: a 1:1 pair for the harmonic body and a 14:1
    // pair for the tine ping, with a touch of feedback bark. The old voicing
    // was ping over a bare sine (body harmonics at -81 dB); this one holds a
    // warm body under the strike and stays clean as a four-note chord.
    id: 'tine-letter', name: 'Tine Letter', engineId: 'fm',
    character: ['warm', 'glassy'],
    values: {
      'algorithm': 2, 'op1-ratio': 1, 'op1-level': 0.8, 'op2-ratio': 1, 'op2-level': 0.85,
      'op3-ratio': 1, 'op3-fine': 0.04, 'op3-level': 0.65, 'op4-ratio': 14, 'op4-level': 1,
      'index': 2.8, 'key-scale': 0.8, 'feedback': 0.1, 'spread': 0.06, 'balance': 0.35,
      'amp-attack': 0.5, 'amp-decay': 3200, 'amp-sustain': 0.18, 'amp-release': 450,
      'mod-attack': 0.5, 'mod-decay': 160, 'mod-sustain': 0.12, 'mod-release': 250,
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
    // Clean punchy FM bass: 1:1:1 stack, fast mod decay for the pluck, mild
    // feedback for growl. The round counterpart to serrated-bass. Monophonic
    // by nature - it is a bass, not a chord instrument.
    id: 'ballast', name: 'Ballast', engineId: 'fm',
    character: ['dark', 'warm'],
    values: {
      'algorithm': 0, 'op1-ratio': 1, 'op1-level': 1, 'op2-ratio': 1, 'op2-level': 0.9,
      'op4-ratio': 1, 'op4-level': 0.35,
      'index': 3.2, 'key-scale': 0.95, 'feedback': 0.25, 'spread': 0.04, 'balance': 0.2,
      'amp-attack': 0.5, 'amp-decay': 700, 'amp-sustain': 0.55, 'amp-release': 120,
      'mod-attack': 0.5, 'mod-decay': 140, 'mod-sustain': 0.18, 'mod-release': 100,
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
      // Levels sized for chords: at the old levels a four-note stack peaked
      // at +2.2 dBFS and sat in the FX saturator. Same drawbar recipe.
      'algorithm': 3, 'op1-ratio': 1, 'op1-level': 0.6, 'op2-ratio': 2, 'op2-level': 0.3,
      'op3-ratio': 4, 'op3-level': 0.18, 'op4-ratio': 8, 'op4-level': 0.09, 'op2-fine': 0.02,
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
    // Marimba: 4:1 modulator (the bar's real first overtone), op4 explicitly
    // silenced - the old voicing left it at its default (ratio 3, level 0.7)
    // and that bled an unintended operator into every strike.
    id: 'mallet-court', name: 'Mallet Court', engineId: 'fm',
    character: ['wooden', 'plucked'],
    values: {
      'algorithm': 0, 'op1-ratio': 1, 'op1-level': 0.95, 'op2-ratio': 4, 'op2-fine': 0.03,
      'op2-level': 0.65, 'op4-ratio': 3, 'op4-level': 0,
      'index': 3.8, 'key-scale': 0.9, 'feedback': 0, 'spread': 0.05, 'balance': 0.3,
      'amp-attack': 0.5, 'amp-decay': 450, 'amp-sustain': 0, 'amp-release': 350,
      'mod-attack': 0.5, 'mod-decay': 70, 'mod-sustain': 0, 'mod-release': 80,
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
  {
    // Harpsichord: 3:1 quill bite on the unison string, a 2:1 carrier as the
    // 4' octave stop, feedback for the pluck's snap. Rings while held, stops
    // fast on release. Bright chords stay clean.
    id: 'crow-quill', name: 'Crow Quill', engineId: 'fm',
    character: ['plucked', 'metallic'],
    values: {
      'algorithm': 2, 'op1-ratio': 1, 'op1-level': 0.85, 'op2-ratio': 3, 'op2-level': 0.6,
      'op3-ratio': 2, 'op3-level': 0.45, 'op4-ratio': 6, 'op4-level': 0.25,
      'index': 3.6, 'key-scale': 0.8, 'feedback': 0.2, 'spread': 0.05, 'balance': 0.35,
      'amp-attack': 0.5, 'amp-decay': 1400, 'amp-sustain': 0.12, 'amp-release': 200,
      'mod-attack': 0.5, 'mod-decay': 500, 'mod-sustain': 0.15, 'mod-release': 200,
    },
  },
];
