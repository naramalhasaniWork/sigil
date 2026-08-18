'use client';

import type { JSX } from 'react';

export type Scope = 'sound' | 'song';

export interface ScopeSwitchProps {
  scope: Scope;
  onScope: (s: Scope) => void;
  colour: string;
}

const SCOPES: readonly Scope[] = ['sound', 'song'];

/**
 * Am I working on the sound, or on the song?
 *
 * This is NOT a tab, and the whole point of the component is to look like it is
 * not one. The tabs beside it — sculpt, deep, fx, hunt — are six lenses on one
 * noun; this picks which noun. So it sits at the head of the strip behind a
 * doubled 3px rule, which is the one piece of visual grammar in SIGIL that says
 * "different kind of control" without needing a caption to explain it.
 *
 * Both buttons are 44px, because this is the switch you hit most often and it
 * is hit with a thumb.
 */
export function ScopeSwitch({ scope, onScope, colour }: ScopeSwitchProps): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Scope"
      className="flex shrink-0 border-r-[6px]"
      style={{ borderColor: 'var(--ink)' }}
    >
      {SCOPES.map((s) => {
        const active = scope === s;
        return (
          <button
            key={s}
            type="button"
            aria-pressed={active}
            onClick={(): void => onScope(s)}
            className="px-3 text-[10px] font-bold uppercase tracking-[0.18em] border-r-[3px]"
            style={{
              minWidth: '44px',
              minHeight: '44px',
              borderColor: 'var(--ink)',
              background: active ? colour : 'transparent',
              // Never --muted: 4.14:1 on panel fails AA at this size.
              color: active ? 'var(--bg)' : 'var(--ink)',
              touchAction: 'manipulation',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {s}
          </button>
        );
      })}
    </div>
  );
}
