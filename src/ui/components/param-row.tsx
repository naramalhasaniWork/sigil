'use client';

import { useCallback, useRef, useState, type JSX } from 'react';

export interface ParamRowProps {
  name: string;
  value: number;
  /** Shift-click the readout to return here — the DAW convention. */
  defaultValue?: number;
  min: number;
  max: number;
  unit: string;
  curve: string;
  explain: string;
  colour: string;
  onChange: (value: number) => void;
}

function toNorm(value: number, min: number, max: number, curve: string): number {
  if (curve === 'exp' && min > 0) {
    return Math.log(value / min) / Math.log(max / min);
  }
  return (value - min) / (max - min);
}

function fromNorm(norm: number, min: number, max: number, curve: string): number {
  if (curve === 'exp' && min > 0) {
    return min * Math.pow(max / min, norm);
  }
  return min + norm * (max - min);
}

/**
 * Deep view row: the parameter, its exact value, and — required by the spec —
 * a plain-language explanation of why it matters. Dragging is for exploring,
 * typing is for finishing.
 */
/**
 * What a value looks like to a person, and how to read it back.
 *
 * `pct` parameters are stored 0..1 because that is what the DSP wants, and they
 * were being PRINTED that way too — "0.481 PCT", which is not a percentage, is
 * not 48%, and is not anything. 92 of the parameters in this instrument use
 * that unit, so it was most of every Deep and FX row.
 *
 * The scaling lives in one place and is used by the readout, the editor and the
 * value you type, so typing 48 gives you 48% rather than 4800%.
 */
const PCT_SCALE = 100;

function toDisplay(value: number, unit: string): number {
  return unit === 'pct' ? value * PCT_SCALE : value;
}

function fromDisplay(shown: number, unit: string): number {
  return unit === 'pct' ? shown / PCT_SCALE : shown;
}

/** The symbol, not the internal unit name. "PCT" is a code word, not a unit. */
function unitLabel(unit: string): string {
  if (unit === 'none') return '';
  if (unit === 'pct') return '%';
  return unit;
}

export function ParamRow({
  name, value, defaultValue, min, max, unit, curve, explain, colour, onChange,
}: ParamRowProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const dragging = useRef(false);
  const norm = Math.min(1, Math.max(0, toNorm(value, min, max, curve)));

  const commit = useCallback((): void => {
    const parsed = Number.parseFloat(draft);
    if (Number.isFinite(parsed)) {
      const real = fromDisplay(parsed, unit);
      onChange(Math.min(max, Math.max(min, real)));
    }
    setEditing(false);
  }, [draft, min, max, onChange, unit]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    const fine = e.shiftKey ? 0.2 : 1;
    const next = Math.min(1, Math.max(0, norm + (e.movementX / 260) * fine));
    onChange(fromNorm(next, min, max, curve));
  }, [norm, min, max, curve, onChange]);

  return (
    <div className="border-b-[3px] py-2.5" style={{ borderColor: '#2A2A28' }}>
      <div className="flex items-center gap-3">
        <span className="label w-28 shrink-0">{name}</span>

        <div
          role="slider"
          tabIndex={0}
          aria-label={name}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          className="flex-1 h-11 border-[3px] cursor-ew-resize touch-none relative"
          style={{ borderColor: 'var(--ink)', background: '#0A0A0A' }}
          onPointerDown={(e): void => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={onPointerMove}
          onPointerUp={(e): void => {
            dragging.current = false;
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onKeyDown={(e): void => {
            const step = e.shiftKey ? 0.002 : 0.02;
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
              e.preventDefault();
              onChange(fromNorm(Math.min(1, norm + step), min, max, curve));
            }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
              e.preventDefault();
              onChange(fromNorm(Math.max(0, norm - step), min, max, curve));
            }
          }}
        >
          <div
            className="absolute inset-y-0 left-0"
            style={{ width: `${norm * 100}%`, background: colour }}
          />
        </div>

        {editing ? (
          <input
            autoFocus
            className="w-20 h-11 shrink-0 border-[3px] bg-transparent px-1.5 text-xs font-bold"
            style={{ borderColor: colour, color: 'var(--ink)' }}
            value={draft}
            onChange={(e): void => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e): void => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="w-20 h-11 shrink-0 text-right text-xs font-bold tabular-nums"
            style={{ color: colour }}
            aria-label={`Edit ${name} value. Shift-click to reset to default.`}
            title="Click to type a value · Shift-click to reset to default"
            onClick={(e): void => {
              if (e.shiftKey && defaultValue !== undefined) {
                onChange(defaultValue);
                return;
              }
              setDraft(toDisplay(value, unit).toPrecision(4));
              setEditing(true);
            }}
          >
            {(() => {
              const shown = toDisplay(value, unit);
              return shown >= 1000 ? shown.toFixed(0) : shown.toPrecision(3);
            })()}
            <span className="label ml-1">{unitLabel(unit)}</span>
          </button>
        )}

        <button
          type="button"
          aria-expanded={open}
          aria-label={`What does ${name} do?`}
          className="w-11 h-11 shrink-0 border-[2px] text-[11px] font-bold"
          style={{ borderColor: open ? colour : 'var(--muted)', color: open ? colour : 'var(--ink)' }}
          onClick={(): void => setOpen((v) => !v)}
        >
          ?
        </button>
      </div>

      {open && (
        <p className="mt-2 pl-31 text-xs leading-relaxed" style={{ color: 'var(--ink)', opacity: 0.75 }}>
          {explain}
        </p>
      )}
    </div>
  );
}
