'use client';

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type JSX, type PointerEvent as ReactPointerEvent,
} from 'react';
import { TrackRow } from './track-row';
import { SectionHead } from './clip-block';
import {
  barsFromDrag, clampBars, contentWidth, isDrag, layoutSections, playheadX, pxPerBar,
  sectionAtX, totalBars, trackAtY,
  type PlayheadPosition, type SectionBox, type TimelineCell, type TimelineSection,
  type TimelineTrack,
} from '@/ui/timeline-geometry';

export type { TimelineSection, TimelineTrack, TimelineCell, PlayheadPosition };

export type TimelineHeight = 'ribbon' | 'half' | 'full';

export interface TimelineProps {
  /** Array order IS the song. There is no separate order field. */
  sections: readonly TimelineSection[];
  tracks: readonly TimelineTrack[];
  /** cells[trackId][sectionId]. Dense — precomputed by use-arrangement. */
  cells: Readonly<Record<string, Readonly<Record<string, TimelineCell>>>>;
  beatsPerBar: number;
  playhead: PlayheadPosition | null;
  selected: { trackId: string; sectionId: string } | null;
  selectedTrackId: string;
  height: TimelineHeight;
  onHeight: (h: TimelineHeight) => void;
  onSelectTrack: (id: string) => void;
  onSelectCell: (trackId: string, sectionId: string) => void;
  onMoveClip: (clipId: string, toTrackId: string, toSectionId: string) => void;
  onClearCell: (trackId: string, sectionId: string) => void;
  onAddSection: (afterId: string | null) => void;
  onEditSection: (id: string, patch: { name?: string; bars?: number }) => void;
  onRemoveSection: (id: string) => void;
  onToggleMute: (id: string) => void;
  onToggleSolo: (id: string) => void;
  onSetGain: (id: string, gain: number) => void;
  colour: string;
}

const ROW_H = 56;
const HEAD_H = 44;
const GUTTER_WIDE = 196;
const GUTTER_NARROW = 152;
const NARROW_PX = 560;
const NEXT_HEIGHT: Readonly<Record<TimelineHeight, TimelineHeight>> = {
  ribbon: 'half', half: 'full', full: 'ribbon',
};

interface ClipDrag {
  kind: 'clip';
  clipId: string; fromTrackId: string; fromSectionId: string;
  startX: number; startY: number; moved: boolean;
  toTrackId: string | null; toSectionId: string | null;
}
interface ResizeDrag {
  kind: 'resize'; sectionId: string; startBars: number; startX: number; bars: number;
}
type Drag = ClipDrag | ResizeDrag | null;

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
 * The song, seen from above.
 *
 * A timeline is a wide, short object and SIGIL's free space is wide and short,
 * so this window opens ABOVE the tab content rather than beside it. It is a
 * table, not a canvas: sections are the grid, so there is no zoom, no snap
 * setting and no ruler — and the same object survives the trip to 375px.
 *
 * It owns exactly three things: layout, hit-testing and its three heights. It
 * never touches audio and never owns arrangement state. Every callback hands
 * back ids, never indices, and every measurement in pixels is computed here and
 * nowhere else.
 */
