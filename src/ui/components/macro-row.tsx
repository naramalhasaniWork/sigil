'use client';

import { useCallback, useRef, type JSX } from 'react';

export interface MacroRowProps {
  names: readonly [string, string, string, string];
  /** Normalised 0..1. */
  values: readonly [number, number, number, number];
  colour: string;
  onChange: (index: 0 | 1 | 2 | 3, value: number) => void;
}

const INK = '#F5F1E6';
const PAD_BG = '#0A0A0A';
const GRID = '#2A2A28';
const TICKS = [0.25, 0.5, 0.75];
const INDICES = [0, 1, 2, 3] as const;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

interface FaderProps {
  index: 0 | 1 | 2 | 3;
  name: string;
  value: number;
  colour: string;
  onChange: (index: 0 | 1 | 2 | 3, value: number) => void;
}

function Fader({ index, name, value, colour, onChange }: FaderProps): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pointer = useRef<number | null>(null);
  const box = useRef({ top: 0, height: 0 });
  const v = clamp01(value);
  const shown = Math.round(v * 100);

  const measure = useCallback((): void => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    box.current.top = r.top;
    box.current.height = r.height;
  }, []);

  const emit = useCallback((clientY: number): void => {
    const { top, height } = box.current;
    if (height === 0) return;
    onChange(index, clamp01(1 - (clientY - top) / height));
  }, [index, onChange]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (pointer.current !== null) return;
    e.preventDefault();
    pointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    trackRef.current?.focus({ preventScroll: true });
    measure();
    emit(e.clientY);
  }, [emit, measure]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (pointer.current !== e.pointerId) return;
    emit(e.clientY);
  }, [emit]);

  const endPointer = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (pointer.current !== e.pointerId) return;
    pointer.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 0.005 : 0.02;
    let next = v;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = v + step;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = v - step;
    else if (e.key === 'PageUp') next = v + 0.1;
    else if (e.key === 'PageDown') next = v - 0.1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 1;
    else return;
    e.preventDefault();
    onChange(index, clamp01(next));
  }, [index, onChange, v]);

  return (
    <div className="flex flex-col items-center gap-1.5 select-none min-w-[44px]">
      <span className="label">{name}</span>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shown}
        aria-valuetext={`${name} ${shown}`}
        aria-orientation="vertical"
        className="relative w-full min-w-[44px] h-40 overflow-hidden cursor-ns-resize"
        style={{
          border: `3px solid ${INK}`,
          background: PAD_BG,
          touchAction: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onKeyDown={onKeyDown}
        onContextMenu={(e): void => e.preventDefault()}
      >
        {TICKS.map((t) => (
          <div
            key={t}
            className="pointer-events-none absolute left-0 right-0"
            style={{ bottom: `${t * 100}%`, height: 1, background: GRID }}
          />
        ))}
        <div
          className="pointer-events-none absolute left-0 right-0 bottom-0"
          style={{
            height: `${v * 100}%`,
            background: colour,
            borderTop: `3px solid ${INK}`,
            boxSizing: 'border-box',
          }}
        />
      </div>
      <span className="text-xs font-bold tabular-nums" style={{ color: colour }}>
        {shown}
      </span>
    </div>
  );
}

export function MacroRow({ names, values, colour, onChange }: MacroRowProps): JSX.Element {
  return (
    <div className="grid grid-cols-4 gap-3 w-full">
      {INDICES.map((i) => (
        <Fader
          key={i}
          index={i}
          name={names[i]}
          value={values[i]}
          colour={colour}
          onChange={onChange}
        />
      ))}
    </div>
  );
}
