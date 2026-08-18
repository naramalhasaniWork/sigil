'use client';

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Panel } from '@/ui/components/panel';
import {
  MidiOut,
  describeCapabilities,
  hasUnlabelledOutputs,
  isWebUsbSupported,
  listAudioOutputs,
  listMidiPorts,
  requestKo2Device,
  routeOutputTo,
  releaseAudioRouting,
  type AudioOutputInfo,
  type CapabilityStatus,
  type Ko2MidiPorts,
  type Ko2UsbInfo,
  type MidiPortInfo,
} from '@/audio/ko2-bridge';

const INK = '#F5F1E6';
const GROUND = '#0E0E0E';
const ANALOG = '#FF6B6B';
const PHYSICAL = '#FFD93D';

/**
 * `--muted` on `--panel` measures 4.14:1, which fails AA at 9px. Anything a
 * reader actually needs is `--ink`; muted is reserved for inert decoration.
 */
const readable = { color: INK } as const;

export interface DevicePanelProps {
  /** The live context from EngineHost, if started. Routing needs a real one. */
  audioContext?: AudioContext | null;
  /** Fires whenever the chosen MIDI output changes, including to null. */
  onMidiOutChange?: (out: MidiOut | null) => void;
}

function StatusRow({ cap }: { cap: CapabilityStatus }): JSX.Element {
  return (
    <li className="flex flex-col gap-1 border-[3px] p-2" style={{ borderColor: INK }}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="label" style={readable}>{cap.label}</span>
        <span
          className="label"
          style={{ color: cap.available ? PHYSICAL : ANALOG }}
        >
          {cap.available ? 'Available' : 'Unavailable'}
        </span>
      </div>
      <p className="text-[11px] leading-snug" style={readable}>{cap.reason}</p>
    </li>
  );
}

