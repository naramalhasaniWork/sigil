'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * SIGIL's whole motion vocabulary — three durations, and that is the lot.
 *
 * Motion here is confirmation, never decoration: a control that moved when you
 * pressed it, a number that lands rather than teleports. Anything slower than
 * `slow` reads as the instrument thinking, which is exactly the wrong feeling
 * for something you play. Everything in this file goes silent under
 * prefers-reduced-motion, because on a phone held close to the face, motion is
 * the difference between "alive" and "unusable".
 */
export const MOTION = { fast: 90, base: 150, slow: 260 } as const;

/**
 * True when the player has asked their system for less movement. Starts false
 * so the server-rendered markup and the first client paint agree, then
 * corrects on mount and tracks changes live.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return (): void => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export interface FlashState {
  /** True for `durationMs` after `flash()`. Always false under reduced motion. */
  flashing: boolean;
  flash: () => void;
}

/**
 * A one-shot "that happened" pulse — a border that goes solid for a beat when a
 * preset lands or a note is captured. Re-firing restarts the pulse rather than
 * stacking timers, so holding a repeat key does not leave it stuck on.
 */
export function useFlash(durationMs: number = MOTION.base): FlashState {
  const reduced = useReducedMotion();
  const [flashing, setFlashing] = useState(false);
  const timer = useRef<number | null>(null);

  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const durationRef = useRef(durationMs);
  durationRef.current = durationMs;

  useEffect(() => (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  // Under reduced motion this does nothing at all: the toast still says what
  // happened, so no information is carried by the pulse alone.
  const flash = useCallback((): void => {
    if (reducedRef.current) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    setFlashing(true);
    timer.current = window.setTimeout((): void => {
      timer.current = null;
      setFlashing(false);
    }, durationRef.current);
  }, []);

  return { flashing, flash };
}

/**
 * Eases a numeric readout to its new value instead of snapping. Used for things
 * you read rather than steer — file sizes, voice counts, sample rates — so a
 * changed number catches the eye without a flashing badge.
 *
 * Never use this for a value the player is dragging: lag under the finger is
 * the one thing that makes a control feel broken.
 */
export function useCountUp(target: number, ms: number = MOTION.slow): number {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }

    if (reduced || ms <= 0 || !Number.isFinite(target) || !Number.isFinite(displayRef.current)) {
      displayRef.current = target;
      setDisplay(target);
      return;
    }

    const from = displayRef.current;
    if (from === target) return;

    const startedAt = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - startedAt) / ms);
      const eased = 1 - (1 - t) ** 3;
      const value = t >= 1 ? target : from + (target - from) * eased;
      displayRef.current = value;
      setDisplay(value);
      raf.current = t >= 1 ? null : requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);

    return (): void => {
      if (raf.current !== null) {
        cancelAnimationFrame(raf.current);
        raf.current = null;
      }
    };
  }, [target, ms, reduced]);

  return display;
}
