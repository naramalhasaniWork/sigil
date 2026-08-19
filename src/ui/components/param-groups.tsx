'use client';

import { useCallback, useMemo, useState, type JSX } from 'react';
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
 * GROUPS COLLAPSE, AND THAT IS THE POINT. Analog's Deep view is 33 rows over
 * 2020px of scroll and the FX chain is 41 rows across 12 units; both were a
 * wall you had to read in full to find one control. Collapsed, they are 4 and
 * 12 lines — the whole instrument legible without scrolling, opened one part at
 * a time.
 *
 * Nothing is hidden in the sense of being taken away: every parameter is one
 * tap from where it always was, and a group carrying edits announces itself
 * whether it is open or shut. The chip and the Reset exist because of a real
 * failure — a downsample setting left up made every engine sound degraded and
 * there was no way to see which of five effects was responsible. Power was
 * never the problem; a chain you cannot read is.
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

  /*
   * Open groups, by name. Keyed on the descriptor so switching engine or moving
   * between the FX and character chains does not carry one surface's open
   * groups onto another's.
   *
   * The first group starts open: an entirely collapsed panel reads as empty and
   * gives no clue that a line expands.
   */
  const [openBy, setOpenBy] = useState<Record<string, ReadonlySet<string>>>({});
  const key = descriptor.id;
  const open = openBy[key] ?? new Set<string>(groups.slice(0, 1));

  const toggle = useCallback((group: string): void => {
    setOpenBy((prev) => {
      const current = prev[key] ?? new Set<string>(groups.slice(0, 1));
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return { ...prev, [key]: next };
    });
  }, [key, groups]);

  return (
    <div className="max-w-3xl">
      {groups.map((group) => {
        const changed = changedByGroup.get(group) ?? [];
        const isOpen = open.has(group);
        const count = descriptor.params.reduce((n, p) => (p.group === group ? n + 1 : n), 0);

        return (
          <div key={group} className={isOpen ? 'mb-6' : 'mb-1.5'}>
            <div
              className="flex items-center gap-2.5 border-b-[3px]"
              style={{ borderColor: changed.length > 0 ? colour : 'var(--muted)' }}
            >
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={(): void => toggle(group)}
                className="flex items-center gap-2.5 flex-1 text-left pb-1.5"
                style={{ minHeight: 44, color: 'var(--ink)' }}
              >
                {/* Rotating one glyph rather than swapping two: the arrow is the
                    same object before and after, so it reads as the section
                    turning rather than the control changing. */}
                <span
                  aria-hidden="true"
                  className="text-[10px] inline-block"
                  style={{
                    transform: isOpen ? 'rotate(90deg)' : 'none',
                    transition: 'transform 90ms linear',
                  }}
                >
                  ▶
                </span>
                <span className="label">{group}</span>

                {/* The count is what makes a shut group honest about its size. */}
                <span className="label" style={{ color: 'var(--ink)', opacity: 0.55 }}>
                  {count}
                </span>

                {changed.length > 0 && (
                  /*
                   * A filled chip, not a dot: across twelve groups the eye finds
                   * the one carrying colour, and the number says how much of it
                   * is you rather than the default. It shows while collapsed,
                   * which is the whole reason collapsing is safe.
                   */
                  <span
                    className="text-[9px] font-bold uppercase tracking-[0.14em] px-1.5 py-0.5"
                    style={{ background: colour, color: 'var(--bg)' }}
                  >
                    {changed.length} changed
                  </span>
                )}
              </button>

              {changed.length > 0 && (
                <button
                  type="button"
                  className="shrink-0 border-[3px] px-2 text-[9px] font-bold uppercase tracking-[0.14em]"
                  style={{ minHeight: 44, minWidth: 44, borderColor: 'var(--ink)', color: 'var(--ink)' }}
                  aria-label={`Reset ${group} to defaults`}
                  onClick={(): void => {
                    for (const i of changed) onChange(i, descriptor.params[i]?.default ?? 0);
                  }}
                >
                  Reset
                </button>
              )}
            </div>

            {isOpen && (
              <div className="mt-2">
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
            )}
          </div>
        );
      })}
    </div>
  );
}
