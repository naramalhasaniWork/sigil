'use client';

import { useMemo, type JSX } from 'react';
import type { EngineDescriptor } from '@/audio/types';
import { addressOf } from '@/audio/param-space';
import type { EngineHost } from '@/audio/engine-host';
import { AudioSetup } from './audio-setup';
import { DevicePanel } from './device-panel';
import { MidiPanel, type MappableParam } from './midi-panel';
import { HandControlPanel } from './hand-control-panel';
import type { HandReading } from '@/ui/use-hand-control';
import { useMidiMap } from '@/ui/use-midi-map';
import type { PadChordConfig } from '@/dsp/midi-chords';
import { KitPanel } from './kit-panel';
import type { KitHandle } from '@/ui/use-kit';

interface SetupPanelProps {
  audioContext: AudioContext | null;
  /** For the buffer profile and latency readout. Null until powered on. */
  host: EngineHost | null;
  engineDescriptor: EngineDescriptor | undefined;
  fxDescriptor: EngineDescriptor;
  magicDescriptor: EngineDescriptor;
  padChords: PadChordConfig;
  onPadChords: (next: PadChordConfig) => void;
  onParam: (address: number, value: number) => void;
  onNoteOn: (midi: number, velocity: number) => void;
  onNoteOff: (midi: number) => void;
  enabled: boolean;
  /**
   * Left hand plays (pitch from height, pinch gates), right hand shapes the four
   * macros. Either may be null when only one hand is in frame.
   */
  onHands: (left: HandReading | null, right: HandReading | null) => void;
  section: SetupSection;
  onSection: (next: SetupSection) => void;
  macroNames: readonly [string, string, string, string];
  kit: KitHandle;
  colour: string;
  bouncing: boolean;
  bounceMs: number;
  onBounceMs: (ms: number) => void;
  onRenderForKit: () => Promise<{ name: string; bytes: Uint8Array; durationMs: number } | null>;
}

/**
 * Kit sits here rather than at the top level. Seven top-level tabs was more
 * choice than the instrument needs — the things in here are all "set something
 * up once", so they share one door and one row of sub-tabs.
 */
/*
 * Camera first, KO II last.
 *
 * Ordered by how often the owner actually reaches for them. Hand tracking is
 * the thing he opens Setup to use; the KO II kit builder is the tail end of a
 * session, after the sounds already exist, and it was sitting in the first slot
 * collecting accidental taps.
 */
export const SETUP_SECTIONS = ['camera', 'hardware', 'controllers', 'kit'] as const;
export type SetupSection = (typeof SETUP_SECTIONS)[number];

/**
 * Everything about talking to the outside world: hardware, controllers and the
 * camera. These panels were each built and reviewed but never reachable — the
 * app had no surface that mounted them.
 */
export function SetupPanel({
  audioContext, host, engineDescriptor, fxDescriptor, magicDescriptor,
  padChords, onPadChords, onParam, onNoteOn, onNoteOff, enabled,
  macroNames, kit, colour, bouncing, onRenderForKit, section, onSection, onHands, bounceMs, onBounceMs,
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
    <div className="flex flex-col gap-5 max-w-5xl">
      <div className="flex flex-wrap gap-1.5">
        {SETUP_SECTIONS.map((name) => {
          const active = section === name;
          return (
            <button
              key={name}
              type="button"
              aria-pressed={active}
              onClick={(): void => onSection(name)}
              className="border-[3px] px-3 text-[9px] font-bold uppercase tracking-[0.16em]"
              style={{
                minHeight: '44px',
                minWidth: '44px',
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
        <KitPanel
          kit={kit}
          colour={colour}
          busy={bouncing}
          bounceMs={bounceMs}
          onBounceMs={onBounceMs}
          onRender={onRenderForKit}
        />
      )}

      {section === 'hardware' && (
        <div className="flex flex-col gap-6">
          <AudioSetup host={host} colour={colour} />
          <DevicePanel audioContext={audioContext} />
        </div>
      )}

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

      {/*
        * Always mounted, parked off-screen when another section is showing.
        * Unmounting would stop the camera on every tab change, and a hidden
        * <video> can stop receiving frame callbacks — so it stays in the tree
        * and simply leaves the viewport.
        */}
      <div
        className={section === 'camera' ? undefined : undefined}
        aria-hidden={section !== 'camera'}
        style={section === 'camera' ? undefined : {
          position: 'fixed', left: -99999, top: 0,
          width: 360, height: 460, overflow: 'hidden', pointerEvents: 'none',
        }}
      >
        <HandControlPanel
          onHands={onHands}
          targets={{
            x: 'Register',
            y: 'Pitch',
            pinch: 'Gate',
            spread: macroNames[3],
          }}
        />
      </div>
    </div>
  );
}
