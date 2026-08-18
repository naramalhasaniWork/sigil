import type { EngineDescriptor } from './types';

/**
 * The saved-patch format.
 *
 * Patches used to be a bare positional float array, which meant inserting one
 * parameter into a descriptor silently reinterpreted every patch anyone had ever
 * saved — cutoff would load into resonance and the sound would simply be wrong.
 * In a plugin that becomes "my finished track opens sounding different", which is
 * the refund and then the review.
 *
 * So: values are keyed by parameter id, and the payload carries a version.
 *
 * The compatibility rules, which matter more than the shape:
 *  - An id we no longer have is IGNORED. A patch saved by a newer build still
 *    loads in an older one, minus whatever it does not understand.
 *  - An id we expect but do not find falls back to that parameter's DEFAULT.
 *    Adding a parameter therefore cannot break an existing patch.
 *  - Values are clamped to the parameter's range, so a hand-edited or corrupted
 *    file cannot drive the DSP somewhere it was never designed for.
 *  - Every recovery is reported in `warnings` rather than hidden. Silent partial
 *    loads are how a patch quietly becomes a different sound.
 */
export const PATCH_FORMAT_VERSION = 2;

/** Version 1 was positional: `values: number[]` indexed by descriptor order. */
export const LEGACY_POSITIONAL_VERSION = 1;

export interface SerialisedPatch {
  version: number;
  engineId: string;
  /** Parameter id -> value, in the parameter's real units. */
  values: Record<string, number>;
  fx?: Record<string, number>;
  magic?: Record<string, number>;
  name?: string;
  savedAt?: string;
  /** Free-form provenance, e.g. the Hunt trail that found the sound. */
  lineage?: string;
}

export interface LoadResult {
  values: Float32Array;
  fx: Float32Array | null;
  magic: Float32Array | null;
  warnings: string[];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** Keyed record from a positional array, for saving. */
export function toKeyed(
  descriptor: EngineDescriptor,
  values: Float32Array | readonly number[],
): Record<string, number> {
  const out: Record<string, number> = {};
  descriptor.params.forEach((p, i) => {
    const v = values[i];
    if (typeof v === 'number' && Number.isFinite(v)) out[p.id] = v;
  });
  return out;
}

/**
 * Positional array from a keyed record, filling gaps with defaults and clamping.
 * Returns the warnings so a caller can surface what it had to invent.
 */
export function fromKeyed(
  descriptor: EngineDescriptor,
  keyed: Readonly<Record<string, number>> | undefined,
  label: string,
): { values: Float32Array; warnings: string[] } {
  const params = descriptor.params;
  const out = new Float32Array(params.length);
  const warnings: string[] = [];

  if (keyed === undefined) {
    params.forEach((p, i) => { out[i] = p.default; });
    return { values: out, warnings };
  }

  let missing = 0;
  let clamped = 0;
  params.forEach((p, i) => {
    const raw = keyed[p.id];
    if (raw === undefined) {
      out[i] = p.default;
      missing += 1;
      return;
    }
    const fixed = clamp(raw, p.min, p.max);
    if (fixed !== raw) clamped += 1;
    out[i] = fixed;
  });

  const known = new Set(params.map((p) => p.id));
  const unknown = Object.keys(keyed).filter((k) => !known.has(k));

  if (missing > 0) {
    warnings.push(`${label}: ${missing} parameter(s) not in the patch, using defaults`);
  }
  if (clamped > 0) {
    warnings.push(`${label}: ${clamped} value(s) were out of range and were clamped`);
  }
  if (unknown.length > 0) {
    warnings.push(
      `${label}: ignored ${unknown.length} unknown parameter(s) — saved by a newer build`,
    );
  }
  return { values: out, warnings };
}

export function serialisePatch(opts: {
  engine: EngineDescriptor;
  values: Float32Array | readonly number[];
  fxDescriptor?: EngineDescriptor;
  fx?: Float32Array | readonly number[];
  magicDescriptor?: EngineDescriptor;
  magic?: Float32Array | readonly number[];
  name?: string;
  lineage?: string;
  savedAt?: string;
}): SerialisedPatch {
  const patch: SerialisedPatch = {
    version: PATCH_FORMAT_VERSION,
    engineId: opts.engine.id,
    values: toKeyed(opts.engine, opts.values),
  };
  if (opts.fxDescriptor && opts.fx) patch.fx = toKeyed(opts.fxDescriptor, opts.fx);
  if (opts.magicDescriptor && opts.magic) {
    patch.magic = toKeyed(opts.magicDescriptor, opts.magic);
  }
  if (opts.name !== undefined) patch.name = opts.name;
  if (opts.lineage !== undefined) patch.lineage = opts.lineage;
  patch.savedAt = opts.savedAt ?? new Date().toISOString();
  return patch;
}

/**
 * Reads anything that might be a patch. Deliberately tolerant: this runs against
 * localStorage, files a user may have edited, and — once there is a plugin —
 * whatever a host hands back from a project saved by a different build.
 */
export function loadPatch(
  raw: unknown,
  engine: EngineDescriptor,
  fxDescriptor?: EngineDescriptor,
  magicDescriptor?: EngineDescriptor,
): LoadResult | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const warnings: string[] = [];
  const version = typeof obj['version'] === 'number' ? obj['version'] : LEGACY_POSITIONAL_VERSION;

  if (version > PATCH_FORMAT_VERSION) {
    warnings.push(
      `Patch was saved by a newer build (format ${version}); loading what this build understands`,
    );
  }

  // Legacy: a positional array, from before ids were used.
  const rawValues = obj['values'];
  if (Array.isArray(rawValues)) {
    const params = engine.params;
    const out = new Float32Array(params.length);
    params.forEach((p, i) => {
      const v = rawValues[i];
      out[i] = typeof v === 'number' ? clamp(v, p.min, p.max) : p.default;
    });
    warnings.push(
      'Patch used the old positional format; values were matched by position and may be '
      + 'wrong if the engine gained or lost a parameter since it was saved',
    );
    return { values: out, fx: null, magic: null, warnings };
  }

  if (typeof rawValues !== 'object' || rawValues === null) return null;

  const engineLoad = fromKeyed(engine, rawValues as Record<string, number>, engine.name);
  warnings.push(...engineLoad.warnings);

  let fx: Float32Array | null = null;
  if (fxDescriptor && typeof obj['fx'] === 'object' && obj['fx'] !== null) {
    const r = fromKeyed(fxDescriptor, obj['fx'] as Record<string, number>, 'FX');
    fx = r.values;
    warnings.push(...r.warnings);
  }

  let magic: Float32Array | null = null;
  if (magicDescriptor && typeof obj['magic'] === 'object' && obj['magic'] !== null) {
    const r = fromKeyed(magicDescriptor, obj['magic'] as Record<string, number>, 'Character');
    magic = r.values;
    warnings.push(...r.warnings);
  }

  return { values: engineLoad.values, fx, magic, warnings };
}
