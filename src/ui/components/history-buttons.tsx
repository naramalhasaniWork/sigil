'use client';

import type { JSX } from 'react';
import { useIsMac } from '@/ui/use-shortcuts';
import { formatKeys } from '@/ui/shortcuts';

export interface HistoryButtonsProps {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

/**
 * Undo and redo, on screen.
 *
 * Cmd-Z alone would be a desktop-only feature, and this instrument is played
 * on a phone — there is no modifier key to hold. It is also the affordance
 * that says the way back exists at all, which is the point: a knob you can
 * un-turn is a knob you will actually turn.
 *
 * Disabled rather than hidden, so the pair does not move under your thumb the
 * moment there is something to undo.
 */
export function HistoryButtons({
  canUndo, canRedo, onUndo, onRedo,
}: HistoryButtonsProps): JSX.Element {
  const isMac = useIsMac();
  return (
    <>
      <button
        type="button"
        disabled={!canUndo}
        onClick={onUndo}
        aria-keyshortcuts="Meta+Z Control+Z"
        title={`Undo (${formatKeys('mod+z', isMac)})`}
        aria-label="Undo the last sound change"
        className="shrink-0 px-3 border-r-[3px] text-[15px] font-bold leading-none
                   disabled:opacity-35"
        style={{ minWidth: '44px', minHeight: '44px', borderColor: 'var(--ink)', color: 'var(--ink)' }}
      >
        <span aria-hidden="true">↺</span>
      </button>
      <button
        type="button"
        disabled={!canRedo}
        onClick={onRedo}
        aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z"
        title={`Redo (${formatKeys('mod+shift+z', isMac)})`}
        aria-label="Redo the change you just undid"
        className="shrink-0 px-3 border-r-[3px] text-[15px] font-bold leading-none
                   disabled:opacity-35"
        style={{ minWidth: '44px', minHeight: '44px', borderColor: 'var(--ink)', color: 'var(--ink)' }}
      >
        <span aria-hidden="true">↻</span>
      </button>
    </>
  );
}
