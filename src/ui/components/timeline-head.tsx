'use client';

import { useState, type JSX } from 'react';
import { clampBars, type TimelineSection } from '@/ui/timeline-geometry';

export type TimelineHeight = 'ribbon' | 'half' | 'full';

export const NEXT_HEIGHT: Readonly<Record<TimelineHeight, TimelineHeight>> = {
  ribbon: 'half', half: 'full', full: 'ribbon',
};

const HEIGHT_LABEL: Readonly<Record<TimelineHeight, string>> = {
  ribbon: '▾ ribbon', half: '▾ half', full: '▴ full',
};

export interface TimelineHeadProps {
  /** The section the steppers edit: the playhead's, else the selection's. */
  section: TimelineSection | null;
  height: TimelineHeight;
  onHeight: (h: TimelineHeight) => void;
  onAddSection: (afterId: string | null) => void;
  onEditSection: (id: string, patch: { name?: string; bars?: number }) => void;
  onRemoveSection: (id: string) => void;
  colour: string;
}

/** A square 44px action. Flat fill, hard border, no shadow inside a dense strip. */
function Step({
  label, glyph, onPress, wide = false,
}: { label: string; glyph: string; onPress: () => void; wide?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onPress}
      className="shrink-0 border-[3px] text-[11px] font-bold leading-none"
      style={{
        minWidth: wide ? '68px' : '44px',
        height: '44px',
        borderColor: 'var(--ink)',
        color: 'var(--ink)',
        background: 'transparent',
        touchAction: 'manipulation',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {glyph}
    </button>
  );
}

/**
 * The song pane's editing strip: which section, how long, add one, and the one
 * chevron that cycles RIBBON / HALF / FULL.
 *
 * Split out of timeline.tsx, which owns layout and hit-testing and had grown
 * past the house limit carrying this as well. Nothing here measures a pixel.
 */
export function TimelineHead({
  section, height, onHeight, onAddSection, onEditSection, onRemoveSection, colour,
}: TimelineHeadProps): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <header
      className="flex items-center gap-2 flex-wrap px-2 py-1 border-b-[3px]"
      style={{ borderColor: 'var(--ink)', background: 'var(--panel)', minHeight: '44px' }}
    >
      <span className="label" style={{ color: 'var(--ink)' }}>Song</span>

      {section !== null && (
        <>
          <input
            aria-label="Section name"
            value={draft ?? section.name}
            onChange={(e): void => setDraft(e.target.value)}
            onBlur={(): void => {
              if (draft !== null && draft !== section.name) {
                onEditSection(section.id, { name: draft });
              }
              setDraft(null);
            }}
            onKeyDown={(e): void => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            className="w-24 border-[3px] bg-transparent px-1.5 text-[11px] font-bold uppercase tracking-[0.08em]"
            style={{ borderColor: colour, color: 'var(--ink)', height: '44px' }}
          />
          <Step
            label={`Fewer bars in ${section.name}`}
            glyph="−"
            onPress={(): void => onEditSection(section.id, { bars: clampBars(section.bars - 1) })}
          />
          <span
            className="text-[11px] font-bold uppercase tracking-[0.08em] tabular-nums"
            style={{ color: 'var(--ink)' }}
          >
            {clampBars(section.bars)} bars
          </span>
          <Step
            label={`More bars in ${section.name}`}
            glyph="+"
            onPress={(): void => onEditSection(section.id, { bars: clampBars(section.bars + 1) })}
          />
          <Step
            label={`Remove section ${section.name}`}
            glyph="×"
            onPress={(): void => onRemoveSection(section.id)}
          />
        </>
      )}

      <Step
        label="Add a section"
        glyph="+ SEC"
        wide
        onPress={(): void => onAddSection(section?.id ?? null)}
      />

      <div className="flex-1" />

      <button
        type="button"
        aria-label={`Song view is ${height}. Tap for ${NEXT_HEIGHT[height]}.`}
        onClick={(): void => onHeight(NEXT_HEIGHT[height])}
        className="shrink-0 border-[3px] px-3 text-[10px] font-bold uppercase tracking-[0.12em]"
        style={{
          minHeight: '44px',
          minWidth: '44px',
          borderColor: 'var(--ink)',
          color: 'var(--ink)',
          background: 'transparent',
        }}
      >
        {HEIGHT_LABEL[height]}
      </button>
    </header>
  );
}
