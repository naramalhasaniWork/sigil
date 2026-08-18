'use client';

import type { JSX } from 'react';
import { EngineMark } from './engine-mark';

export interface EngineSummary {
  id: string;
  name: string;
  colour: string;
}

interface EngineRailProps {
  engines: readonly EngineSummary[];
  activeId: string;
  onSelect: (id: string) => void;
}

export function EngineRail({ engines, activeId, onSelect }: EngineRailProps): JSX.Element {
  return (
    <nav aria-label="Synthesis engine" className="flex flex-col">
      {engines.map((e) => {
        const active = e.id === activeId;
        return (
          <button
            key={e.id}
            type="button"
            aria-pressed={active}
            onClick={(): void => onSelect(e.id)}
            className="flex items-center gap-2.5 px-3 border-b-[3px] text-left transition-none"
            style={{
              minHeight: '44px',
              borderColor: 'var(--ink)',
              background: active ? e.colour : 'transparent',
              // Inactive engine names are navigation, not decoration: --muted is 4.08:1
              // on --panel and fails AA. The active row already reads by its fill.
              color: active ? 'var(--bg)' : 'var(--ink)',
            }}
          >
            <EngineMark engineId={e.id} colour={active ? '#0E0E0E' : e.colour} size={20} />
            <span className="text-[11px] font-bold uppercase tracking-[0.08em]">{e.name}</span>
          </button>
        );
      })}
    </nav>
  );
}
