import type { EngineDescriptor } from '@/audio/types';

/**
 * The Wavetable engine's control surface.
 *
 * Parameter INDEX is a wire format: the worklet, presets and the UI all address
 * parameters by position, so existing entries never move. New controls are
 * appended.
 *
 * The engine's identity is one knob: Position, a continuous scan across eight
 * waveforms from a pure sine to a metallic clang. Everything else exists to
 * frame that scan — Body thickens it, Grit pushes it, Motion makes it travel
 * over the life of a note.
 */
export const WAVETABLE_DESCRIPTOR: EngineDescriptor = {
  id: 'wavetable',
  name: 'Wavetable',
  colour: '#FF9F45',
  macroNames: ['Body', 'Air', 'Grit', 'Motion'],
  params: [
    {
      id: 'table-position', name: 'Position', group: 'Wavetable', unit: 'pct',
      min: 0, max: 1, default: 0.35, curve: 'linear', macro: 1, macroDepth: 0.8,
      mutability: 0.95,
      explain: 'Where you are in the row of eight waveforms, morphing smoothly from a pure sine through soft, hollow and buzzy shapes to vowels and finally a metallic clang. This one knob is most of the engine — sweep it and the whole character of the sound travels with it.',
    },
    {
      id: 'position-env', name: 'Position Env', group: 'Wavetable', unit: 'pct',
      min: 0, max: 1, default: 0.2, curve: 'linear', macro: 3, macroDepth: 0.75,
      mutability: 0.9,
      explain: 'How far the envelope pushes the wavetable position while a note plays, so the timbre itself moves — bright and complex at the start, settling as it decays. This is what separates a living wavetable patch from a frozen snapshot of one.',
    },
    {
      id: 'osc-detune', name: 'Detune', group: 'Oscillators', unit: 'semitones',
      min: 0, max: 1, default: 0.07, curve: 'linear', macro: 0, macroDepth: 0.8,
      mutability: 0.85,
      explain: 'Pushes the second oscillator slightly sharp of the first. Small amounts make the two copies beat against each other and the sound turns thick and wide; large amounts drift audibly out of tune.',
    },
    {
      id: 'osc-mix', name: 'Osc Mix', group: 'Oscillators', unit: 'pct',
      min: 0, max: 1, default: 0.5, curve: 'linear', mutability: 0.7,
      explain: 'Balance between the two table oscillators: fully left is only the first, fully right only the detuned second. In the middle both play and the detune between them does its thickening work.',
    },
    {
      id: 'filter-cutoff', name: 'Cutoff', group: 'Filter', unit: 'hz',
      min: 20, max: 18000, default: 4500, curve: 'exp', mutability: 0.9,
      explain: 'The brightness control. Everything above this frequency is progressively removed, so lowering it makes the sound darker and more distant — useful for taming the harsher end of the wavetable row.',
    },
    {
      id: 'filter-resonance', name: 'Resonance', group: 'Filter', unit: 'pct',
      min: 0, max: 1, default: 0.12, curve: 'linear', mutability: 0.7,
      explain: 'Emphasises frequencies right at the cutoff point. Raise it for a vocal, squelchy character; near maximum the filter starts to whistle on its own.',
    },
    {
      id: 'filter-env', name: 'Env Amount', group: 'Filter', unit: 'pct',
      min: 0, max: 1, default: 0.3, curve: 'linear', mutability: 0.8,
      explain: 'How far the envelope sweeps the cutoff when a note starts. This is what makes a note go "wow" or "pluck" rather than simply appearing.',
    },
    {
      id: 'drive', name: 'Drive', group: 'Character', unit: 'pct',
      min: 0, max: 1, default: 0.15, curve: 'linear', macro: 2, macroDepth: 0.85,
      mutability: 0.9,
      explain: 'Overdrives the signal going into the filter, adding harmonics and grit. A little adds weight and glue; a lot turns the clean digital tables aggressive and compressed.',
    },
    {
      id: 'amp-attack', name: 'Attack', group: 'Envelope', unit: 'ms',
      min: 0.5, max: 4000, default: 3, curve: 'exp', mutability: 0.6,
      explain: 'How long the note takes to reach full volume. Short is percussive, long turns any sound into a pad that swells in.',
    },
    {
      id: 'amp-decay', name: 'Decay', group: 'Envelope', unit: 'ms',
      min: 1, max: 8000, default: 500, curve: 'exp', mutability: 0.6,
      explain: 'How quickly the note falls from its peak to the sustain level after the attack finishes.',
    },
    {
      id: 'amp-sustain', name: 'Sustain', group: 'Envelope', unit: 'pct',
      min: 0, max: 1, default: 0.7, curve: 'linear', mutability: 0.5,
      explain: 'The level the note holds at while you keep the key down. Set it to zero and every note becomes a pluck regardless of how long you hold it.',
    },
    {
      id: 'amp-release', name: 'Release', group: 'Envelope', unit: 'ms',
      min: 1, max: 8000, default: 350, curve: 'exp', mutability: 0.6,
      explain: 'How long the sound takes to fade once you let go. Long releases let chords overlap and blur into each other.',
    },
    {
      id: 'filter-keytrack', name: 'Key Track', group: 'Filter', unit: 'pct',
      min: 0, max: 1, default: 0.35, curve: 'linear', mutability: 0.5,
      explain: 'Makes the cutoff follow the note you play, so high notes stay as bright as low ones. Without this, a patch that sings in the bass sounds muffled and dead two octaves up.',
    },
    {
      id: 'amp-velocity', name: 'Vel > Level', group: 'Envelope', unit: 'pct',
      min: 0, max: 1, default: 0.6, curve: 'linear', mutability: 0.5,
      explain: 'How much playing harder increases volume. At zero every note lands at exactly the same level, which is fine for organs and wrong for everything else.',
    },
  ],
};
