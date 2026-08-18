'use client';

import { useCallback, useRef, useState } from 'react';

interface SecretsOptions {
  /** Current parameter values for the active engine. */
  values: Float32Array | undefined;
  /** Loads a full parameter set back into the engine. */
  loadValues: (next: Float32Array) => void;
  /** The engine's own defaults, for the reset secret. */
  defaults: Float32Array | undefined;
  onReveal: (message: string) => void;
  panic: () => void;
}

export interface Secrets {
  /** Store the current patch, or flip between the stored one and live. */
  toggleAB: () => void;
  /** True while you are hearing the stored snapshot rather than your edits. */
  onSnapshot: boolean;
  hasSnapshot: boolean;
  /** Wire to Panic: twice inside the window resets the patch to defaults. */
  panicPressed: () => void;
}

const DOUBLE_PANIC_MS = 600;

/**
 * Secrets that are worth finding — each one is a real workflow shortcut rather
 * than a decoration, which is the only justification for hiding it.
 */
export function useSecrets({
  values, loadValues, defaults, onReveal, panic,
}: SecretsOptions): Secrets {
  const snapshotRef = useRef<Float32Array | null>(null);
  const liveRef = useRef<Float32Array | null>(null);
  const [onSnapshot, setOnSnapshot] = useState(false);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const lastPanic = useRef(0);

  /**
   * A/B compare. Twenty minutes into tweaking you lose track of whether you
   * improved the sound or just changed it — this is the answer, and every
   * hardware synth has it.
   */
  const toggleAB = useCallback((): void => {
    if (!values) return;
    if (snapshotRef.current === null) {
      snapshotRef.current = Float32Array.from(values);
      setHasSnapshot(true);
      onReveal('Snapshot stored — double-tap the mark again to A/B it');
      return;
    }
    if (onSnapshot) {
      const live = liveRef.current;
      if (live) loadValues(live);
      setOnSnapshot(false);
      onReveal('B — your edits');
    } else {
      liveRef.current = Float32Array.from(values);
      loadValues(snapshotRef.current);
      setOnSnapshot(true);
      onReveal('A — the snapshot');
    }
  }, [values, onSnapshot, loadValues, onReveal]);

  /**
   * Panic twice quickly resets the patch to the engine's defaults. Panic is
   * already the button you hit when something has gone wrong; hitting it twice
   * is what people instinctively do when once was not enough.
   */
  const panicPressed = useCallback((): void => {
    panic();
    const now = Date.now();
    if (now - lastPanic.current < DOUBLE_PANIC_MS && defaults) {
      loadValues(Float32Array.from(defaults));
      onReveal('Patch reset to defaults');
      lastPanic.current = 0;
      return;
    }
    lastPanic.current = now;
  }, [panic, defaults, loadValues, onReveal]);

  return { toggleAB, onSnapshot, hasSnapshot, panicPressed };
}
