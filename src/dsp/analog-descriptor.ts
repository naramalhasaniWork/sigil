import type { EngineDescriptor } from '@/audio/types';

export const ANALOG_DESCRIPTOR: EngineDescriptor = {
  id: 'analog',
  name: 'Analog',
  colour: '#FF6B6B',
  macroNames: ['Body', 'Air', 'Grit', 'Motion'],
  params: [
    {
      id: 'osc-detune', name: 'Detune', group: 'Oscillators', unit: 'semitones',
      min: 0, max: 0.5, default: 0.06, curve: 'linear', macro: 0, macroDepth: 0.4,
      mutability: 0.8,
      explain: 'Pushes the two oscillators slightly out of tune with each other. Small amounts make the sound thicker and alive; large amounts sound broken and seasick.',
    },
    {
      id: 'osc-drift', name: 'Drift', group: 'Oscillators', unit: 'pct',
      min: 0, max: 1, default: 0.25, curve: 'linear', macro: 3, macroDepth: 0.5,
      mutability: 0.9,
      explain: 'Slow random wandering of oscillator pitch, imitating analog circuits that never hold perfectly still. This is the cheapest way to stop a digital synth sounding sterile.',
    },
    {
      id: 'filter-cutoff', name: 'Cutoff', group: 'Filter', unit: 'hz',
      min: 20, max: 18000, default: 1800, curve: 'exp', macro: 1, macroDepth: 0.8,
      mutability: 0.9,
      explain: 'The brightness control. Everything above this frequency is progressively removed, so lowering it makes the sound darker and more distant.',
    },
    {
      id: 'filter-resonance', name: 'Resonance', group: 'Filter', unit: 'pct',
      min: 0, max: 1, default: 0.15, curve: 'linear', macro: 2, macroDepth: 0.5,
      mutability: 0.7,
      explain: 'Emphasises frequencies right at the cutoff point. Raise it for a vocal, squelchy character; near maximum the filter starts to whistle on its own.',
    },
    {
      id: 'filter-env', name: 'Env Amount', group: 'Filter', unit: 'pct',
      min: 0, max: 1, default: 0.5, curve: 'linear', mutability: 0.8,
      explain: 'How far the envelope sweeps the cutoff when a note starts. This is what makes a note go "wow" or "pluck" rather than simply appearing.',
    },
    {
      id: 'amp-attack', name: 'Attack', group: 'Envelope', unit: 'ms',
      min: 0.5, max: 4000, default: 4, curve: 'exp', mutability: 0.6,
      explain: 'How long the note takes to reach full volume. Short is percussive, long turns any sound into a pad that swells in.',
    },
    {
      id: 'amp-decay', name: 'Decay', group: 'Envelope', unit: 'ms',
      min: 1, max: 8000, default: 400, curve: 'exp', mutability: 0.6,
      explain: 'How quickly the note falls from its peak to the sustain level after the attack finishes.',
    },
    {
      id: 'amp-sustain', name: 'Sustain', group: 'Envelope', unit: 'pct',
      min: 0, max: 1, default: 0.7, curve: 'linear', mutability: 0.5,
      explain: 'The level the note holds at while you keep the key down. Set it to zero and every note becomes a pluck regardless of how long you hold it.',
    },
    {
      id: 'amp-release', name: 'Release', group: 'Envelope', unit: 'ms',
      min: 1, max: 8000, default: 300, curve: 'exp', mutability: 0.6,
      explain: 'How long the sound takes to fade once you let go. Long releases let chords overlap and blur into each other.',
    },
    {
      id: 'drive', name: 'Drive', group: 'Character', unit: 'pct',
      min: 0, max: 1, default: 0.2, curve: 'linear', mutability: 0.9,
      explain: 'Overdrives the signal going into the filter, adding harmonics and grit. A little adds weight; a lot turns the sound aggressive and compressed.',
    },
  ],
};
