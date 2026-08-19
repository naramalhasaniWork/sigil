'use client';

import { useEffect, useState, type JSX } from 'react';
import { inPlugin } from '@/audio/plugin-bridge';
import { IS_PUBLIC } from '@/ui/public-mode';

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
export function ScopeSwitch({ scope, onScope, colour }: ScopeSwitchProps): JSX.Element | null {
  /*
   * Hidden in two places, for the same reason: there is no arranger there, and
   * a two-state control with one reachable state is worse than no control.
   *
   * - The PUBLIC build, where a stranger's first thirty seconds should be spent
   *   on the instrument rather than on the least finished surface.
   * - INSIDE A PLUGIN, where the DAW already owns arrangement. A second
   *   timeline inside a device on a track is bloat at best, and at worst it
   *   invites someone to arrange in the wrong place and lose the work.
   *
   * `inPlugin()` reads `window`, so it is resolved after mount rather than
   * during render — the static export prerenders this component with no window
   * at all, and branching on it directly would render the switch on the server
   * and remove it on hydration.
   */
  const [hosted, setHosted] = useState(false);
  useEffect(() => { setHosted(inPlugin()); }, []);
  if (IS_PUBLIC || hosted) return null;

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
