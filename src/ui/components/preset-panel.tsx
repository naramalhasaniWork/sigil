'use client';

import type { JSX } from 'react';

export interface PresetEntry {
  id: string;
  name: string;
}

interface PresetPanelProps {
  presets: readonly PresetEntry[];
  userPresets: readonly PresetEntry[];
  activeId: string | null;
  colour: string;
  onLoad: (id: string) => void;
  onLoadUser: (id: string) => void;
  onSave: (name: string) => void;
  /** The patch's own true name. The prompt opens with it already filled in. */
  suggestedName?: string;
}

export function PresetPanel({
  presets, userPresets, activeId, colour, onLoad, onLoadUser, onSave,
  suggestedName = '',
}: PresetPanelProps): JSX.Element {
  const row = (p: PresetEntry, mine: boolean): JSX.Element => {
    const active = activeId === p.id;
    return (
      <button
        key={p.id}
        type="button"
        aria-pressed={active}
        className="flex items-center text-left text-[11px] font-bold uppercase
                   tracking-[0.06em] px-2 border-l-[3px]"
        style={{
          // 25px rows could not be hit on a phone. Every preset is now a full
          // 44pt target; the list scrolls, so the extra height costs nothing.
          minHeight: '44px',
          borderColor: active ? colour : 'transparent',
          background: active ? colour : 'transparent',
          // Every preset name is read. --muted failed AA, so built-ins take --ink
          // like the user's own; the left border is what separates the two.
          color: active ? 'var(--bg)' : 'var(--ink)',
        }}
        onClick={(): void => (mine ? onLoadUser(p.id) : onLoad(p.id))}
      >
        {mine ? `★ ${p.name}` : p.name}
      </button>
    );
  };

  return (
    <div className="p-2.5 border-t-4" style={{ borderColor: 'var(--ink)' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="label">Presets</span>
        <button
          type="button"
          className="border-[2px] px-3 text-[9px] font-bold uppercase tracking-[0.14em]"
          style={{ minHeight: '44px', minWidth: '44px', borderColor: colour, color: colour }}
          onClick={(): void => {
            // Pre-filled with what the patch actually reads as, so naming a
            // sound is a confirmation rather than a blank page.
            const name = window.prompt('Name this patch', suggestedName);
            if (name?.trim()) onSave(name.trim());
          }}
        >
          Save
        </button>
      </div>

      <div className="flex flex-col gap-0.5 max-h-56 overflow-y-auto">
        {userPresets.map((p) => row(p, true))}
        {presets.map((p) => row(p, false))}
        {presets.length === 0 && userPresets.length === 0 && (
          <span className="label">None for this engine yet</span>
        )}
      </div>
    </div>
  );
}
