'use client';

import type { JSX } from 'react';
import { Panel } from './panel';
import { noteName } from '@/dsp/chords';
import { useDragOutSupport, type DragHandleProps, type ExportItem } from '@/ui/use-drag-export';

export interface ExportTrayProps {
  items: readonly ExportItem[];
  dragProps: (id: string) => DragHandleProps;
  onDownload: (id: string) => void;
  onDownloadAll: () => void;
  onRemove: (id: string) => void;
  /** Engine identity colour. Drawn as a stripe, never as text colour. */
  accent?: string;
}

function formatDuration(ms: number): string {
  if (ms >= 10000) return `${Math.round(ms / 1000)}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** Chords get long; four names is enough to recognise the take. */
function formatNotes(notes: readonly number[]): string {
  if (notes.length === 0) return 'no notes';
  const shown = notes.slice(0, 4).map(noteName).join(' ');
  return notes.length > 4 ? `${shown} +${notes.length - 4}` : shown;
}

/** Six flat squares. A grip, drawn the way everything else here is drawn. */
function GripMark(): JSX.Element {
  return (
    <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true" focusable="false">
      <g fill="var(--ink)">
        <rect x="0" y="1" width="3" height="3" />
        <rect x="7" y="1" width="3" height="3" />
        <rect x="0" y="6.5" width="3" height="3" />
        <rect x="7" y="6.5" width="3" height="3" />
        <rect x="0" y="12" width="3" height="3" />
        <rect x="7" y="12" width="3" height="3" />
      </g>
    </svg>
  );
}

const BTN =
  'border-[3px] min-h-11 min-w-11 px-3 text-[10px] font-bold uppercase tracking-[0.14em]';

/**
 * The bounces you have made this session, kept where you can throw them at a
 * DAW. Drag-out is Chromium's `DownloadURL` trick and works nowhere else, so on
 * Safari and Firefox the rows stop pretending to be draggable and the Download
 * button becomes the loud one — a drag that silently does nothing is worse than
 * no drag at all.
 */
export function ExportTray({
  items, dragProps, onDownload, onDownloadAll, onRemove, accent,
}: ExportTrayProps): JSX.Element {
  const canDrag = useDragOutSupport();

  const actions = (
    <button
      type="button"
      onClick={onDownloadAll}
      disabled={items.length === 0}
      className={`${BTN} disabled:opacity-40`}
      style={{ borderColor: 'var(--ink)', background: 'transparent', color: 'var(--ink)' }}
    >
      Download all
    </button>
  );

  return (
    <Panel title={`Exports (${items.length})`} accent={accent} actions={actions}>
      {canDrag === true && (
        <p className="text-[11px] leading-snug mb-3" style={{ color: 'var(--ink)' }}>
          Drag a row straight into Ableton, FL Studio or the desktop. The WAV is written
          on drop — no download step.
        </p>
      )}

      {canDrag === false && (
        <p
          className="text-[11px] leading-snug mb-3 border-[3px] p-2.5"
          style={{ borderColor: 'var(--physical)', color: 'var(--ink)' }}
        >
          Drag-out into a DAW only works in Chrome, Edge and other Chromium browsers.
          In this browser, use Download — the file lands in your downloads folder and
          you drag it in from there.
        </p>
      )}

      {items.length === 0 ? (
        <p className="text-[11px] leading-snug" style={{ color: 'var(--ink)' }}>
          Nothing bounced yet. Hold a chord and hit Bounce WAV — every render lands here,
          named and ready to drop into a track.
        </p>
      ) : (
        <ul className="flex flex-col gap-2 max-h-80 overflow-y-auto">
          {items.map((item) => (
            <ExportRow
              key={item.id}
              item={item}
              canDrag={canDrag === true}
              dragProps={dragProps}
              onDownload={onDownload}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

interface ExportRowProps {
  item: ExportItem;
  canDrag: boolean;
  dragProps: (id: string) => DragHandleProps;
  onDownload: (id: string) => void;
  onRemove: (id: string) => void;
}

function ExportRow({
  item, canDrag, dragProps, onDownload, onRemove,
}: ExportRowProps): JSX.Element {
  const drag = canDrag ? dragProps(item.id) : null;
  const meta = `${item.engineId.toUpperCase()} · ${formatNotes(item.notes)} · ` +
    `${formatDuration(item.durationMs)} · ${formatSize(item.wav.length)}`;

  return (
    <li
      {...(drag ?? {})}
      className={`flex items-stretch border-[3px] ${canDrag ? 'cursor-grab active:cursor-grabbing' : ''}`}
      style={{ borderColor: 'var(--ink)', background: 'var(--bg)' }}
    >
      {canDrag && (
        <span
          aria-hidden="true"
          className="flex items-center justify-center w-11 shrink-0 border-r-[3px]"
          style={{ borderColor: 'var(--ink)' }}
        >
          <GripMark />
        </span>
      )}

      <div className="flex-1 min-w-0 px-2.5 py-2 flex flex-col justify-center gap-1">
        <span
          className="text-[11px] font-bold uppercase tracking-[0.06em] truncate"
          style={{ color: 'var(--ink)' }}
        >
          {item.name}
        </span>
        <span
          className="text-[10px] uppercase tracking-[0.1em] truncate"
          style={{ color: 'var(--ink)' }}
        >
          {meta}
        </span>
      </div>

      <button
        type="button"
        onClick={(): void => onDownload(item.id)}
        aria-label={`Download ${item.name}`}
        className="min-h-11 min-w-11 px-3 shrink-0 border-l-[3px] text-[10px] font-bold uppercase tracking-[0.14em]"
        style={{
          borderColor: 'var(--ink)',
          background: canDrag ? 'transparent' : 'var(--physical)',
          color: canDrag ? 'var(--ink)' : 'var(--bg)',
        }}
      >
        Get
      </button>

      <button
        type="button"
        onClick={(): void => onRemove(item.id)}
        aria-label={`Delete ${item.name}`}
        className="min-h-11 min-w-11 shrink-0 border-l-[3px] text-[13px] font-bold leading-none"
        style={{ borderColor: 'var(--ink)', background: 'transparent', color: 'var(--ink)' }}
      >
        ×
      </button>
    </li>
  );
}
