import { describe, it, expect } from 'vitest';
import {
  CC_ALL_NOTES_OFF,
  MIDI_CHANNELS,
  MidiOut,
  clamp7,
  clampChannel,
  describeCapabilities,
  describePort,
  encodeAllNotesOff,
  encodeControlChange,
  encodeNoteOff,
  encodeNoteOn,
  hasUnlabelledOutputs,
  isKo2Name,
  isWebMidiSupported,
  isWebUsbSupported,
  listAudioOutputs,
  listMidiPorts,
  requestKo2Device,
  routeOutputTo,
  sinkIdStatus,
  unitToVelocity,
  type MidiSendable,
} from '@/audio/ko2-bridge';

/** A MIDI output that records instead of transmitting. */
function fakePort(): MidiSendable & { sent: number[][] } {
  const sent: number[][] = [];
  return { sent, send: (data: number[]): void => { sent.push([...data]); } };
}

describe('K.O. II name detection', () => {
  const matching = [
    'EP-133 K.O. II',
    'Teenage Engineering EP-133 K.O. II',
    'ep-133',
    'KO II MIDI 1',
    'Teenage Engineering OP-Z', // over-matches on purpose; see KO2_NAME_TOKENS
  ];
  for (const name of matching) {
    it(`matches ${name}`, () => {
      expect(isKo2Name(name)).toBe(true);
    });
  }

  const notMatching = [
    'IAC Driver Bus 1',
    'Arturia KeyStep Pro',
    'Ableton Push 2',
    'Novation Launchkey MK3 MIDI',
    'Elektron Digitakt',
    'Korg minilogue xd',
    'MacBook Pro Speakers',
    'Roland TR-8S',
    '',
  ];
  for (const name of notMatching) {
    it(`does not match ${name === '' ? '(empty)' : name}`, () => {
      expect(isKo2Name(name)).toBe(false);
    });
  }

  it('matches on the manufacturer field alone', () => {
    expect(isKo2Name('MIDI Port 1', 'Teenage Engineering')).toBe(true);
    expect(isKo2Name('MIDI Port 1', 'Focusrite')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isKo2Name('EP-133 K.O. II')).toBe(true);
    expect(isKo2Name('ep-133 k.o. ii')).toBe(true);
    expect(isKo2Name('Ep-133 K.o. Ii')).toBe(true);
  });

  it('keeps the raw name and null-safes both fields', () => {
    expect(describePort({ id: 'a', name: null, manufacturer: null, state: 'connected' }))
      .toEqual({ id: 'a', name: '', manufacturer: '', isKo2: false });
    expect(describePort({
      id: 'b', name: 'EP-133 K.O. II', manufacturer: 'Teenage Engineering', state: 'connected',
    })).toEqual({
      id: 'b', name: 'EP-133 K.O. II', manufacturer: 'Teenage Engineering', isKo2: true,
    });
  });
});

describe('MIDI byte encoding', () => {
  it('encodes note on with status 0x90 and the channel in the low nibble', () => {
    expect(encodeNoteOn(60, 100)).toEqual([0x90, 60, 100]);
    expect(encodeNoteOn(60, 100, 0)).toEqual([0x90, 60, 100]);
    expect(encodeNoteOn(60, 100, 1)).toEqual([0x91, 60, 100]);
    expect(encodeNoteOn(0, 127, 15)).toEqual([0x9f, 0, 127]);
  });

  it('encodes note off with status 0x80 and release velocity 0', () => {
    expect(encodeNoteOff(60)).toEqual([0x80, 60, 0]);
    expect(encodeNoteOff(127, 9)).toEqual([0x89, 127, 0]);
  });

  it('sends velocity 0 verbatim as a note-on, not as a note-off', () => {
    // Documented in encodeNoteOn: the status byte is never rewritten.
    expect(encodeNoteOn(60, 0)).toEqual([0x90, 60, 0]);
    expect(encodeNoteOn(60, 0)[0]).not.toBe(0x80);
  });

  it('encodes control change with status 0xB0', () => {
    expect(encodeControlChange(74, 64)).toEqual([0xb0, 74, 64]);
    expect(encodeControlChange(1, 127, 3)).toEqual([0xb3, 1, 127]);
  });

  it('encodes all-notes-off as CC 123 value 0', () => {
    expect(CC_ALL_NOTES_OFF).toBe(123);
    expect(encodeAllNotesOff(0)).toEqual([0xb0, 123, 0]);
    expect(encodeAllNotesOff(15)).toEqual([0xbf, 123, 0]);
  });
});

