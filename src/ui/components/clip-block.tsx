'use client';

import type { JSX, PointerEvent as ReactPointerEvent } from 'react';
import {
  EDGE_GRIP_PX, type SectionBox, type TimelineCell,
} from '@/ui/timeline-geometry';

/**
 * The two hard blocks the lane is made of.
 *
 * Both are absolutely positioned from a `SectionBox`, so a block's x and width
 * ARE its bar position and bar length: a two-bar fill beside a sixteen-bar
 * verse is one eighth as wide, and the shape of the song is legible before a
 * single word is read.
 */

export interface ClipBlockProps {
  cell: TimelineCell;
  /** Lane coordinates, computed by Timeline. Nothing else computes pixels. */
  x: number;
  width: number;
  height: number;
  /** The track's engine identity colour, passed down. Never looked up here. */
  colour: string;
  selected: boolean;
  /** This block is the one being dragged: it goes ghost, the preview leads. */
  dragging: boolean;
  /** "Bass · drop" — the whole label a screen reader gets. */
  label: string;
  onSelect: () => void;
  onClear: () => void;
  onDragStart: (e: ReactPointerEvent<HTMLElement>) => void;
}

/** Below this a note count is unreadable and the block is better left a block. */
const COUNT_MIN_WIDTH = 64;
const INSET = 3;

/**
 * One cell of the song table.
 *
 * Density is a fill height, not a piano roll. You are being told "there is a
 * lot going on here" and nothing more precise, because the timeline has no note
 * editing at all: notes get in by being played, and out with UNDO PASS or CLEAR.
 */
export function ClipBlock({
  cell, x, width, height, colour, selected, dragging, label, onSelect, onClear, onDragStart,
}: ClipBlockProps): JSX.Element {
  const empty = cell.clipId === null;
  const face = cell.muted ? 'var(--muted)' : colour;
  const fill = Math.max(4, Math.round(cell.density * Math.max(0, height - INSET * 2 - 6)));

  return (
    <button
      type="button"
      aria-label={empty
        ? `${label}, empty`
        : `${label}, ${cell.noteCount} notes${cell.muted ? ', muted' : ''}`}
      aria-pressed={selected}
      className="absolute top-0 block text-left"
      style={{
        left: `${x}px`,
        width: `${width}px`,
        height: `${height}px`,
        border: 0,
        borderRadius: 0,
        // The column rule lives on the block, so the lane needs no separate
        // gridline layer and an empty cell is still a target you can hit.
        borderRight: '3px solid var(--bg)',
        background: empty ? 'transparent' : selected ? face : 'var(--panel)',
        opacity: dragging ? 0.35 : 1,
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        WebkitTapHighlightColor: 'transparent',
        cursor: empty ? 'pointer' : 'grab',
      }}
      onPointerDown={(e): void => {
        if (empty) return;
        // Kills text selection, the iOS long-press callout and page panning
        // before any of them can turn a clip move into a scroll.
        e.preventDefault();
        onDragStart(e);
      }}
      onClick={onSelect}
      onDoubleClick={(e): void => { if (!empty) { e.preventDefault(); onClear(); } }}
      onContextMenu={(e): void => { e.preventDefault(); }}
    >
      {!empty && (
        <>
          <span
            aria-hidden="true"
            className="absolute"
            style={{
              left: `${INSET}px`,
              right: `${INSET + 3}px`,
              bottom: `${INSET}px`,
              height: `${fill}px`,
              background: selected ? 'var(--bg)' : face,
            }}
          />
          {cell.playing && (
            <span
              aria-hidden="true"
              className="absolute left-0 right-0 top-0"
              style={{ height: '3px', background: 'var(--physical)' }}
            />
          )}
          {selected && (
            <span
              aria-hidden="true"
              className="absolute inset-0"
              style={{ boxShadow: 'inset 0 0 0 3px var(--ink)' }}
            />
          )}
          {width >= COUNT_MIN_WIDTH && (
            <span
              className="absolute label tabular-nums"
              style={{
                left: `${INSET + 4}px`,
                top: `${INSET + 3}px`,
                // --muted fails AA on panel at 9px. Ink, or the dark ground.
                color: selected ? 'var(--bg)' : 'var(--ink)',
              }}
            >
              {cell.noteCount}
            </span>
          )}
        </>
      )}
    </button>
  );
}

export interface SectionHeadProps {
  box: SectionBox;
  name: string;
  height: number;
  active: boolean;
  colour: string;
  onSelect: () => void;
  onGrab: (e: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * A section's name and length, plus the grab strip on its right edge.
 *
 * The edge drag is the direct-manipulation path; the 44px steppers in the strip
 * above are the accessible one. Both write the same single number, because a
 * section's bar count is the only length the model has — clips have no edge
 * handle at all, since a clip fills the cell it is in.
 */
export function SectionHead({
  box, name, height, active, colour, onSelect, onGrab,
}: SectionHeadProps): JSX.Element {
  return (
    <>
      <button
        type="button"
        aria-pressed={active}
        aria-label={`Section ${name}, ${box.bars} bars`}
        onClick={onSelect}
        className="absolute top-0 flex items-baseline gap-2 overflow-hidden border-r-[3px] px-3 text-left"
        style={{
          left: `${box.x}px`,
          width: `${box.width}px`,
          height: `${height}px`,
          borderColor: 'var(--bg)',
          background: active ? colour : 'var(--panel)',
          color: active ? 'var(--bg)' : 'var(--ink)',
          touchAction: 'manipulation',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span className="truncate text-[11px] font-bold uppercase tracking-[0.08em]">{name}</span>
        <span className="label tabular-nums" style={{ color: active ? 'var(--bg)' : 'var(--ink)' }}>
          {box.bars}
        </span>
      </button>
      <div
        role="separator"
        aria-label={`Resize ${name}`}
        className="absolute top-0"
        // Centred on the boundary, EDGE_GRIP_PX either side, matching the
        // tolerance edgeAtX hit-tests with so what is drawn and what is grabbed
        // cannot drift apart. This is the direct-manipulation path only — the
        // 44px steppers in the strip above are the one that has to be reachable.
        style={{
          left: `${box.x + box.width - EDGE_GRIP_PX}px`,
          width: `${EDGE_GRIP_PX * 2}px`,
          height: `${height}px`,
          cursor: 'ew-resize',
          touchAction: 'none',
        }}
        onPointerDown={(e): void => { e.preventDefault(); onGrab(e); }}
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-2"
          style={{
            right: `${EDGE_GRIP_PX - 1}px`,
            width: '3px',
            background: 'var(--ink)',
          }}
        />
      </div>
    </>
  );
}
