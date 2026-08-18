import type { EngineDescriptor } from '@/audio/types';

/**
 * The Analog engine's control surface.
 *
 * Parameter INDEX is a wire format: the worklet, presets and the UI all address
 * parameters by position, so existing entries never move. New controls are
 * appended.
 *
 * Macros answer the four questions a player actually asks of a sound: how much
 * weight it has (Body), how bright and open it is (Air), how hard it is being
 * pushed (Grit), and how much it moves on its own (Motion).
 */
export const ANALOG_DESCRIPTOR: EngineDescriptor = {
  id: 'analog',
  name: 'Analog',
  colour: '#FF6B6B',
  macroNames: ['Body', 'Air', 'Grit', 'Motion'],
  params: [
    {
      id: 'osc-detune', name: 'Detune', group: 'Oscillators', unit: 'semitones',
      min: 0, max: 0.5, default: 0.06, curve: 'linear', mutability: 0.8,
      explain: 'Pushes the two oscillators slightly out of tune with each other. Small amounts make the sound thicker and alive; large amounts sound broken and seasick.',
    },
    {
      id: 'osc-drift', name: 'Drift', group: 'Oscillators', unit: 'pct',
      min: 0, max: 1, default: 0.25, curve: 'linear', mutability: 0.9,
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
      min: 0, max: 1, default: 0.15, curve: 'linear', mutability: 0.7,
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
      min: 0, max: 1, default: 0.2, curve: 'linear', macro: 2, macroDepth: 0.85,
      mutability: 0.9,
      explain: 'Overdrives the signal going into the filter, adding harmonics and grit. A little adds weight; a lot turns the sound aggressive and compressed.',
    },
    {
      id: 'osc1-wave', name: 'Wave 1', group: 'Oscillators', unit: 'none',
      min: 0, max: 3, default: 0, curve: 'stepped', steps: 4, mutability: 0.7,
      explain: 'Shape of the first oscillator: saw (bright and buzzy, the sound of strings and leads), pulse (hollow and woody), triangle (soft and flutey), sine (pure, no harmonics at all).',
    },
    {
      id: 'osc2-wave', name: 'Wave 2', group: 'Oscillators', unit: 'none',
      min: 0, max: 3, default: 0, curve: 'stepped', steps: 4, mutability: 0.7,
      explain: 'Shape of the second oscillator, same four choices. Mixing two different shapes is how you get a tone that no single waveform can make.',
    },
    {
      id: 'osc-pulse-width', name: 'Pulse Width', group: 'Oscillators', unit: 'pct',
      min: 0.06, max: 0.94, default: 0.5, curve: 'linear', mutability: 0.8,
      explain: 'How lopsided the pulse wave is. At the halfway point it is a hollow square with no even harmonics; move away from centre and it thins out towards a nasal, reedy buzz. Only affects oscillators set to pulse.',
    },
    {
      id: 'osc-mix', name: 'Osc Mix', group: 'Oscillators', unit: 'pct',
      min: 0, max: 1, default: 0.5, curve: 'linear', mutability: 0.7,
      explain: 'Balance between the two oscillators: fully left is only the first, fully right only the second. Use it to let one waveform dominate while the other just adds colour.',
    },
    {
      id: 'sub-mode', name: 'Sub Shape', group: 'Oscillators', unit: 'none',
      min: 0, max: 3, default: 0, curve: 'stepped', steps: 4, mutability: 0.6,
      explain: 'Which sub-oscillator you get: square one octave down, square two octaves down, sine one octave down, sine two octaves down. Square is solid and present, sine is pure weight you feel more than hear.',
    },
    {
      id: 'sub-level', name: 'Sub', group: 'Oscillators', unit: 'pct',
      min: 0, max: 1, default: 0.15, curve: 'linear', macro: 0, macroDepth: 0.8,
      mutability: 0.8,
      explain: 'Level of an extra oscillator an octave or two below the note. This is where the authority in a bass sound comes from - it adds weight without making the sound any muddier up top.',
    },
    {
      id: 'noise-level', name: 'Noise', group: 'Oscillators', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', mutability: 0.8,
      explain: 'Mixes in hiss, which then passes through the filter like everything else. Essential for breath on a flute, the strike on a drum, or wind and texture under a pad.',
    },
    {
      id: 'unison-voices', name: 'Unison', group: 'Oscillators', unit: 'none',
      min: 1, max: 4, default: 1, curve: 'stepped', steps: 4, mutability: 0.5,
      explain: 'How many detuned copies of the oscillators stack up on every note. One is clean and precise; four is the huge, shimmering wall that supersaw leads are made of. Costs proportionally more processing.',
    },
    {
      id: 'unison-detune', name: 'Spread', group: 'Oscillators', unit: 'pct',
      min: 0, max: 1, default: 0.35, curve: 'linear', mutability: 0.8,
      explain: 'How far apart the stacked unison copies are tuned. Low is a gentle thickening, high is a wide chorusing swirl. Does nothing until Unison is above one.',
    },
    {
      id: 'glide', name: 'Glide', group: 'Oscillators', unit: 'ms',
      min: 0, max: 2000, default: 0, curve: 'linear', mutability: 0.5,
      explain: 'Time taken to slide from the previous note to the new one instead of jumping. Zero is a normal keyboard; a little makes leads sing, a lot makes them slither.',
    },
    {
      id: 'filter-keytrack', name: 'Key Track', group: 'Filter', unit: 'pct',
      min: 0, max: 1, default: 0.35, curve: 'linear', mutability: 0.5,
      explain: 'Makes the cutoff follow the note you play, so high notes stay as bright as low ones. Without this, a patch that sings in the bass sounds muffled and dead two octaves up.',
    },
    {
      id: 'filter-model', name: 'Filter Type', group: 'Filter', unit: 'none',
      min: 0, max: 2, default: 0, curve: 'stepped', steps: 3, mutability: 0.6,
      explain: 'Which filter circuit is doing the work: ladder (fat and steep, the classic), state-variable (cleaner and gentler, keeps more of the top), diode (squelchy and lopsided, bites hard when resonance is up). Most of a synth’s personality lives here.',
    },
    {
      id: 'filter-velocity', name: 'Vel > Cutoff', group: 'Filter', unit: 'pct',
      min: 0, max: 1, default: 0.35, curve: 'linear', mutability: 0.6,
      explain: 'How much playing harder opens the filter. This is why a real instrument gets brighter as well as louder when you dig in, and why a synth without it feels dead under the fingers.',
    },
    {
      id: 'amp-velocity', name: 'Vel > Level', group: 'Envelope', unit: 'pct',
      min: 0, max: 1, default: 0.6, curve: 'linear', mutability: 0.5,
      explain: 'How much playing harder increases volume. At zero every note lands at exactly the same level, which is fine for organs and wrong for everything else.',
    },
    {
      id: 'env-curve', name: 'Curve', group: 'Envelope', unit: 'pct',
      min: 0, max: 1, default: 0.5, curve: 'linear', mutability: 0.6,
      explain: 'Bends the shape of the envelope. Low is sharply exponential - notes snap in and drop away, which is what makes a pluck; high is slow and even, which is what makes a swell.',
    },
    {
      id: 'lfo-rate', name: 'LFO Rate', group: 'Character', unit: 'hz',
      min: 0.02, max: 30, default: 4.5, curve: 'exp', mutability: 0.8,
      explain: 'Speed of the modulation wave, from one slow sweep every minute up to a fast flutter. Around 5 per second is a singer’s vibrato.',
    },
    {
      id: 'lfo-shape', name: 'LFO Shape', group: 'Character', unit: 'none',
      min: 0, max: 4, default: 0, curve: 'stepped', steps: 5, mutability: 0.7,
      explain: 'The modulation waveform: sine and triangle sweep smoothly, square jumps between two values, sample-and-hold steps randomly like an old sequencer, and random walk drifts unpredictably without ever repeating.',
    },
    {
      id: 'lfo-delay', name: 'LFO Fade', group: 'Character', unit: 'ms',
      min: 0, max: 4000, default: 250, curve: 'linear', mutability: 0.6,
      explain: 'How long the modulation takes to fade in after each note starts. Vibrato that arrives a moment late sounds like a player leaning into a note; vibrato that is already there sounds like a machine.',
    },
    {
      id: 'lfo-sync', name: 'LFO Sync', group: 'Character', unit: 'none',
      min: 0, max: 1, default: 1, curve: 'stepped', steps: 2, mutability: 0.5,
      explain: 'On restarts the modulation wave at every note, so every note moves identically. Off lets it run free, so each note in a chord catches the wave at a different point and the chord breathes instead of pulsing as one block.',
    },
    {
      id: 'lfo-pitch', name: 'LFO > Pitch', group: 'Character', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', mutability: 0.8,
      explain: 'Modulation applied to pitch: vibrato. A trace of it is the most human thing you can do to a sustained note; at maximum it is a full octave siren.',
    },
    {
      id: 'lfo-cutoff', name: 'LFO > Cutoff', group: 'Character', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', macro: 3, macroDepth: 0.7,
      mutability: 0.85,
      explain: 'Modulation applied to filter brightness: a wobble, a slow sweep, or the throb under a dance track. This is the movement people hear first in a patch.',
    },
    {
      id: 'lfo-pulse-width', name: 'LFO > Width', group: 'Character', unit: 'pct',
      min: 0, max: 1, default: 0.3, curve: 'linear', mutability: 0.85,
      explain: 'Modulation applied to pulse width, which is the sound of every string machine and lush 80s pad ever made. Needs an oscillator set to pulse before you can hear it.',
    },
    {
      id: 'lfo-amp', name: 'LFO > Level', group: 'Character', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', mutability: 0.8,
      explain: 'Modulation applied to volume: tremolo. Gentle amounts add shimmer; with a square shape and full depth it chops the note into a rhythm.',
    },
  ],
};
