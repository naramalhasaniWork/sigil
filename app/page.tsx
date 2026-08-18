'use client';

import { useCallback, useMemo, useState, type JSX } from 'react';
import { ENGINES } from '@/dsp/registry';
import { useInstrument } from '@/ui/use-instrument';
import { useComputerKeyboard } from '@/ui/use-computer-keyboard';
import { useMidi } from '@/ui/use-midi';
import { EngineRail } from '@/ui/components/engine-rail';
import { SigilWordmark } from '@/ui/components/engine-mark';
import { Transport } from '@/ui/components/transport';
import { MacroRow } from '@/ui/components/macro-row';
import { XYPad } from '@/ui/components/xy-pad';
import { ParamGroups } from '@/ui/components/param-groups';
import { HuntGrid } from '@/ui/components/hunt-grid';
import { PadGrid } from '@/ui/components/pad-grid';
import { Keys } from '@/ui/components/keys';
import { Scope } from '@/ui/components/scope';
import { Spectrum } from '@/ui/components/spectrum';
import { PresetPanel } from '@/ui/components/preset-panel';

type View = 'sculpt' | 'deep' | 'fx' | 'hunt';

export default function Page(): JSX.Element {
  const inst = useInstrument();
  const [view, setView] = useState<View>('sculpt');
  const [octave, setOctave] = useState(4);

  const colour = inst.descriptor?.colour ?? '#FF6B6B';

  useComputerKeyboard({
    onNoteOn: inst.noteOn,
    onNoteOff: inst.noteOff,
    octave,
    enabled: inst.started,
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
          <SigilWordmark size={21} />
          <span className="label">{inst.descriptor?.name}</span>
          {midi.supported && midi.deviceName && (
            <span className="label" style={{ color: colour }}>MIDI · {midi.deviceName}</span>
          )}
          {inst.status && (
            <span
              className="text-[10px] font-bold uppercase tracking-[0.14em] border-[2px] px-2 py-1"
              style={{ borderColor: colour, color: colour }}
            >
              {inst.status}
            </span>
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
          <PresetPanel
            presets={inst.presets}
            userPresets={inst.userPresets}
            activeId={inst.activePresetId}
            colour={colour}
            onLoad={inst.loadPreset}
            onLoadUser={inst.loadUserPreset}
            onSave={inst.savePreset}
          />
        </aside>

        <section className="flex-1 min-w-0 flex flex-col">
          <div className="flex border-b-[3px]" style={{ borderColor: 'var(--ink)' }}>
            {(['sculpt', 'deep', 'fx', 'hunt'] as const).map((v) => (
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
              <ParamGroups
                descriptor={inst.descriptor}
                values={inst.values}
                colour={colour}
                onChange={inst.setParam}
              />
            )}

            {view === 'fx' && (
              <div className="flex flex-col lg:flex-row gap-8">
                <div className="flex-1 min-w-0">
                  <div className="label mb-3" style={{ color: colour }}>Chain</div>
                  <ParamGroups
                    descriptor={inst.fxDescriptor}
                    values={inst.fxValues}
                    colour={colour}
                    onChange={inst.setFxParam}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="label mb-3" style={{ color: 'var(--physical)' }}>Character</div>
                  <ParamGroups
                    descriptor={inst.magicDescriptor}
                    values={inst.magicValues}
                    colour="var(--physical)"
                    onChange={inst.setMagicParam}
                  />
                </div>
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
          <div className="flex items-center gap-1.5">
            <span className="label">Octave</span>
            <button
              type="button"
              aria-label="Octave down"
              className="hard border-[3px] w-9 h-8 text-sm font-bold leading-none"
              style={{ borderColor: 'var(--ink)', color: 'var(--ink)' }}
              onClick={(): void => setOctave((o) => Math.max(0, o - 1))}
            >
              −
            </button>
            <span
              className="border-[3px] px-2.5 h-8 flex items-center text-xs font-bold tabular-nums"
              style={{ borderColor: colour, color: colour }}
            >
              C{octave}
            </span>
            <button
              type="button"
              aria-label="Octave up"
              className="hard border-[3px] w-9 h-8 text-sm font-bold leading-none"
              style={{ borderColor: 'var(--ink)', color: 'var(--ink)' }}
              onClick={(): void => setOctave((o) => Math.min(8, o + 1))}
            >
              +
            </button>
            <span className="label ml-1 hidden sm:inline">[ ]</span>
          </div>
          <button type="button" className="label" onClick={inst.panic}>Panic</button>
        </div>

        {inst.layout === 'keys' ? (
          <Keys
            octave={octave}
            held={inst.held}
            onNoteOn={inst.noteOn}
            onNoteOff={inst.noteOff}
          />
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

      </footer>
    </main>
  );
}
