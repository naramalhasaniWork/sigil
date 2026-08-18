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
 * Renders any descriptor as grouped parameter rows. Engines, the FX chain and
 * the character FX all go through this — a new module gets a full editing
 * surface without a line of bespoke UI.
 */
export function ParamGroups({
  descriptor, values, colour, onChange,
}: ParamGroupsProps): JSX.Element {
  const groups = useMemo(() => {
    const seen: string[] = [];
    for (const p of descriptor.params) if (!seen.includes(p.group)) seen.push(p.group);
    return seen;
  }, [descriptor]);

  return (
    <div className="max-w-3xl">
      {groups.map((group) => (
        <div key={group} className="mb-6">
          <div
            className="label border-b-[3px] pb-1.5 mb-2"
            style={{ borderColor: 'var(--muted)' }}
          >
            {group}
          </div>
          {descriptor.params.map((p, i) =>
            p.group === group ? (
              <ParamRow
                key={p.id}
                name={p.name}
                value={values[i] ?? p.default}
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
      ))}
    </div>
  );
}
