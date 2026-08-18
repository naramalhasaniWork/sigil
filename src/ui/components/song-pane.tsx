'use client';

import type { JSX } from 'react';
import type { SongDeck } from '@/ui/use-song';
import { SongTransport } from './song-transport';
import { Timeline, type TimelineHeight } from './timeline';

export interface SongPaneProps {
  deck: SongDeck;
  height: TimelineHeight;
  onHeight: (h: TimelineHeight) => void;
  /** Tapping an EMPTY cell asks for a note. Two taps: the +, then the pitch. */
  onPickNote: (cell: { trackId: string; sectionId: string }) => void;
  colour: string;
}

/**
 * The window, opened ABOVE the tab content rather than beside it — a timeline
 * is a wide, short object and the free space in SIGIL is wide and short.
 *
 * This is a container and nothing else: it holds the transport row over the
 * grid and hands both of them ids from the deck. It owns no state, does no
 * maths, and makes no sound.
 */
export function SongPane({
  deck, height, onHeight, onPickNote, colour,
}: SongPaneProps): JSX.Element {
  const { arr, transport, cells } = deck;
  const activeSectionId = transport.position?.sectionId
    ?? arr.selectedCell?.sectionId
    ?? arr.arrangement.sections[0]?.id
    ?? null;
  const activeSection = arr.arrangement.sections.find((s) => s.id === activeSectionId) ?? null;

  return (
    <div className="shrink-0 flex flex-col border-b-[3px]" style={{ borderColor: 'var(--ink)' }}>
      <SongTransport
        isPlaying={transport.isPlaying}
        /* play() takes an optional `fromBar`, so handing it to onClick
           directly passes React's event object as the bar number — which
           becomes NaN, and a NaN playhead is silently no playhead at all. */
        onPlay={(): void => transport.play()}
        onStop={(): void => transport.stop()}
        position={
          transport.position === null
            ? null
            : { bar: transport.position.bar, beat: transport.position.beat }
        }
        sectionName={activeSection?.name ?? null}
        bpm={arr.arrangement.tempo.bpm}
        onBpm={arr.setTempo}
        loopOn={transport.loopSectionId !== null}
        onToggleLoop={(): void => {
          transport.setLoopSection(
            transport.loopSectionId !== null ? null : activeSectionId,
          );
        }}
        colour={colour}
      />

      <Timeline
        sections={arr.sectionViews}
        tracks={arr.trackViews}
        cells={cells}
        beatsPerBar={arr.arrangement.tempo.beatsPerBar}
        playhead={transport.position}
        selected={arr.selectedCell}
        selectedTrackId={arr.selectedTrackId}
        height={height}
        onHeight={onHeight}
        onSelectTrack={arr.selectTrack}
        onSelectCell={(trackId, sectionId): void => {
          // The + on an empty cell is the shortest path to a note being in it:
          // tap it, choose a pitch, done. Never a modal, never a concept.
          const armed = deck.pendingClipId !== null;
          const empty = cells[trackId]?.[sectionId]?.clipId == null;
          deck.tapCell(trackId, sectionId);
          if (!armed && empty) onPickNote({ trackId, sectionId });
        }}
        onMoveClip={arr.moveClip}
        onClearCell={arr.clearCell}
        onAddSection={arr.addSection}
        onEditSection={arr.editSection}
        onRemoveSection={arr.removeSection}
        onToggleMute={arr.toggleMute}
        onToggleSolo={arr.toggleSolo}
        onSetGain={arr.setTrackGain}
        pendingClipId={deck.pendingClipId}
        colour={colour}
      />
    </div>
  );
}
