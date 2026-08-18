import type { Preset } from './presets';

/**
 * The wavetable bank. The table row runs pure -> complex, so `table-position`
 * is the single most character-defining parameter here: low positions are
 * near-sine, the middle is reedy and formant-like, the top is metallic and
 * inharmonic. Every preset below picks its position first and shapes the
 * envelope around it.
 */
export const WAVETABLE_PRESETS: readonly Preset[] = [
  {
    id: 'wt-pale-sun', name: 'Pale Sun', engineId: 'wavetable',
    character: ['warm', 'sweeping'],
    values: {
      'table-position': 0.18, 'position-env': 0.45, 'osc-detune': 0.09,
      'filter-cutoff': 3200, 'filter-env': 0.35, 'drive': 0.08,
      'amp-attack': 420, 'amp-decay': 1400, 'amp-sustain': 0.75, 'amp-release': 900,
    },
  },
  {
    id: 'wt-glass-organ', name: 'Glass Organ', engineId: 'wavetable',
    character: ['glassy', 'hollow'],
    values: {
      'table-position': 0.62, 'position-env': 0.05, 'osc-detune': 0.03,
      'filter-cutoff': 9000, 'filter-resonance': 0.08, 'filter-env': 0.1, 'drive': 0.04,
      'amp-attack': 8, 'amp-decay': 300, 'amp-sustain': 0.9, 'amp-release': 260,
    },
  },
  {
    id: 'wt-iron-lung', name: 'Iron Lung', engineId: 'wavetable',
    character: ['aggressive', 'broken'],
    values: {
      'table-position': 0.88, 'position-env': 0.6, 'osc-detune': 0.22,
      'filter-cutoff': 2400, 'filter-resonance': 0.55, 'filter-env': 0.7, 'drive': 0.72,
      'amp-attack': 1, 'amp-decay': 260, 'amp-sustain': 0.45, 'amp-release': 180,
    },
  },
  {
    id: 'wt-tidewater', name: 'Tidewater', engineId: 'wavetable',
    character: ['huge', 'sweeping'],
    values: {
      'table-position': 0.3, 'position-env': 0.85, 'osc-detune': 0.16,
      'filter-cutoff': 2000, 'filter-env': 0.5, 'drive': 0.12,
      'amp-attack': 1200, 'amp-decay': 3000, 'amp-sustain': 0.8, 'amp-release': 2400,
    },
  },
  {
    id: 'wt-copper-bell', name: 'Copper Bell', engineId: 'wavetable',
    character: ['glassy', 'plucked'],
    values: {
      'table-position': 0.95, 'position-env': 0.2, 'osc-detune': 0.02,
      'filter-cutoff': 12000, 'filter-env': 0.25, 'drive': 0.1,
      'amp-attack': 0.5, 'amp-decay': 1600, 'amp-sustain': 0, 'amp-release': 1200,
      'amp-velocity': 0.85,
    },
  },
  {
    id: 'wt-sub-shelf', name: 'Sub Shelf', engineId: 'wavetable',
    character: ['dark', 'huge'],
    values: {
      'table-position': 0.05, 'position-env': 0.1, 'osc-detune': 0.01, 'osc-mix': 0.35,
      'filter-cutoff': 900, 'filter-env': 0.4, 'drive': 0.25, 'filter-keytrack': 0.15,
      'amp-attack': 2, 'amp-decay': 420, 'amp-sustain': 0.6, 'amp-release': 200,
    },
  },
  {
    id: 'wt-reed-choir', name: 'Reed Choir', engineId: 'wavetable',
    character: ['hollow', 'warm'],
    values: {
      'table-position': 0.48, 'position-env': 0.3, 'osc-detune': 0.13,
      'filter-cutoff': 4200, 'filter-resonance': 0.18, 'filter-env': 0.2, 'drive': 0.14,
      'amp-attack': 260, 'amp-decay': 900, 'amp-sustain': 0.85, 'amp-release': 700,
    },
  },
  {
    id: 'wt-splintered', name: 'Splintered', engineId: 'wavetable',
    character: ['broken', 'aggressive'],
    values: {
      'table-position': 0.75, 'position-env': 0.95, 'osc-detune': 0.4,
      'filter-cutoff': 6000, 'filter-resonance': 0.62, 'filter-env': 0.55, 'drive': 0.5,
      'amp-attack': 1, 'amp-decay': 140, 'amp-sustain': 0.2, 'amp-release': 120,
    },
  },
  {
    id: 'wt-cold-wire', name: 'Cold Wire', engineId: 'wavetable',
    character: ['glassy', 'dark'],
    values: {
      'table-position': 0.82, 'position-env': 0.15, 'osc-detune': 0.05,
      'filter-cutoff': 7000, 'filter-resonance': 0.3, 'filter-env': 0.15, 'drive': 0.06,
      'amp-attack': 4, 'amp-decay': 700, 'amp-sustain': 0.35, 'amp-release': 500,
    },
  },
  {
    id: 'wt-slow-tide', name: 'Slow Tide', engineId: 'wavetable',
    character: ['sweeping', 'hollow'],
    values: {
      'table-position': 0.22, 'position-env': 0.7, 'osc-detune': 0.2,
      'filter-cutoff': 1600, 'filter-resonance': 0.22, 'filter-env': 0.6, 'drive': 0.1,
      'amp-attack': 900, 'amp-decay': 2200, 'amp-sustain': 0.7, 'amp-release': 1800,
    },
  },
  {
    id: 'wt-tin-pluck', name: 'Tin Pluck', engineId: 'wavetable',
    character: ['plucked', 'wooden'],
    values: {
      'table-position': 0.55, 'position-env': 0.4, 'osc-detune': 0.06,
      'filter-cutoff': 5200, 'filter-resonance': 0.35, 'filter-env': 0.8, 'drive': 0.18,
      'amp-attack': 0.5, 'amp-decay': 220, 'amp-sustain': 0, 'amp-release': 160,
      'amp-velocity': 0.9,
    },
  },
  {
    id: 'wt-furnace', name: 'Furnace', engineId: 'wavetable',
    character: ['aggressive', 'huge', 'dark'],
    values: {
      'table-position': 0.68, 'position-env': 0.5, 'osc-detune': 0.28, 'osc-mix': 0.6,
      'filter-cutoff': 1800, 'filter-resonance': 0.45, 'filter-env': 0.65, 'drive': 0.85,
      'amp-attack': 3, 'amp-decay': 600, 'amp-sustain': 0.7, 'amp-release': 400,
    },
  },
];
