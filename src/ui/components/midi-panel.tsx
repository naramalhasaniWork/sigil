'use client';

import { type JSX } from 'react';
import { Panel } from '@/ui/components/panel';
import { PITCH_BEND_CC, type CcMapping } from '@/ui/use-midi-map';
import type { ChordQuality, ScaleName } from '@/dsp/chords';
import type { PadChordConfig, PadChordMode } from '@/dsp/midi-chords';

const INK = '#F5F1E6';
const GROUND = '#0E0E0E';
const ANALOG = '#FF6B6B';
const PHYSICAL = '#FFD93D';

/** `--muted` on `--panel` is 4.14:1 — anything meant to be read uses ink. */
const readable = { color: INK } as const;
const box = { borderColor: INK, background: GROUND, color: INK } as const;

/** A parameter a knob can be pointed at. Address comes from `param-space`. */
export interface MappableParam {
  address: number;
  label: string;
  min: number;
  max: number;
}

export interface MidiPanelProps {
  devices: readonly string[];
  lastActivity: string | null;
  mappings: readonly CcMapping[];
  learning: number | null;
  startLearn: (paramAddress: number, label: string, range?: { min: number; max: number }) => void;
  cancelLearn: () => void;
  clearMapping: (cc: number) => void;
  params: readonly MappableParam[];
  padChords: PadChordConfig;
  onPadChords: (next: PadChordConfig) => void;
}

interface Opt<T extends string> { value: T; name: string }

const PITCH_OPTIONS: readonly Opt<string>[] =
  ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    .map((name, i) => ({ value: String(i), name }));

const SCALE_OPTIONS: readonly Opt<ScaleName>[] = ([
  ['major', 'Major'], ['minor', 'Minor'], ['dorian', 'Dorian'], ['phrygian', 'Phrygian'],
  ['lydian', 'Lydian'], ['mixolydian', 'Mixolydian'], ['harmonicMinor', 'Harmonic minor'],
  ['pentatonicMinor', 'Pentatonic minor'], ['wholeTone', 'Whole tone'],
  ['chromatic', 'Chromatic'],
] as const).map(([value, name]) => ({ value, name }));

const QUALITY_OPTIONS: readonly Opt<ChordQuality>[] = ([
  ['maj', 'Major'], ['min', 'Minor'], ['dim', 'Diminished'], ['aug', 'Augmented'],
  ['maj7', 'Major 7'], ['min7', 'Minor 7'], ['dom7', 'Dominant 7'], ['sus2', 'Sus2'],
  ['sus4', 'Sus4'], ['add9', 'Add9'], ['min9', 'Minor 9'], ['maj9', 'Major 9'],
] as const).map(([value, name]) => ({ value, name }));

const SPLIT_OPTIONS: readonly Opt<string>[] = ([
  ['none', 'No split — whole keyboard'], ['48', 'Split at C3'],
  ['60', 'Split at C4'], ['72', 'Split at C5'],
] as const).map(([value, name]) => ({ value, name }));

const MODES: readonly Opt<PadChordMode>[] = ([
  ['off', 'Off'], ['scale-degree', 'In key'], ['fixed-quality', 'Fixed'],
] as const).map(([value, name]) => ({ value, name }));

const SPREAD_STEP = 0.25;
const SPREAD_MAX = 2;

const ccName = (cc: number): string => (cc === PITCH_BEND_CC ? 'BEND' : `CC${cc}`);

function Choice<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: readonly Opt<T>[];
  onChange: (next: T) => void;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="label" style={readable}>{label}</span>
      <select
        value={value}
        onChange={(e): void => onChange(e.target.value as T)}
        className="min-h-11 w-full border-[3px] px-2 text-[11px] font-bold"
        style={box}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.name}</option>)}
      </select>
    </label>
  );
}

function Press({ label, active, danger, onClick }: {
  label: string; active?: boolean; danger?: boolean; onClick: () => void;
}): JSX.Element {
  const accent = danger === true ? ANALOG : INK;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="hard min-h-11 shrink-0 border-[3px] px-3 text-xs font-bold uppercase
                 tracking-[0.18em]"
      style={{
        borderColor: accent,
        background: active === true ? accent : GROUND,
        color: active === true ? GROUND : accent,
      }}
    >{label}</button>
  );
}

/** One parameter and whichever knob currently owns it. */
function MapRow({ param, mapping, learning, onLearn, onCancel, onClear }: {
  param: MappableParam;
  mapping: CcMapping | undefined;
  learning: boolean;
  onLearn: () => void;
  onCancel: () => void;
  onClear: () => void;
}): JSX.Element {
  return (
    <li
      className="flex flex-wrap items-center gap-2 border-[3px] p-2"
      style={{ borderColor: learning ? PHYSICAL : INK }}
    >
      <span className="min-w-0 flex-1 truncate text-[11px] font-bold" style={readable}>
        {param.label}
      </span>
      <span
        className="label shrink-0 border-[2px] px-1 py-0.5 tabular-nums"
        style={{
          color: mapping === undefined ? INK : PHYSICAL,
          borderColor: mapping === undefined ? INK : PHYSICAL,
        }}
      >
        {mapping === undefined ? 'unmapped' : `${ccName(mapping.cc)} · ch${mapping.channel + 1}`}
      </span>
      {learning
        ? <Press label="Cancel" active onClick={onCancel} />
        : <Press label="Learn" onClick={onLearn} />}
      {mapping !== undefined && <Press label="Clear" danger onClick={onClear} />}
    </li>
  );
}

