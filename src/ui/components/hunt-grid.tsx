'use client';

import type { JSX } from 'react';
import { Pressable } from './pressable';
import { HuntCard, type HuntCandidate } from './hunt-card';

export type Variation = HuntCandidate;

interface HuntGridProps {
  variations: readonly Variation[];
  auditioningId: string | null;
  colour: string;
  /** Where the current sound came from: `Glass Bell → brighter → bred`. */
  trail: string;
  /** What the machine has worked out you keep reaching for. */
  tasteLabels: readonly string[];
  onAudition: (id: string) => void;
  onToggleKeep: (id: string) => void;
  onBreed: () => void;
  onReroll: () => void;
  onForget: () => void;
  keptCount: number;
}

/**
 * Hunt: the machine proposes, you judge.
 *
 * Still no parameters on screen — the choice is made by ear. What is on screen is
 * everything you need to choose *deliberately*: each candidate's mark, its true
 * name, and the words for how it differs. Underneath, the two lines that make a
 * session accumulate rather than reset — where this sound came from, and what the
 * machine now believes about your ear.
 */
export function HuntGrid({
  variations, auditioningId, colour, trail, tasteLabels,
  onAudition, onToggleKeep, onBreed, onReroll, onForget, keptCount,
}: HuntGridProps): JSX.Element {
  return (
    <section aria-label="Hunt" className="flex flex-col gap-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {variations.map((v) => (
          <HuntCard
            key={v.id}
            candidate={v}
            live={v.id === auditioningId}
            colour={colour}
            onAudition={onAudition}
            onToggleKeep={onToggleKeep}
          />
        ))}
      </div>

      {/* The story so far. One line, no timestamps, no tree — the moment this
          needs scrolling it has stopped being a story and become a log. */}
      {trail !== '' && (
        <div
          className="border-[3px] px-3 py-2.5 flex flex-col gap-1"
          style={{ borderColor: '#2A2A28', background: 'var(--panel)' }}
        >
          <span className="label" style={{ color: 'var(--ink)' }}>Found by</span>
          <span
            className="text-[11px] font-bold leading-snug"
            style={{ color: 'var(--ink)' }}
          >
            {trail}
          </span>
        </div>
      )}

      {/* Keeping is a vote, and this is the machine admitting how it counted. */}
      {tasteLabels.length > 0 && (
        <div
          className="border-[3px] px-3 py-2.5 flex items-center justify-between gap-3 flex-wrap"
          style={{ borderColor: colour, background: 'var(--panel)' }}
        >
          <span className="flex flex-col gap-1">
            <span className="label" style={{ color: 'var(--ink)' }}>Following your ear</span>
            <span
              className="text-[11px] font-bold uppercase tracking-[0.06em]"
              style={{ color: 'var(--ink)' }}
            >
              {tasteLabels.join(' · ')}
            </span>
          </span>
          <Pressable onPress={onForget} ariaLabel="Forget what the hunt learned">
            Forget
          </Pressable>
        </div>
      )}

      <div className="flex gap-3 flex-wrap">
        <Pressable
          onPress={onBreed}
          disabled={keptCount < 1}
          colour={colour}
          variant="solid"
        >
          {keptCount === 0
            ? 'Keep some first'
            : keptCount === 1 ? 'Breed from 1' : `Breed from ${keptCount}`}
        </Pressable>
        <Pressable onPress={onReroll}>Reroll</Pressable>
      </div>
    </section>
  );
}
