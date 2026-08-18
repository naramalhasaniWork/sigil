/**
 * Teenage Engineering EP-133 K.O. II bridge. Three things work: MIDI out (we
 * play the device's own sampler), audio-output routing (`setSinkId` feeds its
 * USB audio input, firmware 2.5+), and WebUSB identification (descriptors only).
 *
 * What is NOT here: pushing samples. TE's transfer protocol is undocumented and
 * is not reverse-engineered in this file — nothing below claims an interface or
 * transfers data. Samples reach the device through TE's own EP Sample Tool, fed
 * by the kit zip that `@/audio/kit` exports.
 *
 * Every browser API used here is optional — all are absent on iOS, and WebMIDI
 * is absent on Safari everywhere. Nothing throws when one is missing; callers
 * get `false`, `null`, or an empty list.
 */

// --- Structural views of optional browser APIs ---

interface MidiPortLike {
  readonly id: string;
  readonly name: string | null;
  readonly manufacturer: string | null;
  readonly state: string;
}

/** Only the one method we use. Anything that takes bytes works as a sink. */
export interface MidiSendable {
  send(data: number[], timestamp?: number): void;
}

interface MidiOutputLike extends MidiPortLike, MidiSendable {}

interface MidiAccessLike {
  readonly inputs: ReadonlyMap<string, MidiPortLike>;
  readonly outputs: ReadonlyMap<string, MidiOutputLike>;
}

interface MidiNavigatorLike {
  requestMIDIAccess?: (o?: { sysex?: boolean }) => Promise<MidiAccessLike>;
}

interface MediaDeviceLike { readonly kind: string; readonly deviceId: string; readonly label: string }
interface MediaDevicesLike { enumerateDevices?: () => Promise<MediaDeviceLike[]> }
interface MediaNavigatorLike { mediaDevices?: MediaDevicesLike }

interface UsbDeviceLike {
  readonly productName?: string | null;
  readonly manufacturerName?: string | null;
  readonly serialNumber?: string | null;
  readonly vendorId: number;
  readonly productId: number;
  readonly configurations?: readonly unknown[];
}

interface UsbNavigatorLike {
  usb?: { requestDevice: (options: { filters: unknown[] }) => Promise<UsbDeviceLike> };
}

/** `setSinkId` on AudioContext is Chrome-only and not in every lib.dom yet. */
interface SinkCapable { setSinkId?: (deviceId: string) => Promise<void> }

// --- Device identification ---

/**
 * Substrings identifying a K.O. II, matched case-insensitively against name and
 * manufacturer together. `teenage` deliberately over-matches — an OP-1 trips it
 * too — which is why every API here also returns the raw name: the UI shows
 * what the port calls itself and flags a likely K.O. II rather than asserting.
 */
export const KO2_NAME_TOKENS: readonly string[] = ['ep-133', 'k.o', 'ko ii', 'teenage'];

export function isKo2Name(name: string | null, manufacturer?: string | null): boolean {
  const haystack = `${name ?? ''} ${manufacturer ?? ''}`.toLowerCase();
  return KO2_NAME_TOKENS.some((token) => haystack.includes(token));
}

export interface MidiPortInfo {
  id: string;
  /** Raw and unedited. Empty string when the port reports no name. */
  name: string;
  manufacturer: string;
  isKo2: boolean;
}

export interface Ko2MidiPorts { inputs: MidiPortInfo[]; outputs: MidiPortInfo[] }

export function describePort(port: MidiPortLike): MidiPortInfo {
  return {
    id: port.id,
    name: port.name ?? '',
    manufacturer: port.manufacturer ?? '',
    isKo2: isKo2Name(port.name, port.manufacturer),
  };
}

// --- MIDI byte encoding ---
export const MIDI_NOTE_OFF = 0x80;
export const MIDI_NOTE_ON = 0x90;
export const MIDI_CONTROL_CHANGE = 0xb0;
export const MIDI_CLOCK = 0xf8;
export const MIDI_START = 0xfa;
export const MIDI_STOP = 0xfc;
export const CC_ALL_NOTES_OFF = 123;
export const MIDI_CHANNELS = 16;

/** Data bytes are 7-bit. Non-finite input collapses to 0 rather than NaN. */
export function clamp7(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(127, Math.max(0, Math.round(value)));
}

/** Channel is 0-based here, encoded in the status byte's low nibble. */
export function clampChannel(channel: number): number {
  if (!Number.isFinite(channel)) return 0;
  return Math.min(MIDI_CHANNELS - 1, Math.max(0, Math.round(channel)));
}

/** SIGIL's internal 0..1 velocity to MIDI's 0..127. */
export function unitToVelocity(unit: number): number {
  if (!Number.isFinite(unit)) return 0;
  return clamp7(unit * 127);
}