/**
 * The MIDI surface: what is plugged in, proof that it is talking, which knob owns
 * which parameter, and how one key turns into a chord. The live readout is here
 * because "my controller does nothing" is nearly always a wiring question — if
 * messages scroll past, the controller is fine and the mapping is what is missing.
 */
export function MidiPanel({
  devices, lastActivity, mappings, learning, startLearn, cancelLearn, clearMapping,
  params, padChords, onPadChords,
}: MidiPanelProps): JSX.Element {
  const cfg = padChords;
  const set = (patch: Partial<PadChordConfig>): void => onPadChords({ ...cfg, ...patch });
  const byAddress = new Map(mappings.map((m) => [m.paramAddress, m]));
  const bumpSpread = (delta: number): void => set({
    voicingSpread: Math.min(SPREAD_MAX, Math.max(0, cfg.voicingSpread + delta)),
  });

  return (
    <Panel title="MIDI" accent={PHYSICAL}>
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-2" aria-label="MIDI inputs">
          <span className="label" style={readable}>Controllers</span>
          {devices.length === 0 ? (
            <p className="text-[11px] leading-snug" style={readable}>
              No MIDI inputs. Safari and iOS have no Web MIDI at all, so nothing will ever
              appear here on an iPhone — on desktop Chrome a controller shows up the moment
              it is plugged in, without a reload.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {devices.map((name) => (
                <li
                  key={name}
                  className="flex min-h-11 items-center border-[3px] px-2 text-[11px] font-bold"
                  style={{ borderColor: INK, ...readable }}
                >{name}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2" aria-label="Last MIDI message">
          <span className="label" style={readable}>Last message</span>
          <output
            className="flex min-h-11 items-center border-[3px] px-2 text-[13px] font-bold
                       tabular-nums"
            style={{ ...box, borderColor: lastActivity === null ? INK : PHYSICAL }}
          >
            {lastActivity ?? 'Waiting — move a knob or press a key'}
          </output>
        </section>

        <section className="flex flex-col gap-2" aria-label="Knob mapping">
          <span className="label" style={readable}>
            {learning === null ? 'Knob mapping' : 'Move the knob you want to use'}
          </span>
          {params.length === 0 ? (
            <p className="text-[11px]" style={readable}>Nothing to map yet.</p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
              {params.map((p) => (
                <MapRow
                  key={p.address}
                  param={p}
                  mapping={byAddress.get(p.address)}
                  learning={learning === p.address}
                  onLearn={(): void => startLearn(p.address, p.label, { min: p.min, max: p.max })}
                  onCancel={cancelLearn}
                  onClear={(): void => {
                    const m = byAddress.get(p.address);
                    if (m !== undefined) clearMapping(m.cc);
                  }}
                />
              ))}
            </ul>
          )}
          <p className="text-[11px] leading-snug" style={readable}>
            Press Learn, then move the knob: the next move claims that parameter, and the
            pairing is remembered on this device. Pitch bend learns like any other knob.
          </p>
        </section>

        <section className="flex flex-col gap-3" aria-label="Pad chords">
          <span className="label" style={readable}>Pad chords</span>
          <div className="flex flex-wrap gap-2">
            {MODES.map((m) => (
              <Press
                key={m.value}
                label={m.name}
                active={cfg.mode === m.value}
                onClick={(): void => set({ mode: m.value })}
              />
            ))}
          </div>
          <p className="text-[11px] leading-snug" style={readable}>
            In key answers each note with the chord that belongs to that degree of the key,
            so nothing you press can be wrong. Fixed stacks the same shape on every note.
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Choice
              label="Key"
              value={String(((cfg.root % 12) + 12) % 12)}
              options={PITCH_OPTIONS}
              onChange={(v): void => set({ root: 60 + Number(v) })}
            />
            <Choice
              label="Scale"
              value={cfg.scale}
              options={SCALE_OPTIONS}
              onChange={(v): void => set({ scale: v })}
            />
            <Choice
              label="Fixed shape"
              value={cfg.quality}
              options={QUALITY_OPTIONS}
              onChange={(v): void => set({ quality: v })}
            />
            <Choice
              label="Split point"
              value={cfg.octaveSplit === null ? 'none' : String(cfg.octaveSplit)}
              options={SPLIT_OPTIONS}
              onChange={(v): void => set({ octaveSplit: v === 'none' ? null : Number(v) })}
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="label" style={readable}>Spread</span>
            <div className="flex items-center gap-2">
              <Press label="−" onClick={(): void => bumpSpread(-SPREAD_STEP)} />
              <span
                className="flex min-h-11 flex-1 items-center justify-center border-[3px]
                           text-[13px] font-bold tabular-nums"
                style={box}
              >
                {cfg.voicingSpread.toFixed(2)}
              </span>
              <Press label="+" onClick={(): void => bumpSpread(SPREAD_STEP)} />
            </div>
          </div>

          <p className="text-[11px] leading-snug" style={readable}>
            Spread lifts the upper notes of the chord into higher octaves — the chord stays
            the same chord, it just stops sounding like a fist on the keyboard. Below the
            split point one key sounds a chord; at and above it, keys play single notes, so
            the left hand comps and the right hand plays the line.
          </p>
        </section>
      </div>
    </Panel>
  );
}
