'use client';

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { ENGINES } from '@/dsp/registry';
import { useInstrument } from '@/ui/use-instrument';
import { useComputerKeyboard } from '@/ui/use-computer-keyboard';
import { useMidi } from '@/ui/use-midi';
import { EngineRail } from '@/ui/components/engine-rail';
import { AppHeader } from '@/ui/components/app-header';
import { ToastHost } from '@/ui/components/toast';
import { ExportTray } from '@/ui/components/export-tray';
import { useDragExport } from '@/ui/use-drag-export';
import { useEasterEggs, CreditsPanel } from '@/ui/components/easter-eggs';
import { useChordInput } from '@/ui/use-chord-input';
import { SetupPanel, type SetupSection } from '@/ui/components/setup-panel';
import { useKit } from '@/ui/use-kit';
import { useHandPlay } from '@/ui/use-hand-play';
import { useSecrets } from '@/ui/use-secrets';
import { noteName } from '@/dsp/chords';
import type { HandReading } from '@/ui/use-hand-control';
import { DEFAULT_PAD_CHORDS } from '@/dsp/midi-chords';
import { MacroRow } from '@/ui/components/macro-row';
import { XYPad } from '@/ui/components/xy-pad';
import { ParamGroups } from '@/ui/components/param-groups';
import { HuntGrid } from '@/ui/components/hunt-grid';
import { PadGrid } from '@/ui/components/pad-grid';
import { Keys } from '@/ui/components/keys';
import { ScalePicker, useScaleState } from '@/ui/components/scale-picker';
import { Scope } from '@/ui/components/scope';
import { Spectrum } from '@/ui/components/spectrum';
import { PresetPanel } from '@/ui/components/preset-panel';
import { SigilCard } from '@/ui/components/sigil-card';

type View = 'sculpt' | 'deep' | 'fx' | 'hunt' | 'export' | 'setup';

