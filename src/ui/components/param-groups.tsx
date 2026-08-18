'use client';

import { useMemo, type JSX } from 'react';
import type { EngineDescriptor } from '@/audio/types';
import { ParamRow } from './param-row';

interface ParamGroupsProps {
  descriptor: EngineDescriptor;
  values: Float32Array;
  colour: string;
  onChange: (index: number, value: number) => void;
}

/**
 * A parameter counts as changed when it is more than a thousandth of its own
 * range from its default. Float32Array cannot store most defaults exactly —
 * 0.45 comes back as 0.4499999880790710 — so an equality test would report the
 * entire chain as modified the moment it was saved and reloaded.
 */
const CHANGED_EPSILON = 0.001;

function isChanged(value: number, p: { default: number; min: number; max: number }): boolean {
  const range = p.max - p.min;
  if (!Number.isFinite(value) || range <= 0) return false;
  return Math.abs(value - p.default) > range * CHANGED_EPSILON;
}

/**
 * Renders any descriptor as grouped parameter rows. Engines, the FX chain and
 * the character FX all go through this — a new module gets a full editing
 * surface without a line of bespoke UI.
 *
 * Each group states how many of its parameters are away from default, and
 * offers to put them back. This exists because of a real failure: a downsample
 * setting left up made every engine and every preset sound degraded, and there
 * was no way to see which of five effects was responsible. Power is not the
 * problem — a chain you cannot read is. Nothing here changes what a parameter
 * does; it only makes the current state legible and reversible.
 */
export function ParamGroups({
  descriptor, values, colour, onChange,
}: ParamGroupsProps): JSX.Element {
  const groups = useMemo(() => {
    const seen: string[] = [];
    for (const p of descriptor.params) if (!seen.includes(p.group)) seen.push(p.group);
    return seen;
  }, [descriptor]);

  /** Indices of the changed parameters, per group. Recomputed as values move. */
  const changedByGroup = useMemo(() => {
    const map = new Map<string, number[]>();
    descriptor.params.forEach((p, i) => {
      if (!isChanged(values[i] ?? p.default, p)) return;
      const list = map.get(p.group);
      if (list === undefined) map.set(p.group, [i]);
      else list.push(i);
    });
    return map;
  }, [descriptor, values]);

  return (
    <div className="max-w-3xl">
      {groups.map((group) => {
        const changed = changedByGroup.get(group) ?? [];
        return (
          <div key={group} className="mb-6">
            <div
              className="flex items-center gap-2.5 border-b-[3px] pb-1.5 mb-2"
              style={{ borderColor: changed.length > 0 ? colour : 'var(--muted)' }}
            >
              <span className="label">{group}</span>

              {changed.length > 0 && (
                <>
                  {/*
                    A filled chip, not a dot: at a glance across five groups the
                    eye finds the one carrying colour, and the number says how
                    much of it is you rather than the default.
                  */}
                  <span
                    className="text-[9px] font-bold uppercase tracking-[0.14em] px-1.5 py-0.5"
                    style={{ background: colour, color: 'var(--bg)' }}
                  >
                    {changed.length} changed
                  </span>

                  <button
                    type="button"
                    /* ml-auto keeps it on the far edge, so it can never be hit
                       while reaching for the group name. */
                    className="ml-auto border-[3px] px-2 text-[9px] font-bold uppercase tracking-[0.14em]"
                    // It used to be 28px on the argument that 44 would tower
                    // over a group header. It towers over nothing — every other
                    // control on the page is 44 now — and 28 was the one thing
                    // in Deep you could still miss with a thumb.
                    style={{ minHeight: 44, minWidth: 44, borderColor: 'var(--ink)', color: 'var(--ink)' }}
                    aria-label={`Reset ${group} to defaults`}
                    onClick={(): void => {
                      for (const i of changed) {
                        onChange(i, descriptor.params[i]?.default ?? 0);
                      }
                    }}
                  >
                    Reset
                  </button>
                </>
              )}
            </div>

            {descriptor.params.map((p, i) =>
              p.group === group ? (
                <ParamRow
                  key={p.id}
                  name={p.name}
                  value={values[i] ?? p.default}
                  defaultValue={p.default}
                  min={p.min}
                  max={p.max}
                  unit={p.unit}
                  curve={p.curve}
                  explain={p.explain}
                  colour={colour}
                  onChange={(v): void => onChange(i, v)}
                />
              ) : null,
            )}
          </div>
        );
      })}
    </div>
  );
}
