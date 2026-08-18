'use client';

import type { JSX } from 'react';
import { EngineMark } from './engine-mark';

export interface TrackSummary {
  id: string;
  name: string;
  engineId: string;
  colour: string;
  muted: boolean;
  soloed: boolean;
  /** Loaded, but this build cannot sound it. Drawn, never played. */
  unplayable?: boolean;
}

export interface TrackRailProps {
  tracks: readonly TrackSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
  onToggleMute: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onAdd: () => void;
  /** 0 disables + TRACK and shows the cap, which is a design, not a bug. */
  remainingSlots: number;
  colour: string;
}

/**
 * Who is in the song. The rail re-scopes from engines to tracks in SONG scope,
 * and EngineRail and PresetPanel stack underneath it unchanged — they read
 * "engine of the selected track" and "presets for it" without knowing that is
 * what they are doing, because their props were already selection-agnostic.
 *
 * flex-row on a phone, flex-col from md: the aside is already stacked above the
 * centre pane below md, so a column of tracks there would push the instrument
 * off the screen. Every row is 44px and every name is drawn in --ink, never
 * --muted, which fails AA on panel at this size.
 */
export function TrackRail({
  tracks, selectedId, onSelect, onToggleMute, onRename, onAdd, remainingSlots, colour,
}: TrackRailProps): JSX.Element {
  return (
    <nav
      aria-label="Tracks"
      className="flex flex-row md:flex-col overflow-x-auto md:overflow-x-visible
                 border-b-[3px] md:border-b-0"
      style={{ borderColor: 'var(--ink)' }}
    >
      {tracks.map((t) => {
        const active = t.id === selectedId;
        return (
          <div
            key={t.id}
            className="flex items-stretch shrink-0 border-r-[3px] md:border-r-0 md:border-b-[3px]"
            style={{ borderColor: 'var(--ink)', background: active ? t.colour : 'transparent' }}
          >
            <button
              type="button"
              aria-pressed={active}
              onClick={(): void => onSelect(t.id)}
              onDoubleClick={(): void => {
                const next = window.prompt('Track name', t.name);
                if (next !== null) onRename(t.id, next);
              }}
              className="flex items-center gap-2 px-2.5 text-left min-w-0"
              style={{
                minHeight: '44px',
                minWidth: '96px',
                color: active ? 'var(--bg)' : 'var(--ink)',
                touchAction: 'manipulation',
              }}
            >
              <EngineMark engineId={t.engineId} colour={active ? '#0E0E0E' : t.colour} size={18} />
              <span className="text-[11px] font-bold uppercase tracking-[0.08em] truncate">
                {t.name}
              </span>
              {t.unplayable === true && (
                <span className="text-[9px] font-bold" aria-label="Cannot be played on this build">
                  !
                </span>
              )}
            </button>
            <button
              type="button"
              aria-pressed={t.muted}
              aria-label={t.muted ? `Unmute ${t.name}` : `Mute ${t.name}`}
              onClick={(): void => onToggleMute(t.id)}
              className="shrink-0 border-l-[3px] text-[11px] font-bold leading-none"
              style={{
                width: '44px',
                minHeight: '44px',
                borderColor: active ? 'var(--bg)' : 'var(--ink)',
                background: t.muted ? '#FF3B30' : 'transparent',
                color: t.muted ? 'var(--bg)' : active ? 'var(--bg)' : 'var(--ink)',
                touchAction: 'manipulation',
              }}
            >
              M
            </button>
          </div>
        );
      })}

      <button
        type="button"
        onClick={onAdd}
        disabled={remainingSlots <= 0}
        aria-label={
          remainingSlots <= 0
            ? 'Track limit reached — eight tracks is the cap on this build'
            : `Add a track — ${remainingSlots} left`
        }
        title={
          remainingSlots <= 0
            ? 'Eight tracks is the cap: each one preallocates its own capture buffer.'
            : undefined
        }
        className="shrink-0 flex items-center justify-center gap-2 px-3
                   border-r-[3px] md:border-r-0 md:border-b-[3px]
                   text-[10px] font-bold uppercase tracking-[0.16em]"
        style={{
          minHeight: '44px',
          minWidth: '96px',
          borderColor: 'var(--ink)',
          color: remainingSlots <= 0 ? 'var(--ink)' : colour,
          opacity: remainingSlots <= 0 ? 0.4 : 1,
        }}
      >
        {remainingSlots <= 0 ? '8 max' : `+ track ${remainingSlots}`}
      </button>
    </nav>
  );
}
