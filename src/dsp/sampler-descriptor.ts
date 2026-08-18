import type { EngineDescriptor } from '@/audio/types';

/**
 * The Sampler's control surface.
 *
 * Parameter INDEX is a wire format: the worklet, presets and the UI all address
 * parameters by position, so existing entries never move. New controls are
 * appended.
 *
 * Everything here is aimed at one job — take a sound the player recorded or
 * found, and let them bend it until it is theirs. Trim it, loop a slice of it,
 * play it backwards, drag it across the keyboard, and dirty it up.
 */
export const SAMPLER_DESCRIPTOR: EngineDescriptor = {
  id: 'sampler',
  name: 'Sampler',
  colour: '#7BC96F',
  macroNames: ['Body', 'Air', 'Grit', 'Motion'],
  params: [
    {
      id: 'sample-start', name: 'Start', group: 'Sample', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', macro: 0, macroDepth: 0.6,
      mutability: 0.9,
      explain: 'Where in the file playback begins. Moving it past the attack turns a plucked note into a sustained one, and moving it into the tail is how a recording of anything becomes a pad.',
    },
    {
      id: 'sample-end', name: 'End', group: 'Sample', unit: 'pct',
      min: 0, max: 1, default: 1, curve: 'linear', mutability: 0.6,
      explain: 'Where playback stops. Pull it in to cut off a room tail, a breath, or the next hit in a recording that had two.',
    },
    {
      id: 'loop-mode', name: 'Loop', group: 'Loop', unit: 'none',
      min: 0, max: 2, default: 0, curve: 'stepped', steps: 3, mutability: 0.7,
      explain: 'Off plays the slice once and stops, which is what you want for drums. Forward repeats it so a note can be held forever. Ping-pong runs it back and forth, which never clicks at the turnaround and gives short slices a rocking motion.',
    },
    {
      id: 'loop-start', name: 'Loop Start', group: 'Loop', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', mutability: 0.8,
      explain: 'Where the repeating section begins, measured inside the trimmed slice. Playback runs from Start, reaches the end of the loop, and jumps back here.',
    },
    {
      id: 'loop-length', name: 'Loop Length', group: 'Loop', unit: 'pct',
      min: 0, max: 1, default: 1, curve: 'linear', macro: 3, macroDepth: 0.7,
      mutability: 0.9,
      explain: 'How much material the loop covers. Long is a sustained tone; shorten it and the loop becomes a stutter, then a buzz whose pitch is the loop itself. This is the fastest route from a field recording to an instrument.',
    },
    {
      id: 'loop-fade', name: 'Loop Fade', group: 'Loop', unit: 'ms',
      min: 0, max: 200, default: 15, curve: 'linear', mutability: 0.6,
      explain: 'Crossfades the end of the loop into its start so the two edges meet smoothly. Without it almost every loop ticks once per repeat, which is the single most obvious sign of a cheap sampler.',
    },
    {
      id: 'reverse', name: 'Reverse', group: 'Sample', unit: 'none',
      min: 0, max: 1, default: 0, curve: 'stepped', steps: 2, mutability: 0.8,
      explain: 'Plays the slice backwards. Decays become swells, so any recording with a natural tail turns into something that breathes in rather than out.',
    },
    {
      id: 'tune', name: 'Tune', group: 'Pitch', unit: 'semitones',
      min: -24, max: 24, default: 0, curve: 'linear', mutability: 0.4,
      explain: 'Shifts the whole sample in semitones. Use it when the detected root note is an octave out, or to drop a sound two octaves for weight it never had.',
    },
    {
      id: 'fine', name: 'Fine', group: 'Pitch', unit: 'semitones',
      min: -0.5, max: 0.5, default: 0, curve: 'linear', mutability: 0.5,
      explain: 'Fine tuning, up to half a semitone either way. Recordings are rarely at concert pitch, and being a few cents out against other instruments is what makes a track sound sour.',
    },
    {
      id: 'filter-cutoff', name: 'Cutoff', group: 'Filter', unit: 'hz',
      min: 20, max: 18000, default: 18000, curve: 'exp', macro: 1, macroDepth: 0.8,
      mutability: 0.9,
      explain: 'The brightness control. Everything above this frequency is progressively removed, which both darkens the sound and hides the harshness that comes from pitching a sample a long way up.',
    },
    {
      id: 'filter-resonance', name: 'Resonance', group: 'Filter', unit: 'pct',
      min: 0, max: 1, default: 0.1, curve: 'linear', mutability: 0.7,
      explain: 'Emphasises frequencies right at the cutoff point. Raise it to give a dull recording a vocal, squelchy edge it did not have.',
    },
    {
      id: 'filter-model', name: 'Filter Type', group: 'Filter', unit: 'none',
      min: 0, max: 2, default: 0, curve: 'stepped', steps: 3, mutability: 0.6,
      explain: 'Which filter circuit does the work: ladder (fat and steep), state-variable (cleaner, keeps more air), diode (squelchy and lopsided). On a sampler this is most of the difference between sounding like the source and sounding like an instrument.',
    },
    {
      id: 'amp-attack', name: 'Attack', group: 'Envelope', unit: 'ms',
      min: 0.5, max: 4000, default: 2, curve: 'exp', mutability: 0.6,
      explain: 'How long the note takes to reach full volume. Keep it short to preserve the transient that tells the ear what the sound is; lengthen it to fade in and lose the attack entirely.',
    },
    {
      id: 'amp-decay', name: 'Decay', group: 'Envelope', unit: 'ms',
      min: 1, max: 8000, default: 800, curve: 'exp', mutability: 0.6,
      explain: 'How quickly the note falls from its peak to the sustain level. With sustain down this is what shortens a long sample into a hit.',
    },
    {
      id: 'amp-sustain', name: 'Sustain', group: 'Envelope', unit: 'pct',
      min: 0, max: 1, default: 1, curve: 'linear', mutability: 0.5,
      explain: 'The level the note holds at while a key is down. Full leaves the recording as it was; lower it and the sample ducks away under its own decay.',
    },
    {
      id: 'amp-release', name: 'Release', group: 'Envelope', unit: 'ms',
      min: 1, max: 8000, default: 120, curve: 'exp', mutability: 0.6,
      explain: 'How long the sound takes to fade once the key is let go. Too short and every note ends with a click; long releases let looped notes overlap into a wash.',
    },
    {
      id: 'drive', name: 'Drive', group: 'Character', unit: 'pct',
      min: 0, max: 1, default: 0.1, curve: 'linear', macro: 2, macroDepth: 0.85,
      mutability: 0.9,
      explain: 'Overdrives the sample into the filter, adding harmonics and grit. A little restores the density a quiet recording lacks; a lot makes it aggressive and compressed.',
    },
    {
      id: 'crush', name: 'Bits', group: 'Character', unit: 'none',
      min: 2, max: 16, default: 16, curve: 'stepped', steps: 15, mutability: 0.8,
      explain: 'Resolution of the playback, in bits. Sixteen is clean; drop towards two and the quiet parts break up into the gritty, gravelly noise of early samplers, which flatters drums and destroys pads.',
    },
    {
      id: 'amp-velocity', name: 'Vel > Level', group: 'Envelope', unit: 'pct',
      min: 0, max: 1, default: 0.6, curve: 'linear', mutability: 0.5,
      explain: 'How much playing harder increases volume. At zero every note lands at exactly the same level, which is right for a loop and wrong for anything played by hand.',
    },
    {
      id: 'wobble', name: 'Wobble', group: 'Character', unit: 'pct',
      min: 0, max: 1, default: 0, curve: 'linear', mutability: 0.85,
      explain: 'Slow pitch wander, the sound of tape that has been round the block. A trace stops a looped sample sounding frozen; a lot is a warped cassette.',
    },
    {
      id: 'wobble-rate', name: 'Wobble Rate', group: 'Character', unit: 'hz',
      min: 0.05, max: 12, default: 5, curve: 'exp', mutability: 0.8,
      explain: 'Speed of that pitch wander. Below one per second it is tape wow; around five it is a singer’s vibrato; faster than that it turns into a flutter that sounds broken, which is sometimes the point.',
    },
  ],
};
