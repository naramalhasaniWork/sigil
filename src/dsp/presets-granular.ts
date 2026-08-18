import type { Preset } from '@/dsp/presets';

/**
 * The granular bank. Density and grain size are pushed to extremes on
 * purpose: sub-10 Hz densities read as rhythm, 200 Hz fuses into cloud, and
 * reverse plus spray decides whether the texture moves forward or hangs still.
 * This engine should sound like weather and tape, not like a synth.
 */
export const GRANULAR_PRESETS: readonly Preset[] = [
  {
    id: 'dust-archive', name: 'Dust Archive', engineId: 'granular',
    character: ['broken', 'dark'],
    values: {
      'grain-density': 9, 'grain-size': 24, 'position': 0.06, 'spray': 0.45,
      'pitch-scatter': 0.8, 'reverse': 0.35, 'window-shape': 0.7,
      'amp-attack': 40, 'amp-decay': 1200, 'amp-sustain': 0.7, 'amp-release': 1600,
    },
  },
  {
    id: 'murmuration', name: 'Murmuration', engineId: 'granular',
    character: ['huge', 'sweeping'],
    values: {
      'grain-density': 60, 'grain-size': 120, 'position': 0.5, 'spray': 0.3,
      'pitch-scatter': 0.15, 'reverse': 0.2, 'window-shape': 1,
      'amp-attack': 2400, 'amp-decay': 3000, 'amp-sustain': 0.9, 'amp-release': 4500,
    },
  },
  {
    id: 'static-garden', name: 'Static Garden', engineId: 'granular',
    character: ['broken', 'glassy'],
    values: {
      'grain-density': 160, 'grain-size': 7, 'position': 0.85, 'spray': 0.2,
      'pitch-scatter': 6.5, 'reverse': 0.1, 'window-shape': 0.5,
      'amp-attack': 15, 'amp-decay': 800, 'amp-sustain': 0.8, 'amp-release': 700,
    },
  },
  {
    id: 'vapor-column', name: 'Vapor Column', engineId: 'granular',
    character: ['huge', 'warm', 'sweeping'],
    values: {
      'grain-density': 90, 'grain-size': 140, 'position': 0.25, 'spray': 0.18,
      'pitch-scatter': 0.1, 'reverse': 0.1, 'window-shape': 1,
      'amp-attack': 3200, 'amp-decay': 4000, 'amp-sustain': 0.95, 'amp-release': 6000,
    },
  },
  {
    id: 'sleet', name: 'Sleet', engineId: 'granular',
    character: ['glassy', 'broken'],
    values: {
      'grain-density': 26, 'grain-size': 12, 'position': 0.9, 'spray': 0.55,
      'pitch-scatter': 9, 'reverse': 0.15, 'window-shape': 0.35,
      'amp-attack': 5, 'amp-decay': 500, 'amp-sustain': 0.4, 'amp-release': 900,
    },
  },
  {
    id: 'frozen-letter', name: 'Frozen Letter', engineId: 'granular',
    character: ['glassy', 'hollow', 'sweeping'],
    values: {
      'grain-density': 60, 'grain-size': 260, 'position': 0.65, 'spray': 0.03,
      'pitch-scatter': 0.05, 'reverse': 0.65, 'window-shape': 1,
      'amp-attack': 900, 'amp-decay': 2500, 'amp-sustain': 0.85, 'amp-release': 3800,
    },
  },
  {
    id: 'tide-pool', name: 'Tide Pool', engineId: 'granular',
    character: ['warm', 'dark'],
    values: {
      'grain-density': 12, 'grain-size': 380, 'position': 0.08, 'spray': 0.3,
      'pitch-scatter': 0.4, 'reverse': 0.25, 'window-shape': 0.9,
      'amp-attack': 600, 'amp-decay': 2000, 'amp-sustain': 0.8, 'amp-release': 2400,
    },
  },
  {
    id: 'rust-chorus', name: 'Rust Chorus', engineId: 'granular',
    character: ['broken', 'warm'],
    values: {
      'grain-density': 70, 'grain-size': 110, 'position': 0.35, 'spray': 0.32,
      'pitch-scatter': 0.45, 'reverse': 0.2, 'window-shape': 0.8,
      'amp-attack': 200, 'amp-decay': 1500, 'amp-sustain': 0.75, 'amp-release': 1500,
    },
  },
  {
    id: 'insect-cathedral', name: 'Insect Cathedral', engineId: 'granular',
    character: ['aggressive', 'broken'],
    values: {
      'grain-density': 200, 'grain-size': 5, 'position': 0.7, 'spray': 0.4,
      'pitch-scatter': 12, 'reverse': 0.3, 'window-shape': 0.15,
      'amp-attack': 2, 'amp-decay': 600, 'amp-sustain': 0.85, 'amp-release': 400,
    },
  },
  {
    id: 'cinder-field', name: 'Cinder Field', engineId: 'granular',
    character: ['dark', 'broken', 'hollow'],
    values: {
      'grain-density': 3, 'grain-size': 340, 'position': 0.04, 'spray': 0.5,
      'pitch-scatter': 0.3, 'reverse': 0.55, 'window-shape': 0.85,
      'amp-attack': 300, 'amp-decay': 2000, 'amp-sustain': 0.8, 'amp-release': 3000,
    },
  },
  {
    id: 'loom', name: 'Loom', engineId: 'granular',
    character: ['wooden', 'hollow'],
    values: {
      'grain-density': 6, 'grain-size': 45, 'position': 0.4, 'spray': 0.08,
      'pitch-scatter': 0, 'reverse': 0, 'window-shape': 0.1,
      'amp-attack': 10, 'amp-decay': 1000, 'amp-sustain': 0.9, 'amp-release': 600,
    },
  },
  {
    id: 'rain-on-wires', name: 'Rain on Wires', engineId: 'granular',
    character: ['glassy', 'sweeping'],
    values: {
      'grain-density': 18, 'grain-size': 40, 'position': 0.75, 'spray': 0.6,
      'pitch-scatter': 3.5, 'reverse': 0.1, 'window-shape': 0.6,
      'amp-attack': 60, 'amp-decay': 1800, 'amp-sustain': 0.7, 'amp-release': 2000,
    },
  },
];
