import type { Preset } from './presets';

/**
 * Percussion, modelled rather than sampled. `material` morphs the resonator
 * across four real objects — drum head near 0, wood around a third, struck
 * metal around two thirds, glass at 1 — so a kit is a walk along one axis with
 * the decay and strike shaped to match. Every one of these is a bounce
 * candidate for a KO II pad.
 *
 * Exciter: 0 mallet, 1 noise burst, 2 bow.
 */
export const PERCUSSION_PRESETS: readonly Preset[] = [
  {
    id: 'pc-floor-kick', name: 'Floor Kick', engineId: 'physical',
    character: ['dark', 'huge', 'wooden'],
    values: {
      material: 0.02, structure: 0.1, decay: 260, damping: 0.62, position: 0.12,
      air: 0.15, 'exciter-type': 0, grit: 0.18, hardness: 22,
      'exciter-tone': 900, release: 90, level: 0.85,
    },
  },
  {
    id: 'pc-taiko', name: 'Taiko Wall', engineId: 'physical',
    character: ['huge', 'wooden'],
    values: {
      material: 0.06, structure: 0.22, decay: 700, damping: 0.4, position: 0.3,
      air: 0.35, 'exciter-type': 0, grit: 0.3, hardness: 12,
      'exciter-tone': 1800, release: 220, level: 0.82,
    },
  },
  {
    id: 'pc-snare-sheet', name: 'Snare Sheet', engineId: 'physical',
    character: ['broken', 'aggressive'],
    values: {
      material: 0.12, structure: 0.55, decay: 180, damping: 0.5, position: 0.44,
      air: 0.6, 'exciter-type': 1, grit: 0.72, hardness: 30,
      'exciter-tone': 6500, release: 70, level: 0.78,
    },
  },
  {
    id: 'pc-rim-tick', name: 'Rim Tick', engineId: 'physical',
    character: ['wooden', 'plucked'],
    values: {
      material: 0.28, structure: 0.7, decay: 70, damping: 0.72, position: 0.9,
      air: 0.3, 'exciter-type': 0, grit: 0.4, hardness: 58,
      'exciter-tone': 9000, release: 25, level: 0.7,
    },
  },
  {
    id: 'pc-bamboo-knock', name: 'Bamboo Knock', engineId: 'physical',
    character: ['wooden', 'hollow'],
    values: {
      material: 0.34, structure: 0.3, decay: 130, damping: 0.55, position: 0.22,
      air: 0.25, 'exciter-type': 0, grit: 0.2, hardness: 34,
      'exciter-tone': 5200, release: 45, level: 0.75,
    },
  },
  {
    id: 'pc-log-drum', name: 'Log Drum', engineId: 'physical',
    character: ['wooden', 'warm'],
    values: {
      material: 0.4, structure: 0.18, decay: 420, damping: 0.34, position: 0.28,
      air: 0.3, 'exciter-type': 0, grit: 0.16, hardness: 9,
      'exciter-tone': 3000, release: 160, level: 0.8,
    },
  },
  {
    id: 'pc-hat-foil', name: 'Hat Foil', engineId: 'physical',
    character: ['metallic', 'glassy'],
    values: {
      material: 0.74, structure: 0.85, decay: 55, damping: 0.8, position: 0.94,
      air: 0.7, 'exciter-type': 1, grit: 0.55, hardness: 70,
      'exciter-tone': 13000, release: 20, level: 0.62,
    },
  },
  {
    id: 'pc-anvil', name: 'Anvil Strike', engineId: 'physical',
    character: ['metallic', 'aggressive'],
    values: {
      material: 0.7, structure: 0.42, decay: 900, damping: 0.2, position: 0.36,
      air: 0.45, 'exciter-type': 0, grit: 0.5, hardness: 66,
      'exciter-tone': 8000, release: 340, level: 0.76,
    },
  },
  {
    id: 'pc-brake-drum', name: 'Brake Drum', engineId: 'physical',
    character: ['metallic', 'broken'],
    values: {
      material: 0.66, structure: 0.62, decay: 520, damping: 0.44, position: 0.66,
      air: 0.5, 'exciter-type': 0, grit: 0.85, hardness: 44,
      'exciter-tone': 5600, release: 200, level: 0.74,
    },
  },
  {
    id: 'pc-steel-tongue', name: 'Steel Tongue', engineId: 'physical',
    character: ['metallic', 'warm'],
    values: {
      material: 0.6, structure: 0.12, decay: 1400, damping: 0.18, position: 0.2,
      air: 0.4, 'exciter-type': 0, grit: 0.1, hardness: 7,
      'exciter-tone': 3600, release: 520, level: 0.8,
    },
  },
  {
    id: 'pc-clay-shaker', name: 'Clay Shaker', engineId: 'physical',
    character: ['wooden', 'broken'],
    values: {
      material: 0.2, structure: 0.9, decay: 90, damping: 0.68, position: 0.78,
      air: 0.55, 'exciter-type': 1, grit: 0.9, hardness: 26,
      'exciter-tone': 10000, release: 35, level: 0.6,
    },
  },
  {
    id: 'pc-glass-bell', name: 'Glass Bell', engineId: 'physical',
    character: ['glassy', 'metallic'],
    values: {
      material: 0.96, structure: 0.35, decay: 2200, damping: 0.12, position: 0.3,
      air: 0.62, 'exciter-type': 0, grit: 0.06, hardness: 40,
      'exciter-tone': 12000, release: 800, level: 0.72,
    },
  },
];
