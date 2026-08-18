'use client';

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type JSX, type PointerEvent as ReactPointerEvent,
} from 'react';
import { TrackRow } from './track-row';
import { SectionHead } from './clip-block';
import { NEXT_HEIGHT, TimelineHead, type TimelineHeight } from './timeline-head';
import {
  barsFromDrag, clampBars, contentWidth, isDrag, layoutSections, playheadX, pxPerBar,
  sectionAtX, totalBars, trackAtY,
  type PlayheadPosition, type SectionBox, type TimelineCell, type TimelineSection,
  type TimelineTrack,
} from '@/ui/timeline-geometry';

export type { TimelineSection, TimelineTrack, TimelineCell, PlayheadPosition };
export type { TimelineHeight };

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
  /** A clip armed for tap-to-place. Every other cell becomes a landing spot. */
  pendingClipId: string | null;
  colour: string;
}

const ROW_H = 56;
const HEAD_H = 44;
const GUTTER_WIDE = 196;
const GUTTER_NARROW = 152;
const NARROW_PX = 560;
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
  onSetGain, pendingClipId, colour,
}: TimelineProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [available, setAvailable] = useState(0);

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

  const activeId = playhead?.sectionId ?? selected?.sectionId ?? sections[0]?.id ?? null;
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
      <TimelineHead
        section={active}
        height={height}
        onHeight={onHeight}
        onAddSection={onAddSection}
        onEditSection={onEditSection}
        onRemoveSection={onRemoveSection}
        colour={colour}
      />

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
                  active={box.id === (selected?.sectionId ?? activeId)}
                  playing={box.id === playhead?.sectionId}
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
                  pendingClipId={pendingClipId}
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

          {/* The playhead. It was a 3px hairline and people could not find it;
              it is now a 5px bar with a head on top, drawn over everything. */}
          {headX !== null && (
            <span
              aria-hidden="true"
              className="absolute top-0 bottom-0 z-30 pointer-events-none"
              style={{
                left: `${gutter + Math.round(headX) - 1}px`,
                width: '5px',
                background: 'var(--physical)',
                boxShadow: '0 0 0 1px var(--bg)',
              }}
            >
              <span
                className="absolute left-1/2 top-0"
                style={{
                  width: 0,
                  height: 0,
                  transform: 'translateX(-50%)',
                  borderLeft: '7px solid transparent',
                  borderRight: '7px solid transparent',
                  borderTop: '9px solid var(--physical)',
                }}
              />
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
