'use client';

import type { JSX } from 'react';
import type { Sigil } from '@/dsp/signature';
import { SigilGlyph } from './sigil-glyph';

export interface HuntCandidate {
  id: string;
  /** The patch's true name, read off its own parameters. */
  title: string;
  sigil: Sigil;
  /** Which way this one went: `Brighter`, `Longer tail`. Up to two. */
  changes: readonly string[];
  kept: boolean;
}

interface HuntCardProps {
  candidate: HuntCandidate;
  live: boolean;
  colour: string;
  onAudition: (id: string) => void;
  onToggleKeep: (id: string) => void;
}

/**
 * One candidate in a hunt.
 *
 * Three things, and only three: what it is (its mark), what it is called (its
 * true name), and which way it went (the one or two words that separate it from
 * what it grew out of). No parameters — you still choose by ear. But you now
 * choose by ear with a hypothesis, and that is the whole difference between
 * hunting and pulling a lever.
 */
export function HuntCard({
  candidate, live, colour, onAudition, onToggleKeep,
}: HuntCardProps): JSX.Element {
  const { id, title, sigil, changes, kept } = candidate;
  const marked = kept || live;

  return (
    <div
      className="relative border-[3px] flex flex-col"
      style={{
        borderColor: marked ? colour : 'var(--ink)',
        borderWidth: kept ? 5 : 3,
        background: 'var(--panel)',
        boxShadow: live ? `5px 5px 0 0 ${colour}` : 'none',
      }}
    >
      {/* Absolutely positioned so appearing does not reflow the card. A grid of
          six must not twitch when you audition one of them. */}
      {live && (
        <span
          className="absolute top-1.5 left-2 text-[8px] font-bold uppercase tracking-[0.18em]"
          style={{ color: colour }}
        >
          ▶ Sounding
        </span>
      )}

      {/* Kept is a hard corner flag: you can count the breeding pool at a glance
          without reading a single button label. */}
      {kept && (
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

      <button
        type="button"
        aria-label={`Audition ${title}${changes.length > 0 ? ` — ${changes.join(', ')}` : ''}`}
        className="flex-1 flex flex-col items-center justify-center gap-2 px-3 pt-4 pb-2.5 min-h-11"
        onClick={(): void => onAudition(id)}
      >
        <SigilGlyph sigil={sigil} colour={colour} size={64} dim={!marked} />

        <span
          className="text-[11px] font-bold uppercase tracking-[0.06em] text-center leading-tight"
          style={{ color: 'var(--ink)' }}
        >
          {title}
        </span>

        {/* The direction words. --ink, never --muted: this is the one thing on
            the card that has to be readable at 9px on a phone. */}
        <span className="flex flex-wrap justify-center gap-1">
          {changes.map((c) => (
            <span
              key={c}
              className="border-[2px] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]"
              style={{ borderColor: marked ? colour : 'var(--muted)', color: 'var(--ink)' }}
            >
              {c}
            </span>
          ))}
        </span>
      </button>

      <button
        type="button"
        aria-pressed={kept}
        aria-label={kept ? `Remove ${title} from the pool` : `Keep ${title}`}
        className="border-t-[3px] min-h-11 text-[9px] font-bold uppercase tracking-[0.18em]"
        style={{
          borderColor: kept ? colour : 'var(--ink)',
          background: kept ? colour : 'transparent',
          color: kept ? 'var(--bg)' : 'var(--ink)',
        }}
        onClick={(): void => onToggleKeep(id)}
      >
        {kept ? '✓ In pool' : 'Keep'}
      </button>
    </div>
  );
}
