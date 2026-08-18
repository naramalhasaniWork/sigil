'use client';

import { useEffect, useRef, useState } from 'react';

export interface MidiOptions {
  onNoteOn: (midi: number, velocity: number) => void;
  onNoteOff: (midi: number) => void;
  enabled: boolean;
}

export interface MidiStatus {
  supported: boolean;
  deviceName: string | null;
}

/**
 * Minimal structural view of the Web MIDI API. Declared locally so the hook
 * compiles on lib targets that do not ship Web MIDI types, and so nothing here
 * depends on the API existing at all (it is absent on iOS).
 */
interface MidiMessageLike {
  readonly data: Uint8Array | null;
}

interface MidiInputLike {
  readonly id: string;
  readonly name: string | null;
  readonly state: string;
  onmidimessage: ((event: MidiMessageLike) => void) | null;
}

interface MidiAccessLike {
  readonly inputs: ReadonlyMap<string, MidiInputLike>;
  onstatechange: ((event: unknown) => void) | null;
}

interface MidiNavigatorLike {
  requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MidiAccessLike>;
}

const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;
const MAX_MIDI = 127;

function firstDeviceName(access: MidiAccessLike): string | null {
  for (const input of access.inputs.values()) {
    if (input.state === 'disconnected') continue;
    return input.name ?? 'MIDI device';
  }
  return null;
}

/**
 * Plays notes from an attached MIDI keyboard when the browser has Web MIDI.
 * `supported` is false (and nothing throws) where the API is missing.
 */
export function useMidi(opts: MidiOptions): MidiStatus {
  const [supported, setSupported] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);

  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const nav = navigator as unknown as MidiNavigatorLike;
    setSupported(typeof nav.requestMIDIAccess === 'function');
  }, []);

  useEffect(() => {
    if (!opts.enabled || typeof navigator === 'undefined') return;
    const nav = navigator as unknown as MidiNavigatorLike;
    const request = nav.requestMIDIAccess;
    if (typeof request !== 'function') return;

    let cancelled = false;
    let access: MidiAccessLike | null = null;
    const attached: MidiInputLike[] = [];

    const onMessage = (event: MidiMessageLike): void => {
      const data = event.data;
      if (data === null || data.length < 3) return;
      const status = data[0] as number;
      const type = status & 0xf0;
      if (type !== NOTE_ON && type !== NOTE_OFF) return;
      const note = data[1] as number;
      const velocity = data[2] as number;
      if (note > MAX_MIDI) return;
      // Note-on with velocity 0 is the common way to spell note-off.
      if (type === NOTE_ON && velocity > 0) {
        optsRef.current.onNoteOn(note, velocity / 127);
      } else {
        optsRef.current.onNoteOff(note);
      }
    };

    const detach = (): void => {
      for (const input of attached) input.onmidimessage = null;
      attached.length = 0;
    };

    const attach = (current: MidiAccessLike): void => {
      detach();
      for (const input of current.inputs.values()) {
        if (input.state === 'disconnected') continue;
        input.onmidimessage = onMessage;
        attached.push(input);
      }
      setDeviceName(firstDeviceName(current));
    };

    let pending: Promise<MidiAccessLike> | null = null;
    try {
      pending = request.call(navigator, { sysex: false });
    } catch {
      pending = null;
    }

    pending
      ?.then((granted): void => {
        if (cancelled) return;
        access = granted;
        // Devices plugged in or unplugged after startup.
        granted.onstatechange = (): void => { if (!cancelled) attach(granted); };
        attach(granted);
      })
      .catch((): void => {
        if (!cancelled) setDeviceName(null);
      });

    return (): void => {
      cancelled = true;
      detach();
      if (access !== null) access.onstatechange = null;
      setDeviceName(null);
    };
  }, [opts.enabled]);

  return { supported, deviceName };
}