/**
 * `velocity` is in MIDI units (0–127), not SIGIL's 0..1 — see `unitToVelocity`.
 * Velocity 0 is sent verbatim as `0x9n note 0x00`, NOT rewritten to a note-off:
 * receivers treat it as one anyway, and rewriting the status byte would hide a
 * caller's bug rather than fix it.
 */
export function encodeNoteOn(note: number, velocity: number, channel = 0): number[] {
  return [MIDI_NOTE_ON | clampChannel(channel), clamp7(note), clamp7(velocity)];
}

/** Note-off with release velocity 0, which is what hardware overwhelmingly sends. */
export function encodeNoteOff(note: number, channel = 0): number[] {
  return [MIDI_NOTE_OFF | clampChannel(channel), clamp7(note), 0];
}

export function encodeControlChange(cc: number, value: number, channel = 0): number[] {
  return [MIDI_CONTROL_CHANGE | clampChannel(channel), clamp7(cc), clamp7(value)];
}

/** CC 123 on one channel. `MidiOut.allNotesOff` sends it on all 16. */
export function encodeAllNotesOff(channel = 0): number[] {
  return encodeControlChange(CC_ALL_NOTES_OFF, 0, channel);
}

// --- WebMIDI access ---

function midiNavigator(): MidiNavigatorLike | null {
  if (typeof navigator === 'undefined') return null;
  return navigator as unknown as MidiNavigatorLike;
}

export function isWebMidiSupported(): boolean {
  const nav = midiNavigator();
  return nav !== null && typeof nav.requestMIDIAccess === 'function';
}

let accessPromise: Promise<MidiAccessLike | null> | null = null;

/** One access request per page. Null where WebMIDI is absent or denied. */
async function midiAccess(): Promise<MidiAccessLike | null> {
  if (accessPromise !== null) return accessPromise;
  const nav = midiNavigator();
  const request = nav?.requestMIDIAccess;
  if (nav === null || typeof request !== 'function') return null;
  accessPromise = Promise.resolve()
    .then((): Promise<MidiAccessLike> => request.call(nav, { sysex: false }))
    .catch((): null => null);
  return accessPromise;
}

export async function listMidiPorts(): Promise<Ko2MidiPorts> {
  const access = await midiAccess();
  if (access === null) return { inputs: [], outputs: [] };
  const inputs: MidiPortInfo[] = [];
  const outputs: MidiPortInfo[] = [];
  for (const port of access.inputs.values()) inputs.push(describePort(port));
  for (const port of access.outputs.values()) outputs.push(describePort(port));
  return { inputs, outputs };
}

/**
 * A MIDI output port, resolved lazily. Messages sent before it resolves — or
 * when `portId` is null, or WebMIDI is missing — are dropped silently, so a
 * sequencer can hold one unconditionally and never guard a call.
 */
export class MidiOut {
  private port: MidiSendable | null = null;

  /** `port` is an injection seam for tests; production callers pass one argument. */
  constructor(readonly portId: string | null, port?: MidiSendable | null) {
    if (port !== undefined && port !== null) {
      this.port = port;
      return;
    }
    if (portId !== null) void this.resolve(portId);
  }

  private async resolve(portId: string): Promise<void> {
    const access = await midiAccess();
    if (access === null) return;
    this.port = access.outputs.get(portId) ?? null;
  }

  get ready(): boolean { return this.port !== null; }

  private send(bytes: number[]): void {
    const port = this.port;
    if (port === null) return;
    // A port unplugged between resolve and send throws InvalidStateError.
    try {
      port.send(bytes);
    } catch {
      this.port = null;
    }
  }

  noteOn(note: number, velocity: number, channel = 0): void {
    this.send(encodeNoteOn(note, velocity, channel));
  }

  noteOff(note: number, channel = 0): void {
    this.send(encodeNoteOff(note, channel));
  }

  /** Panic: CC 123 on every channel, because we do not track what is sounding. */
  allNotesOff(): void {
    for (let ch = 0; ch < MIDI_CHANNELS; ch += 1) this.send(encodeAllNotesOff(ch));
  }

  sendClock(): void { this.send([MIDI_CLOCK]); }
  start(): void { this.send([MIDI_START]); }
  stop(): void { this.send([MIDI_STOP]); }

  controlChange(cc: number, value: number, channel = 0): void {
    this.send(encodeControlChange(cc, value, channel));
  }
}

// --- Audio output routing ---

export interface AudioOutputInfo { deviceId: string; label: string; isKo2: boolean }

