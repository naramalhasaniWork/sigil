'use client';

import { useState, type JSX } from 'react';
import type { KitHandle } from '@/ui/use-kit';

interface KitPanelProps {
  kit: KitHandle;
  colour: string;
  busy: boolean;
  /** Bounce ceiling in ms — the only size lever that costs no quality. */
  bounceMs: number;
  onBounceMs: (ms: number) => void;
  /** Renders the currently held sound and returns the bytes, or null on failure. */
  onRender: () => Promise<{ name: string; bytes: Uint8Array; durationMs: number } | null>;
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/**
 * The KO II handoff. Hold a chord, tap an empty pad, and that sound is rendered
 * onto it at the device's native rate; export drops a zip you drag into
 * Teenage Engineering's own EP Sample Tool. Deliberately one gesture per pad —
 * no drag targets, no modal, nothing to learn.
 */
const LENGTHS: readonly { ms: number; label: string }[] = [
  { ms: 800, label: 'Short' },
  { ms: 1400, label: 'Medium' },
  { ms: 2600, label: 'Long' },
  { ms: 4500, label: 'Very long' },
];

export function KitPanel({
  kit, colour, busy, bounceMs, onBounceMs, onRender,
}: KitPanelProps): JSX.Element {
  const [pending, setPending] = useState<number | null>(null);

  const fill = async (index: number): Promise<void> => {
    setPending(index);
    const rendered = await onRender();
    if (rendered) kit.assign(index, rendered.name, rendered.bytes, rendered.durationMs);
    setPending(null);
  };

  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1">
          <span className="label">Kit name</span>
          <input
            value={kit.kit.name}
            onChange={(e): void => kit.rename(e.target.value)}
            className="border-[3px] bg-transparent px-2 py-1.5 text-sm font-bold"
            style={{ borderColor: 'var(--ink)', color: 'var(--ink)' }}
          />
        </label>

        <div className="flex flex-col gap-1">
          <span className="label">Used</span>
          <span
            className="text-sm font-bold tabular-nums"
            style={{ color: kit.overCapacity ? '#FF3B30' : colour }}
          >
            {kit.filled}/{kit.kit.slots.length} pads · {sizeLabel(kit.bytes)}
          </span>
        </div>

        <button
          type="button"
          disabled={kit.filled === 0}
          onClick={kit.exportZip}
          className="hard border-[3px] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.16em] disabled:opacity-40"
          style={{ borderColor: 'var(--ink)', background: colour, color: 'var(--bg)' }}
        >
          Export kit .zip
        </button>

        <button
          type="button"
          disabled={kit.filled === 0}
          onClick={kit.clearAll}
          className="border-[3px] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.16em] disabled:opacity-40"
          style={{ borderColor: 'var(--muted)', color: 'var(--ink)' }}
        >
          Clear all
        </button>
      </div>

      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <span className="label">Sample length</span>
          <div className="flex gap-1.5">
            {LENGTHS.map((l) => {
              const active = bounceMs === l.ms;
              return (
                <button
                  key={l.ms}
                  type="button"
                  aria-pressed={active}
                  onClick={(): void => onBounceMs(l.ms)}
                  className="border-[3px] px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[0.14em]"
                  style={{
                    borderColor: active ? colour : 'var(--muted)',
                    background: active ? colour : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--ink)',
                  }}
                >
                  {l.label}
                </button>
              );
            })}
          </div>
        </div>
        <span className="label" style={{ color: 'var(--ink)' }}>
          ≈{Math.round((bounceMs / 1000) * 93.75)}KB max per pad
        </span>
      </div>

      <p className="text-xs leading-relaxed" style={{ color: 'var(--ink)', opacity: 0.75 }}>
        Hold a chord or note, then tap an empty pad — the sound is rendered onto it at the
        KO II&apos;s native 46 875 Hz / 16-bit. Export gives you a zip to drop into Teenage
        Engineering&apos;s EP Sample Tool.
      </p>

      <div className="grid grid-cols-4 gap-2">
        {kit.kit.slots.map((slot) => {
          const filled = slot.wav !== null;
          const isPending = pending === slot.index;
          return (
            <div
              key={slot.index}
              className="border-[3px] flex flex-col"
              style={{
                borderColor: filled ? colour : 'var(--muted)',
                background: '#0A0A0A',
                minHeight: 92,
              }}
            >
              <div className="flex items-center justify-between px-1.5 pt-1">
                <span className="label" style={{ color: 'var(--ink)' }}>
                  {String(slot.index + 1).padStart(2, '0')}
                </span>
                {filled && (
                  <button
                    type="button"
                    aria-label={`Clear pad ${slot.index + 1}`}
                    className="text-[11px] font-bold leading-none px-1"
                    style={{ color: 'var(--ink)' }}
                    onClick={(): void => kit.clear(slot.index)}
                  >
                    ×
                  </button>
                )}
              </div>

              {filled ? (
                <div className="flex-1 flex flex-col justify-end p-1.5 gap-0.5">
                  <span
                    className="text-[10px] font-bold uppercase leading-tight break-words"
                    style={{ color: colour }}
                  >
                    {slot.name}
                  </span>
                  <span className="label">
                    {(slot.durationMs / 1000).toFixed(1)}s · {sizeLabel(slot.wav?.length ?? 0)}
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  aria-label={`Render held sound onto pad ${slot.index + 1}`}
                  disabled={busy || isPending}
                  className="flex-1 w-full text-xl font-bold disabled:opacity-50"
                  style={{ color: 'var(--muted)' }}
                  onClick={(): void => { void fill(slot.index); }}
                >
                  {isPending ? '…' : '+'}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {kit.overCapacity && (
        <p className="text-xs font-bold" style={{ color: '#FF3B30' }}>
          This kit exceeds the KO II&apos;s 128 MB of memory. Clear a pad or shorten a sample.
        </p>
      )}
    </div>
  );
}
