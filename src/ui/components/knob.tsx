'use client';

import { useCallback, useRef, type JSX } from 'react';

interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  colour: string;
  onChange: (value: number) => void;
}

function formatValue(value: number, unit: string): string {
  if (unit === 'hz') return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(0);
  if (unit === 'ms') return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : value.toFixed(0);
  if (unit === 'pct') return `${Math.round(value * 100)}`;
  return value.toFixed(2);
}

export function Knob({
  label, value, min, max, unit, colour, onChange,
}: KnobProps): JSX.Element {
  const dragging = useRef(false);
  const norm = (value - min) / (max - min);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!dragging.current) return;
      const fine = e.shiftKey ? 0.25 : 1;
      const next = Math.min(1, Math.max(0, norm + (-e.movementY / 200) * fine));
      onChange(min + next * (max - min));
    },
    [norm, min, max, onChange],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const angle = -135 + norm * 270;
  // 270 degrees of a circle with r=27: 2*pi*27 * 0.75
  const arcLength = norm * 127.23;

  return (
    <div className="flex flex-col items-center gap-1.5 select-none">
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${formatValue(value, unit)}`}
        className="w-16 h-16 cursor-ns-resize touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(e): void => {
          const step = (max - min) / 50;
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault();
            onChange(Math.min(max, value + step));
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault();
            onChange(Math.max(min, value - step));
          }
        }}
      >
        <svg viewBox="0 0 64 64" className="w-full h-full">
          <circle cx="32" cy="32" r="27" fill="var(--bg)" stroke="var(--ink)" strokeWidth="3" />
          <circle
            cx="32" cy="32" r="27" fill="none" stroke={colour} strokeWidth="5"
            strokeDasharray={`${arcLength} 400`}
            strokeLinecap="butt"
            transform="rotate(135 32 32)"
          />
          <line
            x1="32" y1="32" x2="32" y2="11"
            stroke="var(--ink)" strokeWidth="4" strokeLinecap="square"
            transform={`rotate(${angle} 32 32)`}
          />
        </svg>
      </div>
      <span className="label">{label}</span>
      <span className="text-xs font-bold" style={{ color: colour }}>
        {formatValue(value, unit)}
      </span>
    </div>
  );
}