export async function listAudioOutputs(): Promise<AudioOutputInfo[]> {
  if (typeof navigator === 'undefined') return [];
  const media = (navigator as unknown as MediaNavigatorLike).mediaDevices;
  const enumerate = media?.enumerateDevices;
  if (media === undefined || typeof enumerate !== 'function') return [];
  let devices: MediaDeviceLike[];
  try {
    devices = await enumerate.call(media);
  } catch {
    return [];
  }
  return devices
    .filter((d) => d.kind === 'audiooutput')
    .map((d) => ({ deviceId: d.deviceId, label: d.label, isKo2: isKo2Name(d.label) }));
}

/**
 * True when the browser is withholding device labels: `enumerateDevices` blanks
 * them until microphone permission has been granted at least once. The UI must
 * say so rather than render a list of empty rows.
 */
export function hasUnlabelledOutputs(devices: readonly { label: string }[]): boolean {
  return devices.some((d) => d.label.trim() === '');
}

/** Why `setSinkId` is or is not usable, for display next to the selector. */
export function sinkIdStatus(): { available: boolean; reason: string } {
  if (typeof AudioContext === 'undefined') {
    return { available: false, reason: 'No Web Audio in this environment' };
  }
  const proto = AudioContext.prototype as unknown as SinkCapable;
  const available = typeof proto.setSinkId === 'function';
  return {
    available,
    reason: available
      ? 'AudioContext.setSinkId available'
      : 'AudioContext.setSinkId is Chrome-only — Safari and iOS do not implement it',
  };
}

/** Returns false rather than throwing where `setSinkId` is missing or the device is gone. */
export async function routeOutputTo(ctx: AudioContext, deviceId: string): Promise<boolean> {
  const sinkable = ctx as unknown as SinkCapable;
  if (typeof sinkable.setSinkId !== 'function') return false;
  try {
    await sinkable.setSinkId(deviceId);
    return true;
  } catch {
    return false;
  }
}

// --- WebUSB identification (descriptors only) ---

export interface Ko2UsbInfo {
  productName: string | null;
  manufacturerName: string | null;
  serialNumber: string | null;
  vendorId: number;
  productId: number;
  configurations: number;
}

export function isWebUsbSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (navigator as unknown as UsbNavigatorLike).usb !== undefined;
}

/**
 * Show the browser's device chooser and read the chosen device's descriptor.
 * MUST be called from a user gesture — never on mount. Null when WebUSB is
 * missing or the chooser is dismissed.
 *
 * The filter list is empty on purpose: TE's vendor/product IDs are not
 * documented anywhere we can verify, and guessing one would hide the real
 * device from the chooser. Read-only — no `claimInterface`, no transfers, no
 * attempt at slot or memory data, all of which need TE's undocumented protocol.
 */
export async function requestKo2Device(): Promise<Ko2UsbInfo | null> {
  if (typeof navigator === 'undefined') return null;
  const usb = (navigator as unknown as UsbNavigatorLike).usb;
  if (usb === undefined) return null;
  try {
    const device = await usb.requestDevice({ filters: [] });
    return {
      productName: device.productName ?? null,
      manufacturerName: device.manufacturerName ?? null,
      serialNumber: device.serialNumber ?? null,
      vendorId: device.vendorId,
      productId: device.productId,
      configurations: device.configurations?.length ?? 0,
    };
  } catch {
    return null;
  }
}

// --- Capability reporting ---

export interface CapabilityStatus {
  id: 'midi' | 'audio-routing' | 'usb-identify' | 'sample-transfer';
  label: string;
  available: boolean;
  reason: string;
}

function secureContext(): boolean {
  const flag = (globalThis as { isSecureContext?: boolean }).isSecureContext;
  return typeof flag === 'boolean' ? flag : true;
}

export function describeCapabilities(): CapabilityStatus[] {
  const secure = secureContext();
  const midi = isWebMidiSupported();
  const sink = sinkIdStatus();
  const usb = isWebUsbSupported();
  const insecure = 'Requires HTTPS or localhost';

  return [
    {
      id: 'midi',
      label: 'MIDI out',
      available: midi,
      reason: midi
        ? 'WebMIDI available'
        : !secure
          ? insecure
          : 'Safari and iOS do not implement WebMIDI — use Chrome on desktop',
    },
    {
      id: 'audio-routing',
      label: 'USB audio out',
      available: sink.available,
      reason: sink.available
        ? 'Routes into the device sampler — needs K.O. II firmware 2.5+ for USB audio'
        : sink.reason,
    },
    {
      id: 'usb-identify',
      label: 'USB identify',
      available: usb,
      reason: usb ? 'WebUSB available' : !secure ? insecure : 'This browser has no WebUSB',
    },
    {
      id: 'sample-transfer',
      label: 'Sample transfer',
      available: false,
      // Stated plainly and permanently: this is not a missing feature, it is a
      // protocol we do not have and will not guess at.
      reason: "TE's sample protocol is undocumented — transfer happens through "
        + 'their EP Sample Tool',
    },
  ];
}
