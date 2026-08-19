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
        className="hard border-[3px] px-4 text-[10px] font-bold uppercase tracking-[0.16em]"
        style={{
          minHeight: '44px',
          minWidth: '44px',
          borderColor: 'var(--ink)',
          /*
           * Filled when RUNNING. It was the other way round — filled while off
           * and outlined while on — and everywhere else in this instrument a
           * filled control means active. So the one button standing between a
           * new player and any sound at all was styled to look like it had
           * already been pressed.
           */
          background: running ? colour : 'transparent',
          color: running ? 'var(--bg)' : 'var(--ink)',
        }}
      >
        {/* "Start audio" rather than "Power": a browser cannot make a sound
            until a gesture allows it, and naming the outcome is what tells a
            first-time player this is the thing to press. */}
        {running ? 'On' : 'Start audio'}
      </button>

      <button
        type="button"
        aria-pressed={recording}
        aria-label={recording ? 'Stop recording' : 'Start recording'}
        disabled={!running}
        onClick={onToggleRecord}
        className="hard border-[3px] px-4 text-[10px] font-bold uppercase tracking-[0.16em] disabled:opacity-40"
        style={{
          minHeight: '44px',
          minWidth: '44px',
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
        className="hard border-[3px] px-4 text-[10px] font-bold uppercase tracking-[0.16em] disabled:opacity-40"
        style={{
          minHeight: '44px', minWidth: '44px',
          borderColor: 'var(--ink)', background: 'var(--physical)', color: 'var(--bg)',
        }}
      >
        {bouncing ? 'Bouncing…' : 'Bounce WAV'}
      </button>
    </div>
  );
}
