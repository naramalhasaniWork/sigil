'use client';

import { useCallback, useMemo, useState, type JSX } from 'react';
import { ENGINES } from '@/dsp/registry';
import { useInstrument } from '@/ui/use-instrument';
import { useComputerKeyboard } from '@/ui/use-computer-keyboard';
import { useMidi } from '@/ui/use-midi';
import { EngineRail } from '@/ui/components/engine-rail';
import { SigilMark } from '@/ui/components/engine-mark';
import { Transport } from '@/ui/components/transport';
import { MacroRow } from '@/ui/components/macro-row';
import { XYPad } from '@/ui/components/xy-pad';
import { ParamRow } from '@/ui/components/param-row';
import { HuntGrid } from '@/ui/components/hunt-grid';
import { PadGrid } from '@/ui/components/pad-grid';
import { Keys } from '@/ui/components/keys';
import { Scope } from '@/ui/components/scope';
import { Spectrum } from '@/ui/components/spectrum';

type View = 'sculpt' | 'deep' | 'hunt';

export default function Page(): JSX.Element {
  const inst = useInstrument();
  const [view, setView] = useState<View>('sculpt');
  const [octave, setOctave] = useState(4);

  const colour = inst.descriptor?.colour ?? '#FF6B6B';

  useComputerKeyboard({
    onNoteOn: inst.noteOn,
    onNoteOff: inst.noteOff,
    octave,
    enabled: inst.started && inst.layout === 'keys',
  });

  const midi = useMidi({
    onNoteOn: inst.noteOn,
    onNoteOff: inst.noteOff,
    enabled: inst.started,
  });

  const engineSummaries = useMemo(
    () => ENGINES.map((e) => ({
      id: e.descriptor.id,
      name: e.descriptor.name,
      colour: e.descriptor.colour,
    })),
    [],
  );

  const groups = useMemo(() => {
    const seen: string[] = [];
    for (const p of inst.descriptor?.params ?? []) {
      if (!seen.includes(p.group)) seen.push(p.group);
    }
    return seen;
  }, [inst.descriptor]);

  const onXY = useCallback((x: number, y: number): void => {
    inst.setMacro(1, x);
    inst.setMacro(0, y);
  }, [inst]);

  const heldPads = useMemo(() => new Set<number>(), []);

  return (
    <main className="min-h-screen flex flex-col">
      <header
        className="flex items-center justify-between border-b-4 px-4 py-2.5 gap-3 flex-wrap"
        style={{ borderColor: 'var(--ink)' }}
      >
        <div className="flex items-center gap-2.5">
          <SigilMark size={20} />
          <span className="font-bold uppercase tracking-tight text-base">SIGIL</span>
          <span className="label">{inst.descriptor?.name}</span>
          {midi.supported && midi.deviceName && (
            <span className="label" style={{ color: colour }}>MIDI · {midi.deviceName}</span>
          )}
        </div>

        <Transport
          running={inst.started}
          recording={inst.recording}
          bouncing={inst.bouncing}
          colour={colour}
          onPower={(): void => { void inst.start(); }}
          onToggleRecord={(): void => { void inst.toggleRecord(); }}
          onBounce={(): void => { void inst.bounceChord(); }}
        />
      </header>

      <div className="flex flex-1 min-h-0 flex-col md:flex-row">
        <aside className="md:w-40 border-b-4 md:border-b-0 md:border-r-4" style={{ borderColor: 'var(--ink)' }}>
          <EngineRail
            engines={engineSummaries}
            activeId={inst.engineId}
            onSelect={inst.selectEngine}
          />
          <div className="p-2.5 border-t-4" style={{ borderColor: 'var(--ink)' }}>
            <div className="label mb-2">Presets</div>
            <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
              {inst.presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="text-left text-[11px] font-bold uppercase tracking-[0.06em] py-1"
                  style={{ color: 'var(--muted)' }}
                  onClick={(): void => inst.loadPreset(p.id)}
                >
                  {p.name}
                </button>
              ))}
              {inst.presets.length === 0 && (
                <span className="label">None for this engine yet</span>
              )}
            </div>
          </div>
        </aside>

        <section className="flex-1 min-w-0 flex flex-col">
          <div className="flex border-b-[3px]" style={{ borderColor: 'var(--ink)' }}>
            {(['sculpt', 'deep', 'hunt'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={(): void => { setView(v); if (v === 'hunt' && inst.huntVariations.length === 0) inst.reroll(); }}
                className="px-4 py-2 text-[10px] font-bold uppercase tracking-[0.18em] border-r-[3px]"
                style={{
                  borderColor: 'var(--ink)',
                  background: view === v ? colour : 'transparent',
                  color: view === v ? 'var(--bg)' : 'var(--muted)',
                }}
              >
                {v}
              </button>
            ))}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            {view === 'sculpt' && (
              <div className="flex flex-col md:flex-row gap-5 items-start">
                <div className="w-full max-w-[300px] shrink-0">
                  <XYPad
                    xLabel={inst.macroNames[1]}
                    yLabel={inst.macroNames[0]}
                    x={inst.macros[1]}
                    y={inst.macros[0]}
                    colour={colour}
                    onChange={onXY}
                  />
                </div>
                <div className="flex-1 min-w-0 flex flex-col gap-5">
                  <MacroRow
                    names={inst.macroNames}
                    values={inst.macros}
                    colour={colour}
                    onChange={inst.setMacro}
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="h-32">
                      <Scope analyser={inst.host?.analyser ?? null} colour={colour} />
                    </div>
                    <div className="h-32">
                      <Spectrum analyser={inst.host?.analyser ?? null} colour={colour} />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {view === 'deep' && inst.descriptor && inst.values && (
              <div className="max-w-3xl">
                {groups.map((group) => (
                  <div key={group} className="mb-6">
                    <div className="label border-b-[3px] pb-1.5 mb-2" style={{ borderColor: 'var(--muted)' }}>
                      {group}
                    </div>
                    {inst.descriptor?.params.map((p, i) => (
                      p.group === group ? (
                        <ParamRow
                          key={p.id}
                          name={p.name}
                          value={inst.values?.[i] ?? p.default}
                          min={p.min}
                          max={p.max}
                          unit={p.unit}
                          curve={p.curve}
                          explain={p.explain}
                          colour={colour}
                          onChange={(v): void => inst.setParam(i, v)}
                        />
                      ) : null
                    ))}
                  </div>
                ))}
              </div>
            )}

            {view === 'hunt' && (
              <HuntGrid
                variations={inst.huntVariations.map((v) => ({
                  id: v.id,
                  name: v.name,
                  fingerprint: Array.from(v.patch.values).slice(0, 12).map((val, i) => {
                    const p = inst.descriptor?.params[i];
                    if (!p) return 0.5;
                    return Math.min(1, Math.max(0, (val - p.min) / (p.max - p.min)));
                  }),
                  kept: v.kept,
                }))}
                auditioningId={null}
                colour={colour}
                onAudition={inst.auditionVariation}
                onToggleKeep={inst.toggleKeep}
                onBreed={inst.breedKept}
                onReroll={inst.reroll}
                keptCount={inst.huntVariations.filter((v) => v.kept).length}
              />
            )}
          </div>
        </section>
      </div>

      <footer className="border-t-4" style={{ borderColor: 'var(--ink)' }}>
        <div className="flex items-center justify-between px-3 py-1.5 border-b-[3px]" style={{ borderColor: '#2A2A28' }}>
          <div className="flex gap-1.5">
            {(['keys', 'pads'] as const).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={inst.layout === l}
                onClick={(): void => inst.chooseLayout(l)}
                className="border-[2px] px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.16em]"
                style={{
                  borderColor: inst.layout === l ? colour : 'var(--muted)',
                  color: inst.layout === l ? colour : 'var(--muted)',
                }}
              >
                {l}
              </button>
            ))}
          </div>
          {inst.layout === 'keys' && (
            <div className="flex items-center gap-2">
              <button type="button" className="label" onClick={(): void => setOctave((o) => Math.max(0, o - 1))}>− OCT</button>
              <span className="label" style={{ color: colour }}>{octave}</span>
              <button type="button" className="label" onClick={(): void => setOctave((o) => Math.min(8, o + 1))}>+ OCT</button>
            </div>
          )}
          <button type="button" className="label" onClick={inst.panic}>Panic</button>
        </div>

        {inst.layout === 'keys' ? (
          <Keys octave={octave} onNoteOn={inst.noteOn} onNoteOff={inst.noteOff} />
        ) : (
          <PadGrid
            rows={4}
            cols={4}
            root={48}
            scale="minor"
            mode="chords"
            colour={colour}
            onNoteOn={inst.noteOn}
            onNoteOff={inst.noteOff}
            heldPads={heldPads}
          />
        )}

        {inst.status && (
          <div className="px-3 py-1.5 label border-t-[3px]" style={{ borderColor: '#2A2A28' }}>
            {inst.status}
          </div>
        )}
      </footer>
    </main>
  );
}
