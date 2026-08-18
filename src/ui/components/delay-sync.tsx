'use client';

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { EngineDescriptor } from '@/audio/types';
import {
  DIVISIONS, DEFAULT_DIVISION_ID, divisionById, divisionMs, nearestDivision, clampSynced,
} from '@/dsp/tempo';

/**
 * Locks the delay to the tempo.
 *
 * This writes to the `delay-time` parameter that already exists rather than
 * adding a synced mode to the DSP. The delay does not know it is in time; it is
 * simply being given the right number of milliseconds and given a new one
 * whenever the tempo moves. That keeps the render loop and the patch format
 * untouched, and means the plugin gets sync for free by doing the same
 * arithmetic against the host's transport.
 */

const STORE_KEY = 'sigil.delaySync';

interface Stored { readonly on: boolean; readonly divisionId: string }

function load(): Stored {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw === null) return { on: false, divisionId: DEFAULT_DIVISION_ID };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      on: parsed.on === true,
      divisionId: divisionById(parsed.divisionId ?? '') === undefined
        ? DEFAULT_DIVISION_ID
        : (parsed.divisionId as string),
    };
  } catch {
    return { on: false, divisionId: DEFAULT_DIVISION_ID };
  }
}

export function DelaySync({ descriptor, values, bpm, onChange, colour }: {
  descriptor: EngineDescriptor;
  values: Float32Array;
  /** Project tempo. From MIDI clock when a DAW is driving, else the loop pedal. */
  bpm: number;
  onChange: (index: number, value: number) => void;
  colour: string;
}): JSX.Element | null {
  const index = descriptor.params.findIndex((p) => p.id === 'delay-time');
  const param = index < 0 ? undefined : descriptor.params[index];

  const [state, setState] = useState<Stored>({ on: false, divisionId: DEFAULT_DIVISION_ID });
  const [hydrated, setHydrated] = useState(false);

  // Read storage after mount so the server-rendered markup and the first client
  // paint agree; hydrating straight from localStorage mismatches.
  useEffect(() => { setState(load()); setHydrated(true); }, []);

  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* fine */ }
  }, [state, hydrated]);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  /*
   * Re-apply whenever sync is on and the tempo moves. This is the whole point:
   * a delay that was set once at 120 and never updated is not synced, it is
   * coincidentally right.
   */
  const division = divisionById(state.divisionId);
  const wanted = division === undefined ? 0 : divisionMs(bpm, division.whole);
  const clamped = param === undefined
    ? { value: 0, outOfRange: false }
    : clampSynced(wanted, param.min, param.max);

  useEffect(() => {
    if (!state.on || index < 0 || wanted <= 0) return;
    onChangeRef.current(index, clamped.value);
  }, [state.on, index, wanted, clamped.value]);

  const toggle = useCallback((): void => {
    setState((prev) => {
      if (prev.on) return { ...prev, on: false };
      // Turning sync ON lands on whatever division is closest to what is
      // already sounding, so the delay does not jump the moment you enable it.
      const current = values[index] ?? 0;
      return { on: true, divisionId: nearestDivision(current, bpm).id };
    });
  }, [values, index, bpm]);

  if (param === undefined) return null;

  return (
    <div
      className="border-[3px] p-3 flex flex-col gap-2.5 mb-4"
      style={{ borderColor: state.on ? colour : 'var(--ink)', background: 'var(--panel)' }}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          aria-pressed={state.on}
          onClick={toggle}
          className="border-[3px] px-3 text-[10px] font-bold uppercase tracking-[0.16em]"
          style={{
            minHeight: 44,
            borderColor: 'var(--ink)',
            background: state.on ? colour : 'transparent',
            color: state.on ? 'var(--bg)' : 'var(--ink)',
          }}
        >
          Sync delay
        </button>

        <span className="label" style={{ color: 'var(--ink)' }}>
          {bpm.toFixed(1)} BPM
        </span>

        {state.on && (
          <span className="label" style={{ color: 'var(--ink)' }}>
            = {clamped.value.toFixed(0)} ms
          </span>
        )}
      </div>

      {state.on && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {DIVISIONS.map((d) => {
              const active = d.id === state.divisionId;
              return (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={active}
                  onClick={(): void => setState((p) => ({ ...p, divisionId: d.id }))}
                  className="border-[3px] px-2 text-[10px] font-bold uppercase tracking-[0.1em]"
                  // 44, like everything else. These were held at 36 to keep the
                  // chain above the fold on a phone — but "it saves scrolling"
                  // is not a reason to ship a target a thumb misses, and they
                  // wrap, so the cost is one more row.
                  style={{
                    minHeight: 44, minWidth: 44,
                    borderColor: 'var(--ink)',
                    background: active ? colour : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--ink)',
                  }}
                >
                  {d.label}
                </button>
              );
            })}
          </div>

          {/*
            A 1-bar delay at 40 BPM wants 6000 ms and the parameter stops at
            2000. Saying so is the difference between a range limit and what
            looks like a broken sync.
          */}
          {clamped.outOfRange && (
            <p className="text-[11px] leading-snug" style={{ color: 'var(--analog)' }}>
              {division?.label} at {bpm.toFixed(0)} BPM is {wanted.toFixed(0)} ms, past what the
              delay can hold. Held at {clamped.value.toFixed(0)} ms, so this one is not in time —
              pick a shorter division.
            </p>
          )}
        </>
      )}
    </div>
  );
}
