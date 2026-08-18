'use client';

import { useCallback, useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import { EngineMark } from './engine-mark';
import { ClipBlock } from './clip-block';
import type { SectionBox, TimelineCell, TimelineTrack } from '@/ui/timeline-geometry';

export interface TrackRowProps {
  track: TimelineTrack;
  /** cells[sectionId] for this track. Dense — every section has an entry. */
  cells: Readonly<Record<string, TimelineCell>>;
  boxes: readonly SectionBox[];
  sectionNames: Readonly<Record<string, string>>;
  /** px. Wide enough for the level bar above 176. Timeline decides. */
  gutterWidth: number;
  height: number;
  /** This row is the selected track: its patch is what the tabs below are editing. */
  selected: boolean;
  /** The selected cell's section, when the selected cell is on this track. */
  selectedSectionId: string | null;
  /** Where a clip being dragged would land if the pointer lifted now. */
  dropSectionId: string | null;
  draggingClipId: string | null;
  onSelectTrack: (id: string) => void;
  onSelectCell: (trackId: string, sectionId: string) => void;
  onClearCell: (trackId: string, sectionId: string) => void;
  onToggleMute: (id: string) => void;
  onToggleSolo: (id: string) => void;
  onSetGain: (id: string, gain: number) => void;
  onClipDragStart: (
    clipId: string, trackId: string, sectionId: string, e: ReactPointerEvent<HTMLElement>,
  ) => void;
}

const LEVEL_MIN_GUTTER = 176;
const EMPTY_CELL: TimelineCell = {
  clipId: null, density: 0, noteCount: 0, muted: false, playing: false,
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** M and S: two letters, flat fills, and 44px because this is played on a phone. */
function Toggle({
  letter, on, label, onColour, onPress,
}: {
  letter: string; on: boolean; label: string; onColour: string; onPress: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      onClick={onPress}
      className="shrink-0 border-[3px] text-[11px] font-bold leading-none"
      style={{
        width: '44px',
        height: '44px',
        borderColor: 'var(--ink)',
        background: on ? onColour : 'transparent',
        color: on ? 'var(--bg)' : 'var(--ink)',
        touchAction: 'manipulation',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {letter}
    </button>
  );
}

/**
 * One track: who it is on the left, what it plays on the right.
 *
 * The gutter is `position: sticky` so the identity of the row survives scrolling
 * the song sideways — losing track of which row you are looking at is the single
 * most common way a timeline goes wrong, and it costs one CSS property to fix.
 */
export function TrackRow({
  track, cells, boxes, sectionNames, gutterWidth, height, selected, selectedSectionId,
  dropSectionId, draggingClipId, onSelectTrack, onSelectCell, onClearCell,
  onToggleMute, onToggleSolo, onSetGain, onClipDragStart,
}: TrackRowProps): JSX.Element {
  const levelRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const face = track.unplayable ? 'var(--muted)' : track.colour;

  const setFromPointer = useCallback((clientX: number): void => {
    const el = levelRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    onSetGain(track.id, clamp01((clientX - rect.left) / rect.width));
  }, [onSetGain, track.id]);

  return (
    <div
      className="flex items-stretch border-b-[3px]"
      style={{ borderColor: 'var(--ink)', height: `${height}px` }}
    >
      <div
        className="sticky left-0 z-20 flex items-center gap-2 px-2 shrink-0 border-r-[3px]"
        style={{
          width: `${gutterWidth}px`,
          borderColor: 'var(--ink)',
          background: selected ? 'var(--panel)' : 'var(--bg)',
        }}
      >
        {selected && (
          <span aria-hidden="true" className="w-1.5 self-stretch shrink-0" style={{ background: face }} />
        )}
        <button
          type="button"
          aria-pressed={selected}
          onClick={(): void => onSelectTrack(track.id)}
          className="flex min-w-0 flex-1 flex-col justify-center gap-1 text-left"
          style={{ minHeight: '44px', touchAction: 'manipulation' }}
        >
          <span className="flex items-center gap-1.5 min-w-0">
            <EngineMark engineId={track.engineId} colour={face} size={16} />
            <span
              className="truncate text-[11px] font-bold uppercase tracking-[0.08em]"
              style={{ color: 'var(--ink)' }}
            >
              {track.name}
            </span>
          </span>
          {track.unplayable === true && (
            <span className="label" style={{ color: 'var(--ink)' }}>Silent</span>
          )}
        </button>

        {gutterWidth >= LEVEL_MIN_GUTTER && track.unplayable !== true && (
          <div
            ref={levelRef}
            role="slider"
            tabIndex={0}
            aria-label={`${track.name} level`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(track.gain * 100)}
            className="relative shrink-0 border-[3px] cursor-ew-resize"
            style={{
              width: '10px',
              height: '44px',
              borderColor: 'var(--ink)',
              background: 'var(--bg)',
              touchAction: 'none',
            }}
            onPointerDown={(e): void => {
              e.preventDefault();
              dragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              setFromPointer(e.clientX);
            }}
            onPointerMove={(e): void => {
              if (dragging.current) setFromPointer(e.clientX);
            }}
            onPointerUp={(e): void => {
              dragging.current = false;
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
              }
            }}
            onPointerCancel={(): void => { dragging.current = false; }}
            onKeyDown={(e): void => {
              const step = e.shiftKey ? 0.01 : 0.05;
              if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
                e.preventDefault();
                onSetGain(track.id, clamp01(track.gain + step));
              }
              if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
                e.preventDefault();
                onSetGain(track.id, clamp01(track.gain - step));
              }
            }}
          >
            <span
              aria-hidden="true"
              className="absolute inset-x-0 bottom-0"
              style={{ height: `${clamp01(track.gain) * 100}%`, background: face }}
            />
          </div>
        )}

        <Toggle
          letter="M"
          on={track.muted}
          label={`${track.muted ? 'Unmute' : 'Mute'} ${track.name}`}
          onColour="#FF3B30"
          onPress={(): void => onToggleMute(track.id)}
        />
        <Toggle
          letter="S"
          on={track.soloed}
          label={`${track.soloed ? 'Unsolo' : 'Solo'} ${track.name}`}
          onColour="var(--physical)"
          onPress={(): void => onToggleSolo(track.id)}
        />
      </div>

      <div className="relative shrink-0" style={{ width: `${boxes.reduce((w, b) => Math.max(w, b.x + b.width), 0)}px` }}>
        {boxes.map((box) => {
          const cell = cells[box.id] ?? EMPTY_CELL;
          const isDrop = dropSectionId === box.id;
          return (
            <div key={box.id} className="contents">
              <ClipBlock
                cell={cell}
                x={box.x}
                width={box.width}
                height={height - 3}
                colour={face}
                selected={selected && selectedSectionId === box.id}
                dragging={cell.clipId !== null && cell.clipId === draggingClipId}
                label={`${track.name} · ${sectionNames[box.id] ?? box.id}`}
                onSelect={(): void => onSelectCell(track.id, box.id)}
                onClear={(): void => onClearCell(track.id, box.id)}
                onDragStart={(e): void => {
                  if (cell.clipId !== null) onClipDragStart(cell.clipId, track.id, box.id, e);
                }}
              />
              {isDrop && (
                <span
                  aria-hidden="true"
                  className="absolute top-0 pointer-events-none"
                  style={{
                    left: `${box.x}px`,
                    width: `${box.width - 3}px`,
                    height: `${height - 3}px`,
                    boxShadow: 'inset 0 0 0 3px var(--physical)',
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