export default function Page(): JSX.Element {
  const inst = useInstrument();
  const [view, setView] = useState<View>('sculpt');
  const [octave, setOctave] = useState(4);
  const scaleState = useScaleState();

  const colour = inst.descriptor?.colour ?? '#FF6B6B';
  const tray = useDragExport();
  const kit = useKit();
  const [setupSection, setSetupSection] = useState<SetupSection>('kit');
  const showCamera = view === 'setup' && setupSection === 'camera';

  const engineDefaults = useMemo(() => {
    const params = inst.descriptor?.params;
    if (!params) return undefined;
    const out = new Float32Array(params.length);
    for (let i = 0; i < params.length; i++) out[i] = params[i]?.default ?? 0;
    return out;
  }, [inst.descriptor]);

  const secrets = useSecrets({
    values: inst.values,
    loadValues: inst.loadValues,
    defaults: engineDefaults,
    onReveal: (message): void => inst.setStatus(message),
    panic: inst.panic,
  });

  const eggs = useEasterEggs({
    onReveal: (_id, label): void => inst.setStatus(label),
    held: inst.held,
  });

  // Every bounce lands in the tray, so a take is never one missed click from gone.
  useEffect(() => {
    if (!inst.lastWav) return;
    tray.add({
      name: inst.lastWav.name,
      wav: inst.lastWav.bytes,
      engineId: inst.engineId,
      notes: [...inst.held],
      durationMs: 2600,
    });
    // lastWav is the trigger; tray.add is stable and re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst.lastWav]);

  /*
   * Chords is an instrument-wide mode, not a pad-grid feature. The pad grid
   * builds its own chords because it needs per-pad labels, so it stays on the
   * raw handlers; every other surface routes through this layer.
   */
  const chordConfig = useMemo(() => ({
    ...DEFAULT_PAD_CHORDS,
    mode: scaleState.mode === 'chords' ? ('scale-degree' as const) : ('off' as const),
    root: scaleState.root,
    scale: scaleState.scale,
  }), [scaleState.mode, scaleState.root, scaleState.scale]);

  const chordInput = useChordInput({
    config: chordConfig,
    onNoteOn: inst.noteOn,
    onNoteOff: inst.noteOff,
  });

  /*
   * Left hand plays through the SAME chord layer as the keys, so switching to
   * Chords means a pinch sounds a whole diatonic chord — which is what makes
   * progressions playable by hand.
   */
  const handPlay = useHandPlay({
    enabled: inst.started,
    root: scaleState.root,
    scale: scaleState.scale,
    baseOctave: octave,
    onNoteOn: chordInput.noteOn,
    onNoteOff: chordInput.noteOff,
  });

  const onHands = useCallback((left: HandReading | null, right: HandReading | null): void => {
    handPlay.update(left);
    if (right !== null) {
      inst.setMacro(1, right.x);
      inst.setMacro(0, right.y);
      inst.setMacro(2, right.pinch);
      inst.setMacro(3, right.spread);
    }
  }, [handPlay, inst]);

  useComputerKeyboard({
    onNoteOn: chordInput.noteOn,
    onNoteOff: chordInput.noteOff,
    octave,
    enabled: inst.started,
  });

  const midi = useMidi({
    onNoteOn: chordInput.noteOn,
    onNoteOff: chordInput.noteOff,
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
    <main className={`min-h-screen flex flex-col ${eggs.ritualClass}`}>
      <AppHeader
        engineName={inst.descriptor?.name}
        sampleName={inst.sampleName}
        midiLabel={midi.supported ? midi.deviceName : null}
        colour={colour}
        running={inst.started}
        recording={inst.recording}
        bouncing={inst.bouncing}
        holdProps={eggs.holdProps as unknown as Record<string, unknown>}
        onMarkDoubleClick={secrets.toggleAB}
        snapshotState={secrets.hasSnapshot ? (secrets.onSnapshot ? 'A' : 'B') : null}
        handPlaying={
          handPlay.current === null
            ? null
            : { note: noteName(handPlay.current), register: handPlay.register }
        }
        onPower={(): void => { void inst.start(); }}
        onToggleRecord={(): void => { void inst.toggleRecord(); }}
        onBounce={(): void => { void inst.bounceChord(); }}
        onSampleFile={(f): void => { void inst.loadSampleFile(f); }}
      />

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
            suggestedName={inst.suggestedName}
          />
        </aside>

        <section className="flex-1 min-w-0 flex flex-col">
          <div className="flex border-b-[3px]" style={{ borderColor: 'var(--ink)' }}>
            {(['sculpt', 'deep', 'fx', 'hunt', 'export', 'setup'] as const).map((v) => (
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
                <div className="w-full max-w-[300px] shrink-0 flex flex-col gap-4">
                  <XYPad
                    xLabel={inst.macroNames[1]}
                    yLabel={inst.macroNames[0]}
                    x={inst.macros[1]}
                    y={inst.macros[0]}
                    colour={colour}
                    onChange={onXY}
                  />
                  <SigilCard
                    sigil={inst.sigil}
                    trueName={inst.trueName}
                    suggestedName={inst.suggestedName}
                    trail={inst.trail}
                    colour={colour}
                    onSave={inst.savePreset}
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

            {/* Mounted always, parked off-screen when elsewhere, so the camera
                and its stream survive tab changes. */}
            <div
              aria-hidden={view !== 'setup'}
              style={view === 'setup' ? undefined : {
                position: 'fixed', left: -99999, top: 0,
                width: 900, height: 700, overflow: 'hidden', pointerEvents: 'none',
              }}
            >
              <SetupPanel
                audioContext={inst.host?.context ?? null}
                engineDescriptor={inst.descriptor}
                fxDescriptor={inst.fxDescriptor}
                magicDescriptor={inst.magicDescriptor}
                padChords={chordConfig}
                onPadChords={(next): void => {
                  scaleState.setMode(next.mode === 'off' ? 'notes' : 'chords');
                  scaleState.setRoot(((next.root % 12) + 12) % 12);
                  scaleState.setScale(next.scale);
                }}
                onParam={(address, value): void => inst.setParamByAddress(address, value)}
                onNoteOn={chordInput.noteOn}
                onNoteOff={chordInput.noteOff}
                enabled={inst.started}
                section={setupSection}
                onSection={setSetupSection}
                macroNames={inst.macroNames}
                kit={kit}
                colour={colour}
                bouncing={inst.bouncing}
                onRenderForKit={inst.renderCurrent}
                onHands={onHands}
                bounceMs={inst.bounceMs}
                onBounceMs={inst.setBounceMs}
              />
            </div>

            {view === 'export' && (
              <ExportTray
                items={tray.items}
                dragProps={tray.dragProps}
                onDownload={tray.download}
                onDownloadAll={tray.downloadAll}
                onRemove={tray.remove}
                accent={colour}
              />
            )}

            {view === 'hunt' && (
              <HuntGrid
                variations={inst.huntVariations.map((v) => ({
                  id: v.id,
                  title: v.title,
                  sigil: v.sigil,
                  changes: v.changes,
                  kept: v.kept,
                }))}
                auditioningId={inst.auditioningId}
                colour={colour}
                trail={inst.trail}
                tasteLabels={inst.tasteLabels}
                onAudition={inst.auditionVariation}
                onToggleKeep={inst.toggleKeep}
                onBreed={inst.breedKept}
                onReroll={inst.reroll}
                onForget={inst.forgetTaste}
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
          <button
            type="button"
            aria-label={
              inst.held.size > 0
                ? `Panic — release ${inst.held.size} sounding notes`
                : 'Panic — release all notes'
            }
            title="Releases every sounding note. Use it if a note hangs."
            className="hard border-[3px] px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.16em]"
            style={{
              borderColor: 'var(--ink)',
              background: inst.held.size > 0 ? '#FF3B30' : 'transparent',
              color: inst.held.size > 0 ? 'var(--bg)' : 'var(--ink)',
            }}
            onClick={secrets.panicPressed}
          >
            Panic{inst.held.size > 0 ? ` ${inst.held.size}` : ''}
          </button>
        </div>

        <ScalePicker state={scaleState} colour={colour} />
        {inst.layout === 'keys' ? (
          <Keys
            octave={octave}
            held={inst.held}
            scaleRoot={scaleState.root}
            scale={scaleState.scale}
            chords={scaleState.mode === 'chords'}
            onNoteOn={chordInput.noteOn}
            onNoteOff={chordInput.noteOff}
          />
        ) : (
          <PadGrid
            rows={4}
            cols={4}
            root={12 * octave + scaleState.root}
            scale={scaleState.scale}
            mode={scaleState.mode}
            colour={colour}
            onNoteOn={inst.noteOn}
            onNoteOff={inst.noteOff}
            heldPads={heldPads}
          />
        )}

      </footer>

      <ToastHost message={inst.status} colour={colour} />
      <CreditsPanel open={eggs.credits} onClose={eggs.closeCredits} />
    </main>
  );
}
