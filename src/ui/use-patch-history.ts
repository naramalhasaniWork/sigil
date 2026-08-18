'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { cloneSnapshot, sameSnapshot, type PatchSnapshot } from '@/ui/patch-snapshot';

/**
 * Undo for the sound.
 *
 * This instrument's whole proposition is that you can turn a knob without
 * thinking about it. That is only true if the way back is one keystroke, so
 * undo is not a convenience here — it is the thing that makes exploring safe.
 *
 * ## Why it watches rather than intercepts
 *
 * A sound changes from a dozen places: knobs, macros, the XY pad, presets,
 * Hunt auditions, MIDI learn, a hidden randomiser. Wrapping every one of them
 * would mean a dozen chances to forget one, and the one you forgot is the one
 * that loses someone's sound. So this watches the resulting patch instead: if
 * the sound changed, it is undoable, whatever moved it.
 *
 * ## Why it waits
 *
 * Dragging one slider emits a hundred values. Each is a real change, and none
 * of them is a real *step* — nobody wants to press undo a hundred times to get
 * back across one gesture. A change is committed once the sound has been still
 * for {@link QUIET_MS}, so one gesture is one step.
 */

/** How long the sound must sit still before the change counts as a step. */
const QUIET_MS = 400;

/** Steps kept. Each is a few hundred floats; 60 is nothing and covers a session. */
const LIMIT = 60;

export interface PatchHistory {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Drops every step and re-bases on the current sound. */
  clear: () => void;
}

export function usePatchHistory(
  current: PatchSnapshot,
  restore: (snap: PatchSnapshot) => void,
): PatchHistory {
  const past = useRef<PatchSnapshot[]>([]);
  const future = useRef<PatchSnapshot[]>([]);
  /**
   * The last state history knows about. Everything keys off this: the timer
   * commits when it disagrees with the live sound, and restoring sets it to
   * what was restored — which is what stops undo from being recorded as a new
   * change and stops redo from being unreachable.
   */
  const baseline = useRef<PatchSnapshot>(cloneSnapshot(current));
  const liveRef = useRef<PatchSnapshot>(current);
  liveRef.current = current;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // History lives in refs so a restore never runs inside a state updater; this
  // is the nudge that repaints the buttons when their enabled-ness changes.
  const [, repaint] = useReducer((n: number): number => n + 1, 0);

  const cancel = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  /** Bank whatever is currently pending. Returns true if a step was recorded. */
  const commit = useCallback((): boolean => {
    cancel();
    const live = liveRef.current;
    if (sameSnapshot(baseline.current, live)) return false;
    past.current.push(baseline.current);
    if (past.current.length > LIMIT) past.current.shift();
    // A new edit is a new branch — whatever you had undone past is gone.
    future.current = [];
    baseline.current = cloneSnapshot(live);
    return true;
  }, [cancel]);

  useEffect(() => {
    if (sameSnapshot(baseline.current, current)) return;
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (commit()) repaint();
    }, QUIET_MS);
    return cancel;
  }, [current, cancel, commit]);

  const undo = useCallback((): void => {
    // An edit still inside its quiet window is what you meant to undo, so bank
    // it first. Without this, undo would skip straight past the knob you were
    // touching a moment ago and revert the change before it.
    commit();
    const previous = past.current.pop();
    if (previous === undefined) return;
    future.current.push(baseline.current);
    baseline.current = previous;
    restoreRef.current(previous);
    repaint();
  }, [commit]);

  const redo = useCallback((): void => {
    commit();
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(baseline.current);
    baseline.current = next;
    restoreRef.current(next);
    repaint();
  }, [commit]);

  const clear = useCallback((): void => {
    cancel();
    past.current = [];
    future.current = [];
    baseline.current = cloneSnapshot(liveRef.current);
    repaint();
  }, [cancel]);

  return {
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    clear,
  };
}
