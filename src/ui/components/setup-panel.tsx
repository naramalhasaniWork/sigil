'use client';

import { useMemo, type JSX } from 'react';
import type { EngineDescriptor } from '@/audio/types';
import { addressOf } from '@/audio/param-space';
import { DevicePanel } from './device-panel';
import { HandControlPanel } from './hand-control-panel';
import { MidiPanel, type MappableParam } from './midi-panel';
import { useMidiMap } from '@/ui/use-midi-map';
import type { PadChordConfig } from '@/dsp/midi-chords';

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
}

/**
 * Everything about talking to the outside world: hardware, controllers and the
 * camera. These panels were each built and reviewed but never reachable — the
 * app had no surface that mounted them.
 */
export function SetupPanel({
  audioContext, engineDescriptor, fxDescriptor, magicDescriptor,
  padChords, onPadChords, onParam, onNoteOn, onNoteOff, enabled,
  onHandReading, macroNames,
}: SetupPanelProps): JSX.Element {
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
    <div className="flex flex-col gap-8 max-w-5xl">
      <section>
        <div className="label mb-3">Hardware</div>
        <DevicePanel audioContext={audioContext} />
      </section>

      <section>
        <div className="label mb-3">Controllers</div>
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
      </section>

      <section>
        <div className="label mb-3">Camera gesture</div>
        <HandControlPanel
          onReading={onHandReading}
          targets={{
            x: macroNames[1],
            y: macroNames[0],
            pinch: macroNames[2],
            spread: macroNames[3],
          }}
        />
      </section>
    </div>
  );
}