function PortRow({ port, selected, onSelect }: {
  port: MidiPortInfo;
  selected?: boolean;
  onSelect?: (id: string) => void;
}): JSX.Element {
  const name = port.name === '' ? 'Unnamed port' : port.name;
  const detail = port.manufacturer === '' ? 'Unknown maker' : port.manufacturer;
  const body = (
    <>
      <span className="flex-1 truncate text-[11px] font-bold" style={readable}>{name}</span>
      <span className="shrink-0 text-[11px]" style={readable}>{detail}</span>
      {port.isKo2 && (
        <span
          className="label shrink-0 border-[2px] px-1 py-0.5"
          style={{ color: PHYSICAL, borderColor: PHYSICAL }}
        >
          K.O. II?
        </span>
      )}
    </>
  );

  if (onSelect === undefined) {
    return (
      <li className="flex min-h-11 items-center gap-2 border-[3px] px-2" style={{ borderColor: INK }}>
        {body}
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={(): void => onSelect(port.id)}
        aria-pressed={selected === true}
        className="hard flex min-h-11 w-full items-center gap-2 border-[3px] px-2 text-left"
        style={{
          borderColor: INK,
          background: selected === true ? INK : GROUND,
          color: selected === true ? GROUND : INK,
        }}
      >
        {body}
      </button>
    </li>
  );
}

/**
 * What SIGIL can and cannot do with a K.O. II, stated without embellishment.
 *
 * There are no memory bars and no slot counts in here on purpose: reading them
 * would need TE's undocumented protocol, so any number shown would be invented.
 */
export function DevicePanel({ audioContext, onMidiOutChange }: DevicePanelProps): JSX.Element {
  const [caps, setCaps] = useState<CapabilityStatus[]>([]);
  const [ports, setPorts] = useState<Ko2MidiPorts>({ inputs: [], outputs: [] });
  const [outId, setOutId] = useState<string | null>(null);
  const [sinks, setSinks] = useState<AudioOutputInfo[]>([]);
  const [sinkId, setSinkId] = useState<string>('');
  const [routeNote, setRouteNote] = useState<string | null>(null);
  const [usb, setUsb] = useState<Ko2UsbInfo | null>(null);
  const [usbNote, setUsbNote] = useState<string | null>(null);

  const notify = useRef(onMidiOutChange);
  notify.current = onMidiOutChange;

  // Capabilities are read on the client only — they are all navigator-shaped
  // and would render differently on the server.
  useEffect(() => {
    setCaps(describeCapabilities());
    let live = true;
    void listMidiPorts().then((p): void => { if (live) setPorts(p); });
    void listAudioOutputs().then((d): void => { if (live) setSinks(d); });
    return (): void => { live = false; };
  }, []);

  const outRef = useRef<MidiOut | null>(null);

  useEffect(() => {
    const out = outId === null ? null : new MidiOut(outId);
    outRef.current = out;
    notify.current?.(out);
    return (): void => { out?.close(); };
  }, [outId]);

  /**
   * Hand the hardware back without unplugging it.
   *
   * The KO II is also the target of Teenage Engineering's own EP Sample Tool, and
   * swapping between the two by pulling the cable is exactly the friction the kit
   * exporter exists to remove. This silences anything sounding on the device,
   * drops the MIDI port and points audio back at the system default.
   */
  const disconnect = useCallback((): void => {
    outRef.current?.close();
    outRef.current = null;
    setOutId(null);
    notify.current?.(null);

    if (audioContext !== null && audioContext !== undefined) {
      void releaseAudioRouting(audioContext).then((ok): void => {
        setSinkId('');
        setRouteNote(
          ok
            ? 'Released. Audio is back on your system output and the EP Sample Tool can take the device.'
            : 'MIDI released. Audio routing was never active in this browser, so there is nothing to hand back.',
        );
      });
      return;
    }
    setRouteNote('Released. The EP Sample Tool can take the device now.');
  }, [audioContext]);

  const connected = outId !== null || sinkId !== '';

  const selectOut = useCallback((id: string): void => {
    setOutId((current) => (current === id ? null : id));
  }, []);

  const route = useCallback((): void => {
    if (audioContext === null || audioContext === undefined) {
      setRouteNote('Start the audio engine first — there is no context to route.');
      return;
    }
    if (sinkId === '') return;
    void routeOutputTo(audioContext, sinkId).then((ok): void => {
      setRouteNote(ok
        ? 'Output routed. Audio now leaves through the selected device.'
        : 'Routing refused. setSinkId is Chrome-only, and the device must still be attached.');
    });
  }, [audioContext, sinkId]);

  const identify = useCallback((): void => {
    if (!isWebUsbSupported()) {
      setUsbNote('This browser has no WebUSB.');
      return;
    }
    void requestKo2Device().then((info): void => {
      setUsb(info);
      setUsbNote(info === null ? 'No device chosen.' : null);
    });
  }, []);

  const labelsHidden = sinks.length > 0 && hasUnlabelledOutputs(sinks);

  return (
    <Panel title="K.O. II" accent={ANALOG}>
      <div className="flex flex-col gap-5">
        <ul className="flex flex-col gap-2">
          {caps.map((cap) => <StatusRow key={cap.id} cap={cap} />)}
        </ul>

        <section className="flex flex-col gap-2" aria-label="MIDI outputs">
          <span className="label" style={readable}>MIDI out — tap to send notes</span>
          {ports.outputs.length === 0
            ? <p className="text-[11px]" style={readable}>No MIDI outputs found.</p>
            : (
              <ul className="flex flex-col gap-2">
                {ports.outputs.map((p) => (
                  <PortRow key={p.id} port={p} selected={p.id === outId} onSelect={selectOut} />
                ))}
              </ul>
            )}
        </section>

        <section
          className="flex flex-col gap-2 border-[3px] p-2.5"
          aria-label="Device connection"
          style={{ borderColor: connected ? PHYSICAL : INK }}
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="label" style={{ color: connected ? PHYSICAL : INK }}>
              {connected ? 'SIGIL is holding the device' : 'Device is free'}
            </span>
            <button
              type="button"
              disabled={!connected}
              onClick={disconnect}
              className="hard border-[3px] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.16em] disabled:opacity-40"
              style={{ borderColor: INK, background: connected ? ANALOG : 'transparent', color: connected ? '#0E0E0E' : INK }}
            >
              Disconnect
            </button>
          </div>
          <p className="text-[11px] leading-snug" style={readable}>
            Hands the K.O. II back so Teenage Engineering&apos;s EP Sample Tool can take it,
            without unplugging anything. Anything still sounding on the device is silenced first.
          </p>
          <p className="text-[11px] leading-snug" style={readable}>
            Worth knowing: SIGIL never claims the USB interface — it only ever reads the
            descriptor — so the Sample Tool can always take the device over USB. What this
            releases is the MIDI port and the audio routing.
          </p>
        </section>

        <section className="flex flex-col gap-2" aria-label="MIDI inputs">
          <span className="label" style={readable}>MIDI in</span>
          {ports.inputs.length === 0
            ? <p className="text-[11px]" style={readable}>No MIDI inputs found.</p>
            : (
              <ul className="flex flex-col gap-2">
                {ports.inputs.map((p) => <PortRow key={p.id} port={p} />)}
              </ul>
            )}
        </section>

        <section className="flex flex-col gap-2" aria-label="Audio output routing">
          <label className="label" style={readable} htmlFor="ko2-sink">Audio output</label>
          {labelsHidden ? (
            <p className="text-[11px] leading-snug" style={readable}>
              Your browser hides output device names until microphone permission has been
              granted at least once, so this list would be blank. Grant it, then reload.
            </p>
          ) : sinks.length === 0 ? (
            <p className="text-[11px]" style={readable}>
              No selectable audio outputs — this browser does not expose them.
            </p>
          ) : (
            <div className="flex flex-wrap items-stretch gap-2">
              <select
                id="ko2-sink"
                value={sinkId}
                onChange={(e): void => setSinkId(e.target.value)}
                className="min-h-11 flex-1 border-[3px] px-2 text-[11px] font-bold"
                style={{ borderColor: INK, background: GROUND, color: INK }}
              >
                <option value="">Select a device…</option>
                {sinks.map((s) => (
                  <option key={s.deviceId} value={s.deviceId}>
                    {s.isKo2 ? `${s.label} — likely K.O. II` : s.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={route}
                disabled={sinkId === ''}
                className="hard min-h-11 border-[3px] px-3 text-xs font-bold uppercase
                           tracking-[0.18em] disabled:opacity-40"
                style={{ borderColor: INK, background: GROUND, color: INK }}
              >
                Route
              </button>
            </div>
          )}
          {routeNote !== null && (
            <p role="status" className="text-[11px] leading-snug" style={readable}>{routeNote}</p>
          )}
        </section>

        <section className="flex flex-col gap-2" aria-label="USB identification">
          <span className="label" style={readable}>USB identify</span>
          <button
            type="button"
            onClick={identify}
            className="hard min-h-11 border-[3px] px-3 text-xs font-bold uppercase
                       tracking-[0.18em]"
            style={{ borderColor: INK, background: GROUND, color: INK }}
          >
            Identify device
          </button>
          <p className="text-[11px] leading-snug" style={readable}>
            Opens the browser&rsquo;s device chooser and reads the descriptor. Nothing is
            written to the device and no data is transferred.
          </p>
          {usb !== null && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-[3px] p-2 text-[11px]"
              style={{ borderColor: INK, ...readable }}>
              <dt className="label" style={readable}>Product</dt>
              <dd>{usb.productName ?? 'not reported'}</dd>
              <dt className="label" style={readable}>Maker</dt>
              <dd>{usb.manufacturerName ?? 'not reported'}</dd>
              <dt className="label" style={readable}>Serial</dt>
              <dd>{usb.serialNumber ?? 'not reported'}</dd>
              <dt className="label" style={readable}>IDs</dt>
              <dd className="tabular-nums">
                {`0x${usb.vendorId.toString(16).padStart(4, '0')}`}
                {' / '}
                {`0x${usb.productId.toString(16).padStart(4, '0')}`}
              </dd>
              <dt className="label" style={readable}>Configs</dt>
              <dd className="tabular-nums">{usb.configurations}</dd>
            </dl>
          )}
          {usbNote !== null && (
            <p role="status" className="text-[11px]" style={readable}>{usbNote}</p>
          )}
        </section>

        <section className="flex flex-col gap-2" aria-label="Getting samples onto the device">
          <span className="label" style={readable}>Getting samples across</span>
          <p className="text-[11px] leading-snug" style={readable}>
            SIGIL cannot push samples to the K.O. II. Teenage Engineering has never
            published the transfer protocol, so transfer happens through their own EP
            Sample Tool. Export your kit as a zip here, unzip it, then drag the WAVs into
            the EP Sample Tool in Chrome and let it write them to the device. The bounce
            already renders at the K.O. II&rsquo;s native 16-bit / 46 875 Hz, so the tool
            has nothing left to convert.
          </p>
        </section>
      </div>
    </Panel>
  );
}
