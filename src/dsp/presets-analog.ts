import type { Preset } from '@/dsp/presets';

/**
 * The analog bank: subtractive staples, from glass plucks to broken drones,
 * plus the three workhorses every track reaches for — a unison wall, a sine
 * sub and a diode-filter acid line. Presets that only restated a neighbour at
 * a different decay were cut; each survivor owns its own territory.
 */
export const ANALOG_PRESETS: readonly Preset[] = [
  {
    id: 'frost-lattice', name: 'Frost Lattice', engineId: 'analog',
    character: ['glassy', 'plucked'],
    values: {
      'osc-detune': 0.03, 'osc-drift': 0.1, 'filter-cutoff': 9000, 'filter-resonance': 0.35,
      'filter-env': 0.45, 'amp-attack': 0.5, 'amp-decay': 260, 'amp-sustain': 0,
      'amp-release': 380, 'drive': 0.05,
    },
  },
  {
    id: 'paper-lantern', name: 'Paper Lantern', engineId: 'analog',
    character: ['glassy', 'hollow', 'warm'],
    values: {
      'osc-detune': 0.05, 'osc-drift': 0.22, 'filter-cutoff': 5200, 'filter-resonance': 0.5,
      'filter-env': 0.35, 'amp-attack': 90, 'amp-decay': 800, 'amp-sustain': 0.55,
      'amp-release': 1200, 'drive': 0.06,
    },
  },
  {
    id: 'cathedral-drift', name: 'Cathedral Drift', engineId: 'analog',
    character: ['huge', 'sweeping', 'warm'],
    values: {
      'osc-detune': 0.28, 'osc-drift': 0.6, 'filter-cutoff': 2200, 'filter-resonance': 0.2,
      'filter-env': 0.35, 'amp-attack': 1400, 'amp-decay': 2600, 'amp-sustain': 0.85,
      'amp-release': 4200, 'drive': 0.15,
    },
  },
  {
    id: 'aurora-wall', name: 'Aurora Wall', engineId: 'analog',
    character: ['sweeping', 'glassy'],
    values: {
      'unison-voices': 4, 'unison-detune': 0.6, 'osc-detune': 0.1, 'osc-drift': 0.2,
      'filter-cutoff': 6500, 'filter-resonance': 0.12, 'filter-env': 0.25,
      'sub-level': 0.25, 'drive': 0.25, 'amp-attack': 6, 'amp-decay': 800,
      'amp-sustain': 0.8, 'amp-release': 350, 'lfo-cutoff': 0.15, 'lfo-rate': 0.4,
    },
  },
  {
    id: 'continental-shelf', name: 'Continental Shelf', engineId: 'analog',
    character: ['huge', 'dark', 'warm'],
    values: {
      'osc-detune': 0.35, 'osc-drift': 0.65, 'filter-cutoff': 520, 'filter-resonance': 0.18,
      'filter-env': 0.4, 'amp-attack': 1800, 'amp-decay': 5000, 'amp-sustain': 0.8,
      'amp-release': 6000, 'drive': 0.4,
    },
  },
  {
    id: 'black-tide', name: 'Black Tide', engineId: 'analog',
    character: ['dark', 'huge'],
    values: {
      'osc-detune': 0.22, 'osc-drift': 0.5, 'filter-cutoff': 420, 'filter-resonance': 0.1,
      'filter-env': 0.25, 'amp-attack': 900, 'amp-decay': 3000, 'amp-sustain': 0.7,
      'amp-release': 3600, 'drive': 0.3,
    },
  },
  {
    id: 'bedrock', name: 'Bedrock', engineId: 'analog',
    character: ['dark', 'warm'],
    values: {
      'osc1-wave': 3, 'osc2-wave': 3, 'osc-detune': 0.01, 'osc-drift': 0.05,
      'sub-mode': 2, 'sub-level': 0.85, 'filter-cutoff': 900, 'filter-resonance': 0.05,
      'filter-env': 0.2, 'filter-keytrack': 0, 'drive': 0.35, 'amp-attack': 1,
      'amp-decay': 500, 'amp-sustain': 0.85, 'amp-release': 120,
    },
  },
  {
    id: 'hearth', name: 'Hearth', engineId: 'analog',
    character: ['warm', 'dark'],
    values: {
      'osc-detune': 0.09, 'osc-drift': 0.3, 'filter-cutoff': 900, 'filter-resonance': 0.12,
      'filter-env': 0.3, 'amp-attack': 20, 'amp-decay': 900, 'amp-sustain': 0.65,
      'amp-release': 900, 'drive': 0.35,
    },
  },
  {
    id: 'hollow-bones', name: 'Hollow Bones', engineId: 'analog',
    character: ['hollow', 'wooden', 'plucked'],
    values: {
      'osc-detune': 0.02, 'osc-drift': 0.12, 'filter-cutoff': 1400, 'filter-resonance': 0.6,
      'filter-env': 0.7, 'amp-attack': 0.8, 'amp-decay': 320, 'amp-sustain': 0,
      'amp-release': 260, 'drive': 0.1,
    },
  },
  {
    id: 'chapel-of-ash', name: 'Chapel of Ash', engineId: 'analog',
    character: ['hollow', 'dark', 'sweeping'],
    values: {
      'osc-detune': 0.2, 'osc-drift': 0.55, 'filter-cutoff': 600, 'filter-resonance': 0.68,
      'filter-env': 0.55, 'amp-attack': 700, 'amp-decay': 2400, 'amp-sustain': 0.5,
      'amp-release': 3000, 'drive': 0.18,
    },
  },
  {
    id: 'matchstick', name: 'Matchstick', engineId: 'analog',
    character: ['plucked', 'wooden'],
    values: {
      'osc-detune': 0.04, 'osc-drift': 0.2, 'filter-cutoff': 2600, 'filter-resonance': 0.3,
      'filter-env': 0.75, 'amp-attack': 0.5, 'amp-decay': 90, 'amp-sustain': 0,
      'amp-release': 90, 'drive': 0.25,
    },
  },
  {
    id: 'oak-hammer', name: 'Oak Hammer', engineId: 'analog',
    character: ['wooden', 'plucked', 'aggressive'],
    values: {
      'osc-detune': 0.05, 'osc-drift': 0.15, 'filter-cutoff': 1600, 'filter-resonance': 0.45,
      'filter-env': 0.8, 'amp-attack': 0.5, 'amp-decay': 200, 'amp-sustain': 0,
      'amp-release': 140, 'drive': 0.55,
    },
  },
  {
    id: 'battery-acid', name: 'Battery Acid', engineId: 'analog',
    character: ['aggressive'],
    values: {
      'filter-model': 2, 'filter-cutoff': 2400, 'filter-resonance': 0.6,
      'filter-env': 0.9, 'filter-velocity': 0.7, 'filter-keytrack': 0.5,
      'drive': 0.5, 'sub-level': 0.5, 'osc-detune': 0.02, 'osc-drift': 0.1,
      'glide': 70, 'amp-attack': 1, 'amp-decay': 260, 'amp-sustain': 0.45,
      'amp-release': 90,
    },
  },
  {
    id: 'switchblade', name: 'Switchblade', engineId: 'analog',
    character: ['aggressive', 'plucked'],
    values: {
      'osc-detune': 0.07, 'osc-drift': 0.2, 'filter-cutoff': 4200, 'filter-resonance': 0.62,
      'filter-env': 0.88, 'amp-attack': 0.5, 'amp-decay': 120, 'amp-sustain': 0.1,
      'amp-release': 100, 'drive': 0.5, 'sub-level': 0.5,
    },
  },
  {
    id: 'broken-transmitter', name: 'Broken Transmitter', engineId: 'analog',
    character: ['broken', 'aggressive'],
    values: {
      'osc-detune': 0.47, 'osc-drift': 0.95, 'filter-cutoff': 700, 'filter-resonance': 0.85,
      'filter-env': 0.9, 'amp-attack': 3, 'amp-decay': 500, 'amp-sustain': 0.35,
      'amp-release': 700, 'drive': 0.8,
    },
  },
  {
    id: 'tape-ghost', name: 'Tape Ghost', engineId: 'analog',
    character: ['broken', 'dark', 'sweeping'],
    values: {
      'osc-detune': 0.4, 'osc-drift': 0.88, 'filter-cutoff': 800, 'filter-resonance': 0.4,
      'filter-env': 0.5, 'amp-attack': 300, 'amp-decay': 1500, 'amp-sustain': 0.4,
      'amp-release': 1800, 'drive': 0.45,
    },
  },
];
