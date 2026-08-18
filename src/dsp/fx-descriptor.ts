import type { EngineDescriptor } from '@/audio/types';

/**
 * The master effects chain. Parameter ORDER is load-bearing: `fx.ts` addresses
 * these by index, so never reorder without updating the P_* constants there.
 */
export const FX_DESCRIPTOR: EngineDescriptor = {
  id: 'fx',
  name: 'Effects',
  colour: '#7C9CFF',
  macroNames: ['Space', 'Motion', 'Grit', 'Echo'],
  params: [
    {
      id: 'drive-amount', name: 'Drive', group: 'Drive', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', macro: 2, macroDepth: 0.7,
      mutability: 0.9,
      explain: 'Pushes the whole mix into soft saturation, rounding peaks off and adding harmonics that were never in the notes. Level is compensated, so this changes character and weight rather than loudness.',
    },
    {
      id: 'drive-tone', name: 'Drive Tone', group: 'Drive', unit: 'pct',
      min: 0, max: 1, default: 0.5, curve: 'linear', mutability: 0.7,
      explain: 'Tilts what the saturator hears: low settings feed it bass so the grit lands underneath, high settings feed it treble so the grit lands on top. Centre is flat and neutral.',
    },
    {
      id: 'crush-rate', name: 'Downsample', group: 'Crush', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', mutability: 0.8,
      explain: 'Throws away sample rate by holding each value for longer, which folds bright content back down into ringing metallic overtones. This is the sound of cheap samplers, used on purpose.',
    },
    {
      id: 'crush-bits', name: 'Bit Depth', group: 'Crush', unit: 'none',
      min: 2, max: 16, default: 16, curve: 'linear', mutability: 0.8,
      explain: 'How many steps the signal is allowed to sit on. Sixteen is transparent; below eight the quiet tails turn gritty and granular because there is no longer a small enough step to describe them.',
    },
    {
      id: 'chorus-rate', name: 'Chorus Rate', group: 'Chorus', unit: 'hz',
      min: 0.05, max: 6, default: 0.45, curve: 'exp', mutability: 0.7,
      explain: 'How fast the chorus delay lines wobble. Slow is a gentle drift that reads as analogue instability; fast becomes an obvious warble or vibrato.',
    },
    {
      id: 'chorus-depth', name: 'Chorus Depth', group: 'Chorus', unit: 'pct',
      min: 0, max: 1, default: 0.35, curve: 'linear', macro: 1, macroDepth: 0.6,
      mutability: 0.9,
      explain: 'How far the wobble moves each delay line. More depth means more detuning against the dry signal, which is what turns one voice into an ensemble.',
    },
    {
      id: 'chorus-width', name: 'Chorus Width', group: 'Chorus', unit: 'pct',
      min: 0, max: 1, default: 0.6, curve: 'linear', mutability: 0.7,
      explain: 'Spreads the three chorus voices apart in both delay time and wobble speed. Low keeps them nearly on top of each other for a tight doubling; high scatters them into a wide, lush smear.',
    },
    {
      id: 'chorus-mix', name: 'Chorus Mix', group: 'Chorus', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', mutability: 0.8,
      explain: 'How much of the wobbling copies you hear against the original. At zero the chorus is bypassed exactly; past halfway the dry signal steps back and the sound starts to swim.',
    },
    {
      id: 'delay-time', name: 'Delay Time', group: 'Delay', unit: 'ms',
      min: 1, max: 2000, default: 340, curve: 'exp', mutability: 0.8,
      explain: 'The gap before the first repeat. Under about 30ms it stops sounding like an echo and starts sounding like a resonant tube; long settings turn playing into a conversation with yourself.',
    },
    {
      id: 'delay-feedback', name: 'Feedback', group: 'Delay', unit: 'pct',
      min: 0, max: 1, default: 0.4, curve: 'linear', mutability: 0.8,
      explain: 'How much of each repeat is fed back in to make the next one. Capped safely below runaway, so even at maximum the repeats always eventually die instead of screaming.',
    },
    {
      id: 'delay-tone', name: 'Delay Tone', group: 'Delay', unit: 'hz',
      min: 400, max: 16000, default: 4000, curve: 'exp', mutability: 0.7,
      explain: 'A lowpass inside the feedback loop, so every repeat comes back darker than the last. This is what makes a digital delay sit behind the music like tape instead of cutting through it.',
    },
    {
      id: 'delay-width', name: 'Ping-Pong', group: 'Delay', unit: 'pct',
      min: 0, max: 1, default: 0.5, curve: 'linear', mutability: 0.7,
      explain: 'Splits the delay into two lines that hand the signal back and forth at different times, so repeats bounce in a rhythm instead of landing on one steady grid. At zero it is a plain single delay.',
    },
    {
      id: 'delay-mix', name: 'Delay Mix', group: 'Delay', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', macro: 3, macroDepth: 0.6,
      mutability: 0.8,
      explain: 'How loud the repeats are against the dry sound. At zero the delay is bypassed exactly, which matters because a delay you cannot fully turn off will always muddy a tight patch.',
    },
    {
      id: 'reverb-predelay', name: 'Pre-Delay', group: 'Reverb', unit: 'ms',
      min: 0, max: 200, default: 18, curve: 'linear', mutability: 0.7,
      explain: 'A silent gap before the reverb starts. Even 20ms keeps the attack of a note clear and dry while still letting the tail be huge, which is most of what makes a reverb sound expensive.',
    },
    {
      id: 'reverb-size', name: 'Size', group: 'Reverb', unit: 'pct',
      min: 0.15, max: 1, default: 0.55, curve: 'linear', mutability: 0.8,
      explain: 'Scales every delay line in the reverb network, so the echoes inside it are further apart. Small reads as a tiled room, large as a cathedral, and it changes the tone as much as the length.',
    },
    {
      id: 'reverb-decay', name: 'Decay', group: 'Reverb', unit: 'ms',
      min: 200, max: 12000, default: 2200, curve: 'exp', mutability: 0.8,
      explain: 'Roughly how long the tail takes to fall away to nothing. Set independently of size, so you can have a small bright room with an unnaturally long tail, or a huge hall that stops dead.',
    },
    {
      id: 'reverb-damping', name: 'Damping', group: 'Reverb', unit: 'pct',
      min: 0, max: 1, default: 0.5, curve: 'linear', mutability: 0.8,
      explain: 'How fast the high frequencies die relative to the lows, imitating air and soft furnishings. Without it a reverb tail sounds like ringing glass; with it the tail sinks warmly out of the way.',
    },
    {
      id: 'reverb-mix', name: 'Reverb Mix', group: 'Reverb', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', macro: 0, macroDepth: 0.7,
      mutability: 0.8,
      explain: 'How much tail you hear against the dry sound. This is the single biggest difference between a patch that sounds like a demo and one that sounds like a record.',
    },
    {
      id: 'output-trim', name: 'Output', group: 'Output', unit: 'db',
      min: -24, max: 12, default: 0, curve: 'linear', mutability: 0.4,
      explain: 'Final level after all the effects, so you can match volume when a heavy setting makes the patch louder or quieter. A safety limiter still catches anything above the rails.',
    },
  ],
};
