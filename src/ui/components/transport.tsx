'use client';

import type { JSX } from 'react';

interface TransportProps {
  running: boolean;
  recording: boolean;
  bouncing: boolean;
  colour: string;
  onPower: () => void;
  onToggleRecord: () => void;
  onBounce: () => void;
}

export function Transport({
  running, recording, bouncing, colour, onPower, onToggleRecord, onBounce,
}: TransportProps): JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <button
        type="button"
        aria-pressed={running}
        onClick={onPower}
        className="hard border-[3px] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.16em]"
        style={{
          borderColor: 'var(--ink)',
          background: running ? 'transparent' : colour,
          color: running ? 'var(--ink)' : 'var(--bg)',
        }}
      >
        {running ? 'On' : 'Power'}
      </button>

      <button
        type="button"
        aria-pressed={recording}
        aria-label={recording ? 'Stop recording' : 'Start recording'}
        disabled={!running}
        onClick={onToggleRecord}
        className="hard border-[3px] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.16em] disabled:opacity-40"
        style={{
          borderColor: 'var(--ink)',
          background: recording ? '#FF3B30' : 'transparent',
          color: recording ? 'var(--bg)' : 'var(--ink)',
        }}
      >
        {recording ? 'Stop' : 'Record'}
      </button>

      <button
        type="button"
        disabled={!running || bouncing}
        onClick={onBounce}
        className="hard border-[3px] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.16em] disabled:opacity-40"
        style={{ borderColor: 'var(--ink)', background: 'var(--physical)', color: 'var(--bg)' }}
      >
        {bouncing ? 'Bouncing…' : 'Bounce WAV'}
      </button>
    </div>
  );
}
