'use client';

import { useCallback, useRef, useState, type JSX } from 'react';
import { EngineHost } from '@/audio/engine-host';
import { ANALOG_DESCRIPTOR } from '@/dsp/analog-descriptor';
import { Knob } from '@/ui/components/knob';
import { Keys } from '@/ui/components/keys';

const GROUPS = ['Oscillators', 'Filter', 'Envelope', 'Character'] as const;

export default function Page(): JSX.Element {
  const host = useRef<EngineHost | null>(null);
  const [started, setStarted] = useState(false);
  const [values, setValues] = useState<number[]>(
    ANALOG_DESCRIPTOR.params.map((p) => p.default),
  );

  const start = useCallback(async (): Promise<void> => {
    host.current ??= new EngineHost();
    await host.current.start();
    setStarted(true);
  }, []);

  const setParam = useCallback((index: number, value: number): void => {
    setValues((prev) => prev.map((v, i) => (i === index ? value : v)));
    host.current?.setParam(index, value);
  }, []);

  return (
    <main className="min-h-screen flex flex-col">
      <header
        className="flex items-center justify-between border-b-4 px-5 py-3"
        style={{ borderColor: 'var(--ink)' }}
      >
        <div className="flex items-center gap-2">
          <span className="w-4 h-4 rounded-full" style={{ background: 'var(--analog)' }} />
          <span className="w-4 h-4" style={{ background: 'var(--fm)' }} />
          <span
            style={{
              width: 0, height: 0,
              borderLeft: '8px solid transparent',
              borderRight: '8px solid transparent',
              borderBottom: '16px solid var(--physical)',
            }}
          />
          <h1 className="ml-3 font-bold uppercase tracking-tight text-lg">SIGIL</h1>
          <span className="label ml-2">Analog · 16 voice</span>
        </div>

        <button
          type="button"
          className="hard border-[3px] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.16em]"
          style={{
            borderColor: 'var(--ink)',
            background: started ? 'var(--panel)' : 'var(--analog)',
            color: started ? 'var(--ink)' : 'var(--bg)',
          }}
          onClick={(): void => { void start(); }}
        >
          {started ? 'Running' : 'Power'}
        </button>
      </header>

      <section className="flex-1 px-5 py-6">
        {GROUPS.map((group) => {
          const params = ANALOG_DESCRIPTOR.params
            .map((p, i) => ({ p, i }))
            .filter(({ p }) => p.group === group);
          if (params.length === 0) return null;
          return (
            <div key={group} className="mb-8">
              <div
                className="label border-b-[3px] pb-1.5 mb-4"
                style={{ borderColor: 'var(--muted)' }}
              >
                {group}
              </div>
              <div className="flex flex-wrap gap-7">
                {params.map(({ p, i }) => (
                  <Knob
                    key={p.id}
                    label={p.name}
                    value={values[i] ?? p.default}
                    min={p.min}
                    max={p.max}
                    unit={p.unit}
                    colour={ANALOG_DESCRIPTOR.colour}
                    onChange={(v): void => setParam(i, v)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </section>

      <Keys
        octave={4}
        onNoteOn={(m): void => host.current?.noteOn(m, 1)}
        onNoteOff={(m): void => host.current?.noteOff(m)}
      />
    </main>
  );
}