export function Timeline({
  sections, tracks, cells, beatsPerBar, playhead, selected, selectedTrackId,
  height, onHeight, onSelectTrack, onSelectCell, onMoveClip, onClearCell,
  onAddSection, onEditSection, onRemoveSection, onToggleMute, onToggleSolo,
  onSetGain, colour,
}: TimelineProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [available, setAvailable] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);

  const gutter = available > 0 && available < NARROW_PX ? GUTTER_NARROW : GUTTER_WIDE;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const measure = (): void => { setAvailable(el.clientWidth); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, []);

  /*
   * While a resize is in flight the grid lays out from the PREVIEW, so the
   * whole column follows the finger. The commit happens on pointerup, which
   * keeps one undo step per gesture instead of one per pixel.
   */
  const spans = useMemo<readonly TimelineSection[]>(() => (
    drag !== null && drag.kind === 'resize'
      ? sections.map((s) => (s.id === drag.sectionId ? { ...s, bars: drag.bars } : s))
      : sections
  ), [sections, drag]);

  const perBar = pxPerBar(totalBars(spans), Math.max(0, available - gutter));
  const boxes = useMemo(() => layoutSections(spans, perBar), [spans, perBar]);
  const laneWidth = contentWidth(boxes);

  const names = useMemo(() => {
    const out: Record<string, string> = {};
    for (const s of sections) out[s.id] = s.name;
    return out;
  }, [sections]);

  const activeId = selected?.sectionId ?? sections[0]?.id ?? null;
  const active = sections.find((s) => s.id === activeId) ?? null;
  const headX = playheadX(boxes, playhead, beatsPerBar, perBar);

  const setDragBoth = useCallback((next: Drag): void => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const onClipDragStart = useCallback((
    clipId: string, trackId: string, sectionId: string, e: ReactPointerEvent<HTMLElement>,
  ): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragBoth({
      kind: 'clip', clipId, fromTrackId: trackId, fromSectionId: sectionId,
      startX: e.clientX, startY: e.clientY, moved: false,
      toTrackId: trackId, toSectionId: sectionId,
    });
  }, [setDragBoth]);

  const onGrab = useCallback((box: SectionBox, e: ReactPointerEvent<HTMLElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragBoth({
      kind: 'resize', sectionId: box.id, startBars: box.bars, startX: e.clientX, bars: box.bars,
    });
  }, [setDragBoth]);

  /*
   * Move and release are handled on the window, not on the block. Pointer
   * capture keeps events flowing to the element that was pressed and they
   * still bubble to here, so a drag that leaves the timeline — or the viewport
   * — is tracked the whole way, and a pointer lost to a system gesture ends
   * the drag rather than leaving a clip stuck to the cursor.
   */
  useEffect(() => {
    if (drag === null) return;

    const move = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (d === null) return;
      if (d.kind === 'resize') {
        const bars = barsFromDrag(d.startBars, e.clientX - d.startX, perBar);
        if (bars !== d.bars) setDragBoth({ ...d, bars });
        return;
      }
      const moved = d.moved || isDrag(e.clientX - d.startX, e.clientY - d.startY);
      if (!moved) return;
      const lane = laneRef.current;
      const rows = rowsRef.current;
      if (lane === null || rows === null) return;
      const row = trackAtY(tracks.length, e.clientY - rows.getBoundingClientRect().top, ROW_H);
      const toTrackId = row === null ? null : tracks[row]?.id ?? null;
      const toSectionId = sectionAtX(boxes, e.clientX - lane.getBoundingClientRect().left);
      if (moved !== d.moved || toTrackId !== d.toTrackId || toSectionId !== d.toSectionId) {
        setDragBoth({ ...d, moved, toTrackId, toSectionId });
      }
    };

    const end = (): void => {
      const d = dragRef.current;
      setDragBoth(null);
      if (d === null) return;
      if (d.kind === 'resize') {
        if (d.bars !== d.startBars) onEditSection(d.sectionId, { bars: clampBars(d.bars) });
        return;
      }
      if (!d.moved || d.toTrackId === null || d.toSectionId === null) return;
      if (d.toTrackId === d.fromTrackId && d.toSectionId === d.fromSectionId) return;
      onMoveClip(d.clipId, d.toTrackId, d.toSectionId);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [drag, perBar, boxes, tracks, setDragBoth, onEditSection, onMoveClip]);

  const clipDrag = drag !== null && drag.kind === 'clip' && drag.moved ? drag : null;

  return (
    <section
      aria-label="Song"
      className="border-[3px] flex flex-col shrink-0"
      style={{ borderColor: 'var(--ink)', background: 'var(--bg)' }}
    >
      <header
        className="flex items-center gap-2 flex-wrap px-2 py-1 border-b-[3px]"
        style={{ borderColor: 'var(--ink)', background: 'var(--panel)', minHeight: '44px' }}
      >
        <span className="label" style={{ color: 'var(--ink)' }}>Song</span>

        {active !== null && (
          <>
            <input
              aria-label="Section name"
              value={draft ?? active.name}
              onChange={(e): void => setDraft(e.target.value)}
              onBlur={(): void => {
                if (draft !== null && draft !== active.name) onEditSection(active.id, { name: draft });
                setDraft(null);
              }}
              onKeyDown={(e): void => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              className="w-24 border-[3px] bg-transparent px-1.5 text-[11px] font-bold uppercase tracking-[0.08em]"
              style={{ borderColor: colour, color: 'var(--ink)', height: '44px' }}
            />
            <Step
              label={`Fewer bars in ${active.name}`}
              glyph="−"
              onPress={(): void => onEditSection(active.id, { bars: clampBars(active.bars - 1) })}
            />
            <span className="label tabular-nums" style={{ color: 'var(--ink)' }}>
              {clampBars(active.bars)} bars
            </span>
            <Step
              label={`More bars in ${active.name}`}
              glyph="+"
              onPress={(): void => onEditSection(active.id, { bars: clampBars(active.bars + 1) })}
            />
            <Step
              label={`Remove section ${active.name}`}
              glyph="×"
              onPress={(): void => onRemoveSection(active.id)}
            />
          </>
        )}

        <Step label="Add a section" glyph="+ SEC" wide onPress={(): void => onAddSection(activeId)} />

        <div className="flex-1" />

        <button
          type="button"
          aria-label={`Song view is ${height}. Tap for ${NEXT_HEIGHT[height]}.`}
          onClick={(): void => onHeight(NEXT_HEIGHT[height])}
          className="label px-3"
          style={{ color: 'var(--ink)', minHeight: '44px', minWidth: '44px' }}
        >
          {height}
        </button>
      </header>

      <div ref={scrollRef} className="overflow-x-auto" style={{ overscrollBehaviorX: 'contain' }}>
        <div className="relative" style={{ width: `${gutter + laneWidth}px` }}>
          <div
            className="flex items-stretch border-b-[3px]"
            style={{ borderColor: 'var(--ink)', height: `${HEAD_H}px` }}
          >
            <div
              className="sticky left-0 z-20 flex items-center px-3 shrink-0 border-r-[3px]"
              style={{ width: `${gutter}px`, borderColor: 'var(--ink)', background: 'var(--panel)' }}
            >
              <span className="label" style={{ color: 'var(--ink)' }}>
                {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}
              </span>
            </div>
            <div ref={laneRef} className="relative shrink-0" style={{ width: `${laneWidth}px` }}>
              {boxes.map((box) => (
                <SectionHead
                  key={box.id}
                  box={box}
                  name={names[box.id] ?? box.id}
                  height={HEAD_H}
                  active={box.id === activeId}
                  colour={colour}
                  onSelect={(): void => onSelectCell(selectedTrackId, box.id)}
                  onGrab={(e): void => onGrab(box, e)}
                />
              ))}
            </div>
          </div>

          {height !== 'ribbon' && (
            <div
              ref={rowsRef}
              style={height === 'half' ? { maxHeight: '38vh', overflowY: 'auto' } : undefined}
            >
              {tracks.map((track) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  cells={cells[track.id] ?? {}}
                  boxes={boxes}
                  sectionNames={names}
                  gutterWidth={gutter}
                  height={ROW_H}
                  selected={track.id === selectedTrackId}
                  selectedSectionId={selected?.trackId === track.id ? selected.sectionId : null}
                  dropSectionId={clipDrag?.toTrackId === track.id ? clipDrag.toSectionId : null}
                  draggingClipId={clipDrag?.clipId ?? null}
                  onSelectTrack={onSelectTrack}
                  onSelectCell={onSelectCell}
                  onClearCell={onClearCell}
                  onToggleMute={onToggleMute}
                  onToggleSolo={onToggleSolo}
                  onSetGain={onSetGain}
                  onClipDragStart={onClipDragStart}
                />
              ))}
            </div>
          )}

          {headX !== null && (
            <span
              aria-hidden="true"
              className="absolute top-0 bottom-0 z-30 pointer-events-none"
              style={{
                left: `${gutter + Math.round(headX)}px`,
                width: '3px',
                background: 'var(--physical)',
              }}
            />
          )}
        </div>
      </div>
    </section>
  );
}
