import type { EngineDescriptor } from '@/audio/types';
import { ANALOG_DESCRIPTOR } from '@/dsp/analog-descriptor';
import { ANALOG_PRESETS } from '@/dsp/presets-analog';
import { FM_PRESETS } from '@/dsp/presets-fm';
import { PHYSICAL_PRESETS } from '@/dsp/presets-physical';
import { GRANULAR_PRESETS } from '@/dsp/presets-granular';

/**
 * A curated starting point. Presets are organised by CHARACTER rather than by
 * instrument role: you reach for "glassy" or "broken" long before you reach for
 * "pad 3". `values` is sparse — anything omitted falls back to the parameter's
 * own default, so a preset only states what it actually cares about.
 */
export interface Preset {
  id: string;
  name: string;
  engineId: string;
  character: readonly string[];
  values: Readonly<Record<string, number>>;
}

/**
 * The whole library, engine by engine. Each bank lives in its own file so a
 * bank can grow without this one drifting past its size budget; character
 * tags deliberately cross engine borders, so browsing "glassy" walks you from
 * analog plucks through FM bells into bowed glass and granular sleet.
 */
export const PRESETS: readonly Preset[] = [
  ...ANALOG_PRESETS,
  ...FM_PRESETS,
  ...PHYSICAL_PRESETS,
  ...GRANULAR_PRESETS,
];

/**
 * Flattens a preset onto a descriptor's parameter order. Any parameter the
 * preset does not mention keeps its default, and out-of-range values are
 * clamped so a hand-edited preset can never drive the engine somewhere its
 * DSP was never designed for.
 */
export function presetToValues(preset: Preset, descriptor: EngineDescriptor): Float32Array {
  const params = descriptor.params;
  const out = new Float32Array(params.length);
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === undefined) continue;
    const supplied = preset.values[p.id];
    const value = supplied === undefined ? p.default : supplied;
    out[i] = value < p.min ? p.min : value > p.max ? p.max : value;
  }
  return out;
}

/** Every preset carrying a character tag, in library order. */
export function presetsForCharacter(tag: string): readonly Preset[] {
  return PRESETS.filter((preset) => preset.character.includes(tag));
}

/** Every preset written for one engine, in library order. */
export function presetsForEngine(engineId: string): readonly Preset[] {
  return PRESETS.filter((preset) => preset.engineId === engineId);
}

/** Convenience lookup for the built-in analog bank. */
export function analogPresets(): readonly Preset[] {
  return presetsForEngine(ANALOG_DESCRIPTOR.id);
}
