'use client';

import type { JSX } from 'react';

export interface Variation {
  id: string;
  name: string;
  /** Normalised 0..1 parameter values, used to draw the fingerprint. */
  fingerprint: readonly number[];
  kept: boolean;
}

interface HuntGridProps {
  variations: readonly Variation[];
  auditioningId: string | null;
  colour: string;
  onAudition: (id: string) => void;
  onToggleKeep: (id: string) => void;
  onBreed: () => void;
  onReroll: () => void;
  keptCount: number;
}

/**
 * Hunt: the machine proposes, you judge. No parameters on screen — each card
 * shows only a fingerprint of its patch, so you choose by ear, not by number.
 */
export function HuntGrid({
  variations, auditioningId, colour, onAudition, onToggleKeep, onBreed, onReroll, keptCount,
}: HuntGridProps): JSX.Element {
  return (
    <section aria-label="Hunt" className="flex flex-col gap-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {variations.map((v) => {
          const live = v.id === auditioningId;
          return (
            <div
              key={v.id}
              className="relative border-[3px] flex flex-col"
              style={{
                borderColor: v.kept || live ? colour : 'var(--ink)',
                borderWidth: v.kept ? 5 : 3,
                background: '#0A0A0A',
                boxShadow: live ? `5px 5px 0 0 ${colour}` : 'none',
              }}
            >
              {/* Kept is a hard corner flag: at a glance you can count what is
                  in the breeding pool without reading any button labels. */}
              {v.kept && (
                <span
                  aria-hidden="true"
                  className="absolute top-0 right-0"
                  style={{
                    width: 0, height: 0,
                    borderTop: `18px solid ${colour}`,
                    borderLeft: '18px solid transparent',
                  }}
                />
              )}
              {live && (
                <span
                  className="absolute top-1.5 left-2 text-[8px] font-bold uppercase tracking-[0.18em]"
                  style={{ color: colour }}
                >
                  ▶ Sounding
                </span>
              )}
              <button
                type="button"
                aria-label={`Audition ${v.name}`}
                className="p-3 text-left"
                onClick={(): void => onAudition(v.id)}
              >
                <svg viewBox="0 0 100 42" className="w-full h-12" aria-hidden="true">
                  {v.fingerprint.map((n, i) => {
                    const w = 100 / Math.max(1, v.fingerprint.length);
                    const h = Math.max(2, n * 38);
                    return (
                      <rect
                        key={i}
                        x={i * w + 1}
                        y={40 - h}
                        width={Math.max(1, w - 2)}
                        height={h}
                        fill={live || v.kept ? colour : '#3A3A38'}
                      />
                    );
                  })}
                </svg>
                <div className="label mt-2 truncate">{v.name}</div>
              </button>

              <button
                type="button"
                aria-pressed={v.kept}
                className="border-t-[3px] py-1.5 text-[9px] font-bold uppercase tracking-[0.18em]"
                style={{
                  borderColor: v.kept ? colour : 'var(--ink)',
                  background: v.kept ? colour : 'transparent',
                  color: v.kept ? 'var(--bg)' : 'var(--muted)',
                }}
                onClick={(): void => onToggleKeep(v.id)}
              >
                {v.kept ? '✓ In pool' : 'Keep'}
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          className="hard border-[3px] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.16em] disabled:opacity-40"
          style={{ borderColor: 'var(--ink)', background: colour, color: 'var(--bg)' }}
          disabled={keptCount < 1}
          onClick={onBreed}
        >
          {keptCount === 0
            ? 'Keep some first'
            : keptCount === 1 ? 'Breed from 1' : `Breed from ${keptCount}`}
        </button>
        <button
          type="button"
          className="hard border-[3px] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.16em]"
          style={{ borderColor: 'var(--ink)', background: 'transparent', color: 'var(--ink)' }}
          onClick={onReroll}
        >
          Reroll
        </button>
      </div>
    </section>
  );
}
