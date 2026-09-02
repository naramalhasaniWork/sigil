'use client';

import { useRef, type JSX } from 'react';
import { AUTHOR_NAME, AUTHOR_URL, IS_PUBLIC } from '@/ui/public-mode';
import { SigilWordmark } from './engine-mark';
import { InstanceBadge } from './instance-badge';
import { Transport } from './transport';

interface AppHeaderProps {
  engineName: string | undefined;
  sampleName: string | null;
  midiLabel: string | null;
  colour: string;
  running: boolean;
  recording: boolean;
  bouncing: boolean;
  holdProps: Record<string, unknown>;
  /** Double-tap the mark to store and A/B a snapshot. */
  onMarkDoubleClick: () => void;
  /** 'A' while hearing the snapshot, 'B' while hearing live edits. */
  snapshotState: 'A' | 'B' | null;
  /** Live readout while the left hand is playing: note name and register. */
  handPlaying: { note: string; register: number } | null;
  onPower: () => void;
  onToggleRecord: () => void;
  onBounce: () => void;
  onSampleFile: (file: File) => void;
  /**
   * Which SIGIL this is, or null outside the plugin. See instance-badge.tsx:
   * with several instances in a project nothing else on screen tells them
   * apart, and the DAW's own device title cannot.
   */
  instance: { mark: number; name: string; onRename: (next: string) => void } | null;
}

export function AppHeader({
  engineName, sampleName, midiLabel, colour, running, recording, bouncing,
  holdProps, onMarkDoubleClick, snapshotState, handPlaying,
  onPower, onToggleRecord, onBounce, onSampleFile, instance,
}: AppHeaderProps): JSX.Element {
  const fileRef = useRef<HTMLInputElement | null>(null);

  return (
    <header
      className="flex items-center justify-between border-b-4 px-4 py-2.5 gap-3 flex-wrap"
      style={{ borderColor: 'var(--ink)' }}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          aria-label="SIGIL"
          className="flex items-center justify-center bg-transparent border-0"
          style={{ minHeight: '44px', minWidth: '44px' }}
          onDoubleClick={onMarkDoubleClick}
          {...holdProps}
        >
          <SigilWordmark size={21} />
        </button>

        {/* Immediately after the mark, because "which one is this" is the first
            question a second instance creates and the answer should not need
            looking for. */}
        {instance !== null && (
          <InstanceBadge
            mark={instance.mark}
            name={instance.name}
            onRename={instance.onRename}
          />
        )}

        {/*
          Byline, public build only. On the owner's own instance it would be
          telling him who made it.

          Sits beside the mark rather than in a footer because this interface
          has no footer to speak of — the bottom of the screen is the keyboard.
          Opens in a new tab, and carries rel="noopener" so the opened page
          cannot reach back through window.opener.
        */}
        {IS_PUBLIC && (
          <a
            href={AUTHOR_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="label flex items-center"
            style={{ minHeight: 44, color: 'var(--ink)', opacity: 0.7 }}
          >
            by {AUTHOR_NAME}
          </a>
        )}
        {snapshotState !== null && (
          <span
            className="border-[2px] px-1.5 py-0.5 text-[9px] font-bold tracking-[0.16em]"
            style={{ borderColor: colour, color: colour }}
          >
            {snapshotState}
          </span>
        )}
        <span className="label">{engineName}</span>
        {sampleName && (
          <span className="label" style={{ color: colour }}>◆ {sampleName}</span>
        )}
        {midiLabel && (
          <span className="label" style={{ color: colour }}>MIDI · {midiLabel}</span>
        )}
        {handPlaying && (
          <span
            className="border-[2px] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em]"
            style={{ borderColor: colour, color: colour }}
          >
            ✋ {handPlaying.note}
            {handPlaying.register !== 0 && (handPlaying.register > 0 ? ' +8va' : ' −8va')}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2.5">
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="sr-only"
          onChange={(e): void => {
            const f = e.target.files?.[0];
            if (f) onSampleFile(f);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="hard border-[3px] px-3 text-[10px] font-bold uppercase tracking-[0.16em]"
          style={{
            minHeight: '44px', minWidth: '44px',
            borderColor: 'var(--ink)', color: 'var(--ink)',
          }}
          onClick={(): void => fileRef.current?.click()}
        >
          Load Sample
        </button>

        <Transport
          running={running}
          recording={recording}
          bouncing={bouncing}
          colour={colour}
          onPower={onPower}
          onToggleRecord={onToggleRecord}
          onBounce={onBounce}
        />
      </div>
    </header>
  );
}
