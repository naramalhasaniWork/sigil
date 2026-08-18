'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  expandIncomingNote,
  collapseNoteOff,
  type PadChordConfig,
} from '@/dsp/midi-chords';

interface ChordInputOptions {
  config: PadChordConfig;
  onNoteOn: (midi: number, velocity: number) => void;
  onNoteOff: (midi: number) => void;
}

export interface ChordInput {
  noteOn: (midi: number, velocity?: number) => void;
  noteOff: (midi: number) => void;
  /** Releases everything this layer is holding. Use when the mode changes. */
  releaseAll: () => void;
}

/**
 * Chord mode as an INPUT LAYER rather than a property of one surface.
 *
 * Chords used to be built inside the pad grid, so switching to Chords did
 * nothing on the keyboard, the computer keys or MIDI — the toggle silently
 * applied to a quarter of the instrument. Every surface now goes through here,
 * so one setting means the same thing everywhere.
 *
 * Pitches are reference-counted: adjacent diatonic chords share two of three
 * tones, and VoiceManager.noteOff frees every voice at a pitch, so releasing
 * one key would otherwise cut notes another held key is still sounding.
 */
export function useChordInput({ config, onNoteOn, onNoteOff }: ChordInputOptions): ChordInput {
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const onRef = useRef(onNoteOn);
  onRef.current = onNoteOn;
  const offRef = useRef(onNoteOff);
  offRef.current = onNoteOff;

  /** input note -> the pitches it opened, so release matches exactly. */
  const opened = useRef(new Map<number, number[]>());
  /** pitch -> how many input notes are holding it. */
  const refs = useRef(new Map<number, number>());

  const noteOn = useCallback((midi: number, velocity = 1): void => {
    const notes = expandIncomingNote(midi, velocity, cfgRef.current);
    opened.current.set(midi, notes);
    for (const n of notes) {
      const count = refs.current.get(n) ?? 0;
      refs.current.set(n, count + 1);
      if (count === 0) onRef.current(n, velocity);
    }
  }, []);

  const noteOff = useCallback((midi: number): void => {
    const notes = opened.current.get(midi) ?? collapseNoteOff(midi, cfgRef.current);
    opened.current.delete(midi);
    for (const n of notes) {
      const count = (refs.current.get(n) ?? 1) - 1;
      if (count <= 0) {
        refs.current.delete(n);
        offRef.current(n);
      } else {
        refs.current.set(n, count);
      }
    }
  }, []);

  const releaseAll = useCallback((): void => {
    for (const pitch of refs.current.keys()) offRef.current(pitch);
    refs.current.clear();
    opened.current.clear();
  }, []);

  // Changing key, scale or mode mid-hold would otherwise strand every sounding
  // note, because the release would expand to a different chord than the press.
  useEffect(() => {
    releaseAll();
  }, [config.mode, config.root, config.scale, config.quality, releaseAll]);

  return { noteOn, noteOff, releaseAll };
}
