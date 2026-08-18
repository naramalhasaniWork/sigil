'use client';

import { useRef, type JSX } from 'react';
import { SigilWordmark } from './engine-mark';
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
  onPower: () => void;
  onToggleRecord: () => void;
  onBounce: () => void;
  onSampleFile: (file: File) => void;
}

export function AppHeader({
  engineName, sampleName, midiLabel, colour, running, recording, bouncing,
  holdProps, onMarkDoubleClick, snapshotState, onPower, onToggleRecord, onBounce, onSampleFile,
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
          className="flex items-center bg-transparent border-0 p-0"
          onDoubleClick={onMarkDoubleClick}
          {...holdProps}
        >
          <SigilWordmark size={21} />
        </button>
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
          className="hard border-[3px] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.16em]"
          style={{ borderColor: 'var(--ink)', color: 'var(--ink)' }}
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