describe('clamping', () => {
  it('clamps data bytes to 0..127 and rounds', () => {
    expect(clamp7(-1)).toBe(0);
    expect(clamp7(128)).toBe(127);
    expect(clamp7(63.4)).toBe(63);
    expect(clamp7(63.5)).toBe(64);
    expect(clamp7(Number.NaN)).toBe(0);
    expect(clamp7(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('clamps channel to 0..15', () => {
    expect(clampChannel(-3)).toBe(0);
    expect(clampChannel(16)).toBe(15);
    expect(clampChannel(Number.NaN)).toBe(0);
  });

  it('clamps out-of-range notes, velocities and CCs at the encoder', () => {
    expect(encodeNoteOn(300, 999)).toEqual([0x90, 127, 127]);
    expect(encodeNoteOn(-5, -5)).toEqual([0x90, 0, 0]);
    expect(encodeNoteOff(1000, 99)).toEqual([0x8f, 127, 0]);
    expect(encodeControlChange(-1, 500, 200)).toEqual([0xbf, 0, 127]);
  });

  it('converts SIGIL 0..1 velocity to MIDI units', () => {
    expect(unitToVelocity(0)).toBe(0);
    expect(unitToVelocity(1)).toBe(127);
    expect(unitToVelocity(0.5)).toBe(64);
    expect(unitToVelocity(2)).toBe(127);
    expect(unitToVelocity(Number.NaN)).toBe(0);
  });
});

describe('MidiOut', () => {
  it('sends the same bytes the encoders produce', () => {
    const port = fakePort();
    const out = new MidiOut('port-1', port);
    out.noteOn(60, 100);
    out.noteOn(64, 90, 2);
    out.noteOff(60);
    out.controlChange(74, 20, 1);
    expect(port.sent).toEqual([
      [0x90, 60, 100],
      [0x92, 64, 90],
      [0x80, 60, 0],
      [0xb1, 74, 20],
    ]);
  });

  it('sends single-byte realtime messages', () => {
    const port = fakePort();
    const out = new MidiOut('port-1', port);
    out.start();
    out.sendClock();
    out.stop();
    expect(port.sent).toEqual([[0xfa], [0xf8], [0xfc]]);
  });

  it('panics on every channel', () => {
    const port = fakePort();
    const out = new MidiOut('port-1', port);
    out.allNotesOff();
    expect(port.sent).toHaveLength(MIDI_CHANNELS);
    expect(port.sent[0]).toEqual([0xb0, 123, 0]);
    expect(port.sent[15]).toEqual([0xbf, 123, 0]);
  });

  it('drops messages when there is no port, without throwing', () => {
    const out = new MidiOut(null);
    expect(out.ready).toBe(false);
    expect(() => {
      out.noteOn(60, 100);
      out.noteOff(60);
      out.allNotesOff();
      out.sendClock();
      out.start();
      out.stop();
      out.controlChange(1, 1);
    }).not.toThrow();
  });

  it('gives up on a port that throws mid-send rather than throwing at the caller', () => {
    const out = new MidiOut('gone', {
      send: (): never => { throw new Error('InvalidStateError'); },
    });
    expect(() => out.noteOn(60, 100)).not.toThrow();
    expect(out.ready).toBe(false);
  });

  it('does not touch WebMIDI when constructed with an explicit port', () => {
    const port = fakePort();
    // No navigator.requestMIDIAccess exists in Node; construction must be safe.
    expect(() => new MidiOut('any', port)).not.toThrow();
    expect(new MidiOut('any', port).ready).toBe(true);
  });
});

describe('missing browser APIs', () => {
  it('reports WebMIDI and WebUSB as absent in Node', () => {
    expect(isWebMidiSupported()).toBe(false);
    expect(isWebUsbSupported()).toBe(false);
  });

  it('returns empty port lists rather than throwing', async () => {
    await expect(listMidiPorts()).resolves.toEqual({ inputs: [], outputs: [] });
  });

  it('returns an empty audio-output list rather than throwing', async () => {
    await expect(listAudioOutputs()).resolves.toEqual([]);
  });

  it('returns null from requestKo2Device rather than throwing', async () => {
    await expect(requestKo2Device()).resolves.toBeNull();
  });

  it('returns false from routeOutputTo when setSinkId is missing', async () => {
    const ctx = {} as unknown as AudioContext;
    await expect(routeOutputTo(ctx, 'device-1')).resolves.toBe(false);
  });

  it('returns false when setSinkId rejects', async () => {
    const ctx = {
      setSinkId: (): Promise<void> => Promise.reject(new Error('NotFoundError')),
    } as unknown as AudioContext;
    await expect(routeOutputTo(ctx, 'device-1')).resolves.toBe(false);
  });

  it('returns true when setSinkId resolves', async () => {
    const seen: string[] = [];
    const ctx = {
      setSinkId: (id: string): Promise<void> => { seen.push(id); return Promise.resolve(); },
    } as unknown as AudioContext;
    await expect(routeOutputTo(ctx, 'device-1')).resolves.toBe(true);
    expect(seen).toEqual(['device-1']);
  });

  it('reports setSinkId as unavailable with a reason where Web Audio is absent', () => {
    const status = sinkIdStatus();
    expect(status.available).toBe(false);
    expect(status.reason.length).toBeGreaterThan(0);
  });
});

describe('device label permission gating', () => {
  it('detects the blank labels enumerateDevices returns before mic permission', () => {
    expect(hasUnlabelledOutputs([{ label: '' }, { label: '' }])).toBe(true);
    expect(hasUnlabelledOutputs([{ label: 'Built-in Output' }, { label: '  ' }])).toBe(true);
    expect(hasUnlabelledOutputs([{ label: 'Built-in Output' }])).toBe(false);
    expect(hasUnlabelledOutputs([])).toBe(false);
  });
});

describe('capability reporting', () => {
  it('gives every capability a concrete reason', () => {
    const caps = describeCapabilities();
    expect(caps.map((c) => c.id)).toEqual([
      'midi', 'audio-routing', 'usb-identify', 'sample-transfer',
    ]);
    for (const cap of caps) expect(cap.reason.length).toBeGreaterThan(10);
  });

  it('never reports sample transfer as available', () => {
    const transfer = describeCapabilities().find((c) => c.id === 'sample-transfer');
    expect(transfer?.available).toBe(false);
    expect(transfer?.reason).toContain('EP Sample Tool');
  });
});
