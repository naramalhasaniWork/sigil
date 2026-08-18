import type { Preset } from '@/dsp/presets';

/**
 * The physical bank. Material morphs the resonator through drum head, wood
 * bar, struck metal and glass, so each preset commits to one object and one
 * way of touching it — mallet, scrape or bow — rather than one bell twelve ways.
 */
export const PHYSICAL_PRESETS: readonly Preset[] = [
  {
    id: 'gamelan-court', name: 'Gamelan Court', engineId: 'physical',
    character: ['metallic', 'glassy'],
    values: {
      'material': 0.68, 'structure': 0.62, 'decay': 2500, 'damping': 0.1,
      'position': 0.16, 'air': 0.7, 'exciter-type': 0, 'grit': 0.12,
      'hardness': 0.6, 'exciter-tone': 9500, 'level': 0.7,
    },
  },
  {
    id: 'rosewood-steps', name: 'Rosewood Steps', engineId: 'physical',
    character: ['wooden', 'plucked', 'warm'],
    values: {
      'material': 0.34, 'structure': 0.08, 'decay': 380, 'damping': 0.55,
      'position': 0.3, 'air': 0.4, 'exciter-type': 0, 'grit': 0.2,
      'hardness': 7, 'exciter-tone': 2800,
    },
  },
  {
    id: 'clay-circle', name: 'Clay Circle', engineId: 'physical',
    character: ['hollow', 'wooden', 'warm'],
    values: {
      'material': 0.04, 'structure': 0.05, 'decay': 650, 'damping': 0.45,
      'position': 0.5, 'air': 0.35, 'exciter-type': 0, 'grit': 0.3,
      'hardness': 12, 'exciter-tone': 900,
    },
  },
  {
    id: 'tin-rain', name: 'Tin Rain', engineId: 'physical',
    character: ['metallic', 'broken'],
    values: {
      'material': 0.72, 'structure': 0.85, 'decay': 500, 'damping': 0.25,
      'position': 0.05, 'air': 0.85, 'exciter-type': 1, 'grit': 0.85,
      'hardness': 2, 'exciter-tone': 12000,
    },
  },
  {
    id: 'horsehair-winter', name: 'Horsehair Winter', engineId: 'physical',
    character: ['bowed', 'dark', 'sweeping'],
    values: {
      'material': 0.4, 'structure': 0.15, 'decay': 1800, 'damping': 0.5,
      'position': 0.35, 'air': 0.45, 'exciter-type': 2, 'grit': 0.6,
      'hardness': 30, 'exciter-tone': 1800, 'release': 700,
    },
  },
  {
    id: 'glass-orchard', name: 'Glass Orchard', engineId: 'physical',
    character: ['glassy'],
    values: {
      'material': 0.98, 'structure': 0.3, 'decay': 2900, 'damping': 0.04,
      'position': 0.12, 'air': 0.9, 'exciter-type': 0, 'grit': 0.05,
      'hardness': 0.3, 'exciter-tone': 14000,
    },
  },
  {
    id: 'muffled-parade', name: 'Muffled Parade', engineId: 'physical',
    character: ['dark', 'hollow'],
    values: {
      'material': 0.08, 'structure': 0.04, 'decay': 260, 'damping': 0.9,
      'position': 0.45, 'air': 0.2, 'exciter-type': 0, 'grit': 0.35,
      'hardness': 20, 'exciter-tone': 600,
    },
  },
  {
    id: 'bronze-meridian', name: 'Bronze Meridian', engineId: 'physical',
    character: ['huge', 'metallic', 'dark'],
    values: {
      'material': 0.78, 'structure': 0.75, 'decay': 3000, 'damping': 0.08,
      'position': 0.5, 'air': 0.8, 'exciter-type': 0, 'grit': 0.2,
      'hardness': 45, 'exciter-tone': 1000, 'level': 0.8,
    },
  },
  {
    id: 'splinter', name: 'Splinter', engineId: 'physical',
    character: ['aggressive', 'wooden'],
    values: {
      'material': 0.3, 'structure': 0.2, 'decay': 90, 'damping': 0.6,
      'position': 0.04, 'air': 0.5, 'exciter-type': 1, 'grit': 0.95,
      'hardness': 0.2, 'exciter-tone': 15000,
    },
  },
  {
    id: 'bowed-antenna', name: 'Bowed Antenna', engineId: 'physical',
    character: ['bowed', 'metallic', 'sweeping'],
    values: {
      'material': 0.8, 'structure': 0.7, 'decay': 2200, 'damping': 0.2,
      'position': 0.08, 'air': 0.75, 'exciter-type': 2, 'grit': 0.75,
      'hardness': 15, 'exciter-tone': 6000, 'release': 1200,
    },
  },
  {
    id: 'paper-drum', name: 'Paper Drum', engineId: 'physical',
    character: ['hollow', 'warm', 'wooden'],
    values: {
      'material': 0.12, 'structure': 0.03, 'decay': 420, 'damping': 0.65,
      'position': 0.6, 'air': 0.3, 'exciter-type': 0, 'grit': 0.45,
      'hardness': 18, 'exciter-tone': 1400,
    },
  },
  {
    id: 'winter-chapel', name: 'Winter Chapel', engineId: 'physical',
    character: ['glassy', 'hollow', 'bowed'],
    values: {
      'material': 0.95, 'structure': 0.25, 'decay': 2600, 'damping': 0.12,
      'position': 0.2, 'air': 0.85, 'exciter-type': 2, 'grit': 0.3,
      'hardness': 40, 'exciter-tone': 8000, 'release': 900,
    },
  },
];
