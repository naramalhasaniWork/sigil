'use client';

import { useMemo, useState, type JSX } from 'react';
import type { EngineDescriptor } from '@/audio/types';
import { addressOf } from '@/audio/param-space';
import { DevicePanel } from './device-panel';
import { HandControlPanel } from './hand-control-panel';
import { MidiPanel, type MappableParam } from './midi-panel';
import { useMidiMap } from '@/ui/use-midi-map';
import type { PadChordConfig } from '@/dsp/midi-chords';
import { KitPanel } from './kit-panel';
import type { KitHandle } from '@/ui/use-kit';

interface SetupPanelProps {
  audioContext: AudioContext | null;
  engineDescriptor: EngineDescriptor | undefined;
  fxDescriptor: EngineDescriptor;
  magicDescriptor: EngineDescriptor;
  padChords: PadChordConfig;
  onPadChords: (next: PadChordConfig) => void;
  onParam: (address: number, value: number) => void;
  onNoteOn: (midi: number, velocity: number) => void;
  onNoteOff: (midi: number) => void;
  enabled: boolean;
  /** Hand signals are modulation sources, patched onto the four macros. */
  onHandReading: (x: number, y: number, pinch: number, spread: number) => void;
  macroNames: readonly [string, string, string, string];
  kit: KitHandle;
  colour: string;
  bouncing: boolean;
  onRenderForKit: () => Promise<{ name: string; bytes: Uint8Array; durationMs: number } | null>;
}

/**
 * Kit sits here rather than at the top level. Seven top-level tabs was more
 * choice than the instrument needs — the things in here are all "set something
 * up once", so they share one door and one row of sub-tabs.
 */
const SECTIONS = ['kit', 'hardware', 'controllers', 'camera'] as const;
type Section = (typeof SECTIONS)[number];

/**
 * Everything about talking to the outside world: hardware, controllers and the
 * camera. These panels were each built and reviewed but never reachable — the
 * app had no surface that mounted them.
 */
export function SetupPanel({
  audioContext, engineDescriptor, fxDescriptor, magicDescriptor,
  padChords, onPadChords, onParam, onNoteOn, onNoteOff, enabled,
  onHandReading, macroNames, kit, colour, bouncing, onRenderForKit,
}: SetupPanelProps): JSX.Element {
  const [section, setSection] = useState<Section>('kit');
  /** Every parameter a controller knob can be learned onto, across the chain. */
  const mappable = useMemo<MappableParam[]>(() => {
    const out: MappableParam[] = [];
    const push = (d: EngineDescriptor, section: 'engine' | 'fx' | 'magic', prefix: string): void => {
      d.params.forEach((p, i) => {
        out.push({
          address: addressOf(section, i),
          label: `${prefix} · ${p.name}`,
          min: p.min,
          max: p.max,
        });
      });
    };
    if (engineDescriptor) push(engineDescriptor, 'engine', engineDescriptor.name);
    push(fxDescriptor, 'fx', 'FX');
    push(magicDescriptor, 'magic', 'Character');
    return out;
  }, [engineDescriptor, fxDescriptor, magicDescriptor]);

  const midiMap = useMidiMap({
    onParam,
    onNoteOn,
    onNoteOff,
    padChords,
    enabled,
  });

  return (
    <div className="flex flex-col gap-5 max-w-5xl">
      <div className="flex flex-wrap gap-1.5">
        {SECTIONS.map((name) => {
          const active = section === name;
          return (
            <button
              key={name}
              type="button"
              aria-pressed={active}
              onClick={(): void => setSection(name)}
              className="border-[3px] px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.16em]"
              style={{
                borderColor: active ? colour : 'var(--muted)',
                background: active ? colour : 'transparent',
                color: active ? 'var(--bg)' : 'var(--ink)',
              }}
            >
              {name === 'kit' ? 'Kit · KO II' : name}
            </button>
          );
        })}
      </div>

      {section === 'kit' && (
        <KitPanel kit={kit} colour={colour} busy={bouncing} onRender={onRenderForKit} />
      )}

      {section === 'hardware' && <DevicePanel audioContext={audioContext} />}

      {section === 'controllers' && (
        <MidiPanel
          devices={midiMap.devices}
          lastActivity={midiMap.lastActivity}
          mappings={midiMap.mappings}
          learning={midiMap.learning}
          startLearn={midiMap.startLearn}
          cancelLearn={midiMap.cancelLearn}
          clearMapping={midiMap.clearMapping}
          params={mappable}
          padChords={padChords}
          onPadChords={onPadChords}
        />
      )}

      {section === 'camera' && (
        <HandControlPanel
          onReading={onHandReading}
          targets={{
            x: macroNames[1],
            y: macroNames[0],
            pinch: macroNames[2],
            spread: macroNames[3],
          }}
        />
      )}
    </div>
  );
}
