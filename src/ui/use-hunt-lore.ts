'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineDescriptor } from '@/audio/types';
import { appendStep, rankedMoves, renderTrail, topLabels } from '@/dsp/lineage';
import { applyTaste, blendTaste, decayTaste, tasteFrom } from '@/dsp/taste';

/**
 * The memory of a hunt: where the current sound came from, and what the machine
 * has worked out about your ear.
 *
 * Kept out of `use-instrument` on purpose. All the real logic lives in
 * `@/dsp/lineage` and `@/dsp/taste` as pure functions with tests; this is only
 * the state that has to survive between clicks, plus the rules about *when* each
 * pure function is called — which is where the feel actually comes from.
 */

/** How much the newest generation counts against everything before it. */
const BLEND_ALPHA = 0.5;
/** Taste fades every generation, so a preference has to be re-expressed. */
const DECAY = 0.85;
/** How far along the taste direction a new generation is seeded. Well under 1. */
const STRENGTH = 0.5;
/**
 * Smallest biased move worth putting a word to. Whether the machine says anything
 * at all is decided by this and nothing else: if no parameter has drifted by 2%
 * of its own range, there are no labels and the panel hides itself. An explicit
 * "has it learned enough" threshold on the vector's magnitude was tried and was
 * wrong — most parameters have low mutability and never move, so the mean was
 * always tiny and the machine stayed silent even when it had a clear opinion.
 */
const LABEL_FLOOR = 0.02;

export interface HuntLore {
  /** One line: `Glass Bell → brighter → longer tail`. Empty when there is none. */
  trail: string;
  /** What the machine thinks you are reaching for, e.g. `darker`, `looser`. */
  tasteLabels: readonly string[];
  /** Start a new story from a named origin — a preset, or chance. */
  reset: (origin: string) => void;
  /** The step you are only auditioning. Replaces the last one, never stacks. */
  suggest: (label: string | undefined) => void;
  /** Commit the auditioned step, optionally adding another of your own. */
  commit: (label?: string) => void;
  /** Fold this generation's keeps into the standing taste. */
  observe: (
    seed: Float32Array,
    kept: readonly Float32Array[],
    descriptor: EngineDescriptor,
  ) => void;
  /** The seed a new generation should actually grow from. */
  seedFor: (values: Float32Array, descriptor: EngineDescriptor) => Float32Array;
  /** Throw the taste away. Always one press from here. */
  forget: () => void;
}

/**
 * `engineId` is a reset boundary, not decoration: a taste vector is indexed by
 * parameter position, and parameter 7 in FM is not parameter 7 in Analog, so
 * carrying one across engines would apply a preference about feedback to a
 * preference about filter type. Lineage resets with it, because a trail that
 * spans two engines is not a story about one sound.
 */
export function useHuntLore(engineId: string): HuntLore {
  const [steps, setSteps] = useState<readonly string[]>([]);
  const [tentative, setTentative] = useState<string | null>(null);
  const [tasteLabels, setTasteLabels] = useState<readonly string[]>([]);
  const tasteRef = useRef<Float32Array | null>(null);
  /*
   * The tentative step is mirrored in a ref as well as in state because `commit`
   * has to read it and write `steps` in the same call. Doing that by nesting one
   * setter inside the other's updater made the updater impure, and React's dev
   * double-invocation ran it twice — one press of Breed wrote "bred → bred".
   */
  const tentativeRef = useRef<string | null>(null);

  const forget = useCallback((): void => {
    tasteRef.current = null;
    setTasteLabels([]);
  }, []);

  useEffect(() => {
    tasteRef.current = null;
    tentativeRef.current = null;
    setTasteLabels([]);
    setSteps([]);
    setTentative(null);
  }, [engineId]);

  const reset = useCallback((origin: string): void => {
    tentativeRef.current = null;
    setSteps(origin.trim() === '' ? [] : [origin.trim()]);
    setTentative(null);
  }, []);

  const suggest = useCallback((label: string | undefined): void => {
    const next = label === undefined || label.trim() === '' ? null : label.toLowerCase();
    tentativeRef.current = next;
    setTentative(next);
  }, []);

  // Reads the pending step and clears it BEFORE queueing the update, so the
  // updater closes over a local and is safe to run more than once.
  const commit = useCallback((label?: string): void => {
    const pending = tentativeRef.current;
    tentativeRef.current = null;
    setSteps((prev) => {
      const withPending = pending === null ? prev : appendStep(prev, pending);
      return label === undefined ? withPending : appendStep(withPending, label.toLowerCase());
    });
    setTentative(null);
  }, []);

  const observe = useCallback((
    seed: Float32Array,
    kept: readonly Float32Array[],
    descriptor: EngineDescriptor,
  ): void => {
    if (kept.length === 0) return;
    const observed = tasteFrom(seed, kept, descriptor);
    const next = decayTaste(blendTaste(tasteRef.current, observed, BLEND_ALPHA), DECAY);
    tasteRef.current = next;
    setTasteLabels(
      topLabels(
        rankedMoves(seed, applyTaste(seed, next, descriptor, 1), descriptor, LABEL_FLOOR), 2,
      ).map((l) => l.toLowerCase()),
    );
  }, []);

  const seedFor = useCallback((
    values: Float32Array,
    descriptor: EngineDescriptor,
  ): Float32Array => {
    const taste = tasteRef.current;
    if (taste === null || taste.length !== descriptor.params.length) {
      return Float32Array.from(values);
    }
    return applyTaste(values, taste, descriptor, STRENGTH);
  }, []);

  return {
    trail: renderTrail(steps, tentative),
    tasteLabels,
    reset, suggest, commit, observe, seedFor, forget,
  };
}
