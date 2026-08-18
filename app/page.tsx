'use client';

import { Fragment, useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { ENGINES } from '@/dsp/registry';
import { useInstrument } from '@/ui/use-instrument';
import { useComputerKeyboard } from '@/ui/use-computer-keyboard';
import { useMidi } from '@/ui/use-midi';
import { EngineRail } from '@/ui/components/engine-rail';
import { AppHeader } from '@/ui/components/app-header';
import { ToastHost } from '@/ui/components/toast';
import { InstallPrompt } from '@/ui/components/install-prompt';
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
import { DelaySync } from '@/ui/components/delay-sync';
import { ScopeSwitch } from '@/ui/components/scope-switch';
import { TrackRail } from '@/ui/components/track-rail';
import { LoopStrip } from '@/ui/components/loop-strip';
import { CellStrip } from '@/ui/components/cell-strip';
import { NotePicker } from '@/ui/components/note-picker';
import { SongPane } from '@/ui/components/song-pane';
import type { TimelineHeight } from '@/ui/components/timeline';
import { useSong } from '@/ui/use-song';
import { useShortcuts } from '@/ui/use-shortcuts';
import { shortcutHandlers, buildCommands, type SigilActions } from '@/ui/sigil-commands';
import { ShortcutHelp } from '@/ui/components/shortcut-help';
import { CommandPalette } from '@/ui/components/command-palette';
import { usePatchHistory } from '@/ui/use-patch-history';
import { HistoryButtons } from '@/ui/components/history-buttons';
import type { PatchSnapshot } from '@/ui/patch-snapshot';

type View = 'sculpt' | 'deep' | 'fx' | 'hunt' | 'export' | 'setup';

/** Stand-in while an engine's values are still settling. Never played from. */
const NO_VALUES = new Float32Array(0);

export default function Page(): JSX.Element {
  const inst = useInstrument();
  const song = useSong(inst);
  const [view, setView] = useState<View>('sculpt');
  const [octave, setOctave] = useState(4);
  const scaleState = useScaleState();

  const songScope = song.arr.scope === 'song';

  /*
   * The grid has three heights and one chevron, no drag handle. A phone opens
   * at RIBBON because a phone is tall and the instrument has to stay reachable;
   * a desktop opens at HALF, so the song and the sound are visible at once.
   */
  const [gridHeight, setGridHeight] = useState<TimelineHeight>('half');
  useEffect(() => {
    if (window.matchMedia('(max-width: 767px)').matches) setGridHeight('ribbon');
  }, []);

  /*
   * Nothing is permanently in the way. In SONG scope the instrument tabs fold
   * to the SIDE rather than occupying the centre, the engine rail and preset
   * list fold away, and the keyboard folds down — each in one tap, each back in
   * one tap.
   */
  const [railOpen, setRailOpen] = useState(true);
  const [keysOpen, setKeysOpen] = useState(true);
  const [sideOpen, setSideOpen] = useState(false);
  /** The cell waiting for a note. Non-null means the picker is up. */
  const [pickerCell, setPickerCell] = useState<{ trackId: string; sectionId: string } | null>(null);

  /** The two keyboard surfaces. Both are dialogs; only one is ever up. */
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const colour = inst.descriptor?.colour ?? '#FF6B6B';
  const tray = useDragExport();
  const kit = useKit();
  const [setupSection, setSetupSection] = useState<SetupSection>('camera');
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

  /*
   * Every note the player makes goes through the deck, not straight to the
   * instrument: it sounds immediately AND is offered to the loop pedal, which
   * writes it down only when REC is lit. That is the whole "hit REC, play, you
   * have a clip" path, and it must not care which surface the note came from.
   */
  const chordInput = useChordInput({
    config: chordConfig,
    onNoteOn: song.noteOn,
    onNoteOff: song.noteOff,
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

  /*
   * The sound, as one value. Everything that can change a patch — knobs,
   * macros, the XY pad, presets, Hunt, the randomiser, MIDI learn — ends up
   * here, which is why undo watches this rather than wrapping twelve callers
   * and forgetting the thirteenth.
   */
  const snapshot: PatchSnapshot = useMemo(() => ({
    engineId: inst.engineId,
    values: inst.values ?? NO_VALUES,
    fx: inst.fxValues,
    magic: inst.magicValues,
    macros: inst.macros,
    presetId: inst.activePresetId,
  }), [
    inst.engineId, inst.values, inst.fxValues,
    inst.magicValues, inst.macros, inst.activePresetId,
  ]);

  const history = usePatchHistory(snapshot, inst.restorePatch);

  /*
   * Putting the stored session back is not an edit. Re-basing here is what
   * stops the first undo of a session from discarding the sound you opened
   * the app to keep working on.
   */
  const { clear: clearHistory } = history;
  useEffect(() => {
    if (inst.hydrated) clearHistory();
  }, [inst.hydrated, clearHistory]);

  const showTab = useCallback((v: View): void => {
    setView(v);
    // In SONG scope the tabs live in the side panel, so choosing one has to
    // open it — otherwise the tab you asked for is selected out of sight.
    if (songScope) setSideOpen(true);
    if (v === 'hunt' && inst.huntVariations.length === 0) inst.reroll();
  }, [songScope, inst]);

  /** Built-ins then your own — the order the preset list already shows. */
  const presetOrder = useMemo(
    () => [
      ...inst.presets.map((p) => ({ id: p.id, mine: false })),
      ...inst.userPresets.map((u) => ({ id: u.id, mine: true })),
    ],
    [inst.presets, inst.userPresets],
  );

  const actions: SigilActions = {
    power: (): void => { void inst.start(); },
    panic: (): void => { song.panicAll(); secrets.panicPressed(); },
    toggleRecord: (): void => { void inst.toggleRecord(); },
    bounce: (): void => { void inst.bounceChord(); },
    octave: (delta): void => setOctave((o) => Math.min(8, Math.max(0, o + delta))),
    selectEngineAt: (index): void => {
      const target = engineSummaries[index];
      if (target === undefined) return;
      if (songScope) song.selectEngine(target.id);
      else inst.selectEngine(target.id);
    },
    stepPreset: (delta): void => {
      const count = presetOrder.length;
      if (count === 0) return;
      const at = presetOrder.findIndex((p) => p.id === inst.activePresetId);
      // Nothing loaded yet: forward lands on the first, back on the last.
      const from = at === -1 ? (delta > 0 ? -1 : 0) : at;
      const next = presetOrder[(((from + delta) % count) + count) % count];
      if (next === undefined) return;
      if (next.mine) inst.loadUserPreset(next.id);
      else inst.loadPreset(next.id);
    },
    randomise: inst.randomise,
    save: (): void => inst.savePreset(inst.suggestedName),
    undo: history.undo,
    redo: history.redo,
    toggleHunt: (): void => showTab(view === 'hunt' ? 'sculpt' : 'hunt'),
    /*
     * Re-roll and breed do NOT change tab. They used to jump you to Hunt, which
     * meant a shortcut pressed while shaping a sound threw away the view you
     * had chosen. You stay where you put yourself; alt+H is there when you
     * actually want to look at Hunt.
     */
    reroll: (): void => inst.reroll(),
    breed: (): void => inst.breedKept(),
    assignPad: (): void => {
      const free = kit.kit.slots.find((slot) => slot.wav === null);
      if (free === undefined) {
        inst.setStatus('Kit is full — clear a pad first.');
        return;
      }
      void inst.renderCurrent().then((rendered) => {
        if (rendered === null) return;
        kit.assign(free.index, rendered.name, rendered.bytes, rendered.durationMs);
        inst.setStatus(`Pad ${String(free.index + 1)} ← ${rendered.name}`);
      });
    },
    exportKit: (): void => {
      if (kit.filled === 0) {
        inst.setStatus('Nothing on the pads yet — assign a sound first.');
        return;
      }
      kit.exportZip();
    },
    togglePalette: (): void => setPaletteOpen((o) => !o),
    showTab,
    toggleLayout: (): void => inst.chooseLayout(inst.layout === 'keys' ? 'pads' : 'keys'),
    toggleHelp: (): void => setHelpOpen((o) => !o),
  };

  const handlers = shortcutHandlers(actions);
  useShortcuts(handlers);
  const commands = buildCommands(handlers, actions);

  const heldPads = useMemo(() => new Set<number>(), []);

  /*
   * The six tabs' content, declared once and rendered in exactly one place:
   * the centre in SOUND scope, the side panel in SONG scope.
   */
  const tabContent = (
    <>
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
            <DelaySync
              descriptor={inst.fxDescriptor}
              values={inst.fxValues}
              bpm={song.seq.bpm}
              onChange={inst.setFxParam}
              colour={colour}
            />
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
          host={inst.host ?? null}
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
    </>
  );

  const playSurface = (
    <>
      {keysOpen && <ScalePicker state={scaleState} colour={colour} />}
      {keysOpen && (inst.layout === 'keys' ? (
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
          onNoteOn={song.noteOn}
          onNoteOff={song.noteOff}
          heldPads={heldPads}
        />
      ))}
    </>
  );

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
        <aside
          className="md:w-40 shrink-0 border-b-4 md:border-b-0 md:border-r-4"
          style={{ borderColor: 'var(--ink)' }}
        >
          {/* In SONG scope the rail stacks: tracks, then the selected track's
              engine, then its presets. Neither component below changes — their
              props were already selection-agnostic. */}
          {songScope && (
            <TrackRail
              tracks={song.arr.trackViews}
              selectedId={song.arr.selectedTrackId}
              onSelect={song.arr.selectTrack}
              onToggleMute={song.arr.toggleMute}
              onRename={song.arr.renameTrack}
              onAdd={(): void => { song.arr.addTrack(inst.engineId); }}
              remainingSlots={song.arr.remainingSlots}
              colour={colour}
            />
          )}
          <button
            type="button"
            aria-expanded={railOpen}
            aria-label={railOpen ? 'Hide engines and presets' : 'Show engines and presets'}
            onClick={(): void => setRailOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3 border-b-[3px]
                       text-[10px] font-bold uppercase tracking-[0.16em]"
            style={{ minHeight: '44px', borderColor: 'var(--ink)', color: 'var(--ink)' }}
          >
            <span>{inst.descriptor?.name ?? 'Engine'}</span>
            <span aria-hidden="true">{railOpen ? '▾' : '▸'}</span>
          </button>
          {railOpen && (
            <EngineRail
              engines={engineSummaries}
              activeId={inst.engineId}
              onSelect={songScope ? song.selectEngine : inst.selectEngine}
            />
          )}
          {railOpen && (
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
          )}
        </aside>

        <section className="flex-1 min-w-0 flex flex-col">
          {/*
            The tabs scroll; the controls to their right do not. The whole row
            used to be one overflow-x-auto strip, so on a phone the scope switch
            simply slid off the end and could not be reached — and undo has to
            be reachable at every width or it is not a safety net.
          */}
          <div className="flex border-b-[3px]" style={{ borderColor: 'var(--ink)' }}>
            <div className="flex-1 min-w-0 flex overflow-x-auto">
            {(['sculpt', 'deep', 'fx', 'hunt', 'export', 'setup'] as const).map((v) => (
              <Fragment key={v}>
                <button
                  type="button"
                  aria-pressed={view === v}
                  onClick={(): void => showTab(v)}
                  className="shrink-0 px-4 text-[10px] font-bold uppercase tracking-[0.18em] border-r-[3px]"
                  style={{
                    minHeight: '44px',
                    borderColor: 'var(--ink)',
                    background: view === v ? colour : 'transparent',
                    color: view === v ? 'var(--bg)' : 'var(--ink)',
                    opacity: songScope && !sideOpen ? 0.6 : 1,
                  }}
                >
                  {v}
                </button>
              </Fragment>
            ))}

              {/*
                Pushed past every instrument tab, and inside the scroller with
                them. SIGIL is a sound-design instrument first; SONG is a second
                mode still being worked out, and its position says which is
                which — arranging is somewhere you go deliberately rather than
                somewhere you land. ml-auto pins it right when there is room and
                simply follows the tabs when there is not, which on a phone is
                the difference between six tabs you can reach and two.
              */}
              <div className="ml-auto shrink-0 flex border-l-[3px]" style={{ borderColor: 'var(--ink)' }}>
                <ScopeSwitch scope={song.arr.scope} onScope={song.arr.setScope} colour={colour} />
              </div>
            </div>

            {/*
              Undo is the one control here that never scrolls away. It is the
              safety net for everything else on the page, and a safety net you
              have to go looking for is not one.
            */}
            <div className="shrink-0 flex border-l-[3px]" style={{ borderColor: 'var(--ink)' }}>
              <HistoryButtons
                canUndo={history.canUndo}
                canRedo={history.canRedo}
                onUndo={history.undo}
                onRedo={history.redo}
              />

              {/*
                A visible way in to the shortcut list.

                Both the palette and this panel were keyboard-only, which meant
                the only way to discover a shortcut was to already know one. A
                question mark next to undo costs 44px and removes that circle.
              */}
              <button
                type="button"
                aria-label="Keyboard shortcuts"
                onClick={(): void => setHelpOpen(true)}
                className="shrink-0 border-l-[3px] text-[13px] font-bold"
                style={{
                  minWidth: 44, minHeight: 44,
                  borderColor: 'var(--ink)',
                  color: 'var(--ink)',
                  background: 'transparent',
                }}
              >
                ?
              </button>
            </div>
          </div>

          {songScope && (
            <SongPane
              deck={song}
              height={gridHeight}
              onHeight={setGridHeight}
              onPickNote={setPickerCell}
              colour={colour}
            />
          )}

          {songScope && pickerCell !== null && (
            <NotePicker
              label={song.cellLabel}
              root={scaleState.root}
              scale={scaleState.scale}
              octave={octave}
              onOctave={setOctave}
              onPick={(midi): void => {
                song.arr.addNote(pickerCell.trackId, pickerCell.sectionId, midi);
                setPickerCell(null);
              }}
              onClose={(): void => setPickerCell(null)}
              colour={colour}
            />
          )}

          {songScope && (
            <CellStrip
              label={song.cellLabel}
              hasClip={song.cellHasClip}
              moveArmed={song.pendingClipId !== null}
              onAddNote={(): void => setPickerCell(song.cell)}
              onMove={song.armMove}
              onClear={song.clearCell}
              onTranspose={song.transposeCell}
              colour={colour}
            />
          )}

          {songScope && (
            <LoopStrip
              seq={{ ...song.seq, toggleRecord: song.toggleRecord }}
              targetLabel={song.targetLabel}
              colour={colour}
            />
          )}

          {/* The play surface sits directly under the song in SONG scope, so
              the hand that plays a part and the eye that watches it land are
              never more than a row apart. In SOUND scope it stays in the
              footer, exactly where it has always been. */}
          {songScope && (
            <div className="shrink-0 overflow-y-auto">
              {playSurface}
            </div>
          )}

          {!songScope && (
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              {tabContent}
            </div>
          )}
        </section>

        {/* SOUND scope: the tabs are the centre. SONG scope: they fold to the
            side — available, not occupying it. */}
        {songScope && (
          <aside
            className="shrink-0 flex flex-col border-t-4 md:border-t-0 md:border-l-4"
            style={{ borderColor: 'var(--ink)' }}
          >
            <button
              type="button"
              aria-expanded={sideOpen}
              aria-label={sideOpen ? `Minimise ${view}` : `Open ${view}`}
              onClick={(): void => setSideOpen((o) => !o)}
              className="shrink-0 flex items-center justify-center gap-2 px-3 border-b-[3px]
                         text-[10px] font-bold uppercase tracking-[0.16em]"
              style={{
                minHeight: '44px', minWidth: '44px',
                borderColor: 'var(--ink)', color: 'var(--ink)',
              }}
            >
              <span>{view}</span>
              <span aria-hidden="true">{sideOpen ? '▸' : '◂'}</span>
            </button>
            {sideOpen && (
              <div
                className="min-h-0 flex-1 overflow-y-auto p-3"
                style={{ width: 'min(420px, 100vw)' }}
              >
                {tabContent}
              </div>
            )}
          </aside>
        )}
      </div>

      <footer className="border-t-4" style={{ borderColor: 'var(--ink)' }}>
        <div
          className="flex flex-wrap items-center justify-between gap-y-1.5 gap-x-3
                     px-3 py-1.5 border-b-[3px]"
          style={{ borderColor: '#2A2A28' }}
        >
          <div className="flex gap-1.5">
            {(['keys', 'pads'] as const).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={inst.layout === l}
                onClick={(): void => inst.chooseLayout(l)}
                className="border-[2px] px-3 text-[9px] font-bold uppercase tracking-[0.16em]"
                style={{
                  minHeight: '44px',
                  minWidth: '44px',
                  borderColor: inst.layout === l ? colour : 'var(--ink)',
                  color: inst.layout === l ? colour : 'var(--ink)',
                }}
              >
                {l}
              </button>
            ))}
            <button
              type="button"
              aria-expanded={keysOpen}
              aria-label={keysOpen ? 'Hide the keyboard' : 'Show the keyboard'}
              onClick={(): void => setKeysOpen((o) => !o)}
              className="border-[2px] px-3 text-[9px] font-bold uppercase tracking-[0.16em]"
              style={{
                minHeight: '44px', minWidth: '44px',
                borderColor: 'var(--ink)', color: 'var(--ink)',
              }}
            >
              {keysOpen ? 'hide ▾' : 'show ▸'}
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="label">Octave</span>
            <button
              type="button"
              aria-label="Octave down"
              className="hard border-[3px] w-11 h-11 text-sm font-bold leading-none"
              style={{ borderColor: 'var(--ink)', color: 'var(--ink)' }}
              onClick={(): void => setOctave((o) => Math.max(0, o - 1))}
            >
              −
            </button>
            <span
              className="border-[3px] px-2.5 h-11 flex items-center text-xs font-bold tabular-nums"
              style={{ borderColor: colour, color: colour }}
            >
              C{octave}
            </span>
            <button
              type="button"
              aria-label="Octave up"
              className="hard border-[3px] w-11 h-11 text-sm font-bold leading-none"
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
            className="hard border-[3px] px-3 text-[9px] font-bold uppercase tracking-[0.16em]"
            style={{
              minHeight: '44px',
              minWidth: '44px',
              borderColor: 'var(--ink)',
              background: inst.held.size > 0 ? '#FF3B30' : 'transparent',
              color: inst.held.size > 0 ? 'var(--bg)' : 'var(--ink)',
            }}
            onClick={(): void => { song.panicAll(); secrets.panicPressed(); }}
          >
            Panic{inst.held.size > 0 ? ` ${inst.held.size}` : ''}
          </button>
        </div>

        {/*
          No loop strip in SOUND scope.

          It records into a cell of the song, which is a SONG idea — in SOUND
          scope there is no cell on screen to record into, so REC, the bar
          count and the target label were all referring to something invisible.
          It also put two controls labelled UNDO on screen at once: this one
          strips a take, the patch undo beside the tabs steps a sound. Same
          word, two meanings, an arm's length apart.
        */}
        {!songScope && playSurface}
      </footer>

      <ShortcutHelp open={helpOpen} onClose={(): void => setHelpOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={(): void => setPaletteOpen(false)}
      />

      <InstallPrompt colour={colour} />
      <ToastHost message={inst.status} colour={colour} />
      <CreditsPanel open={eggs.credits} onClose={eggs.closeCredits} />
    </main>
  );
}
