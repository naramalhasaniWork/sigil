import { EngineHost } from './engine-host';
import { addressOf, sectionOf, type ParamSection } from './param-space';
import { ENGINES, DEFAULT_ENGINE_ID } from '@/dsp/registry';
import { FX_DESCRIPTOR } from '@/dsp/fx-descriptor';
import { FX_MAGIC_DESCRIPTOR } from '@/dsp/fx-magic-descriptor';
import type { EngineDescriptor } from './types';

/**
 * The VST3 bridge.
 *
 * In the browser the audio engine is an AudioWorklet and `EngineHost` talks to
 * it over a MessagePort. Inside the plugin there is no worklet at all — the C++
 * port under native/src IS the engine, and it is driven by the host's parameter
 * list. So the same UI needs the same facade pointed somewhere else, which is
 * what this file is: an `EngineHost` whose `setParam` moves a VST3 parameter
 * instead of posting to a worklet.
 *
 * Two rules shape everything here.
 *
 * 1. Parameters are addressed by descriptor ID, never by position. The flat
 *    address space of param-space.ts is a per-engine INDEX, which is exactly
 *    the thing src/audio/patch-format.ts exists to stop us persisting: insert
 *    one parameter into a descriptor and every index after it means something
 *    else. Across the bridge a parameter is `"<engineId>.<paramId>"`,
 *    `"fx.<paramId>"` or `"magic.<paramId>"` — the same strings the plugin
 *    registers with the host, so an automation lane keeps its meaning.
 *
 * 2. The plugin is the source of truth on open. The UI restores its own
 *    localStorage session on mount, and in a plugin that session is a stale
 *    sound from a different project — if it were allowed to push, opening a
 *    saved track would silently overwrite it. So outbound writes are DROPPED
 *    until the host has sent its snapshot, and the snapshot is then poured into
 *    the UI. "My finished track opens sounding different" is the failure this
 *    prevents.
 */

/** What JUCE injects when `withNativeIntegrationEnabled()` is set. */
interface JuceBackend {
  addEventListener(eventId: string, fn: (payload: unknown) => void): unknown;
  emitEvent(eventId: string, payload: unknown): void;
}

interface JuceWindow {
  __JUCE__?: { backend?: JuceBackend };
}

/** Event ids. Kept short; they are typed by hand on both sides. */
const TO_HOST = 'sigilFromUi';
const FROM_HOST = 'sigilFromHost';

export function juceBackend(): JuceBackend | null {
  if (typeof window === 'undefined') return null;
  const backend = (window as unknown as JuceWindow).__JUCE__?.backend;
  if (backend === undefined) return null;
  if (typeof backend.emitEvent !== 'function') return null;
  if (typeof backend.addEventListener !== 'function') return null;
  return backend;
}

/**
 * True only inside the plugin's WebView. Deliberately a function rather than a
 * module-level constant: this module is evaluated during the static export's
 * prerender, where `window` does not exist, and a constant captured there would
 * be wrong for the rest of the page's life.
 */
export function inPlugin(): boolean {
  return juceBackend() !== null;
}

/** Everything the plugin holds, in the shape the session restore already reads. */
export interface HostSnapshot {
  engineId: string;
  engines: Record<string, Record<string, number>>;
  fx: Record<string, number>;
  magic: Record<string, number>;
  /** What the player called this instance. Empty means it still answers to the
   *  name its mark was dealt. */
  name: string;
  /** Which identity this instance was dealt — see `identityFor`. */
  mark: number;
}

/** One parameter moved by the host — already resolved to a flat address. */
export interface RemoteUpdate {
  /**
   * Present only when the host moved the engine selector.
   *
   * The current plugin never sets it: an engine change is sent as a whole
   * snapshot instead, because the values this page holds for an engine it has
   * not been showing are stale and a delta cannot repair them. It stays on the
   * wire, and `useInstrument` still handles it WITHOUT pushing anything back,
   * because an older plugin paired with this page is exactly the case where
   * pushing would write factory defaults over a restored patch.
   */
  engineId?: string;
  /** Flat addresses, as `setParamByAddress` takes them. */
  params: ReadonlyArray<readonly [number, number]>;
}

function descriptorFor(engineId: string): EngineDescriptor | null {
  if (engineId === 'fx') return FX_DESCRIPTOR;
  if (engineId === 'magic') return FX_MAGIC_DESCRIPTOR;
  return ENGINES.find((e) => e.descriptor.id === engineId)?.descriptor ?? null;
}

/**
 * `"analog.cutoff"` from an engine id and a flat address. Returns null for an
 * address the descriptors do not cover, which is how a stale index from an
 * older build stops rather than lands on the wrong knob.
 */
function idForAddress(activeEngineId: string, address: number): string | null {
  const { section, index } = sectionOf(address);
  const owner = section === 'fx' ? 'fx' : section === 'magic' ? 'magic' : activeEngineId;
  const descriptor = descriptorFor(owner);
  const param = descriptor?.params[index];
  if (param === undefined) return null;
  return `${owner}.${param.id}`;
}

/** The inverse. `null` when the id belongs to an engine that is not on screen. */
function addressForId(activeEngineId: string, id: string): number | null {
  const dot = id.indexOf('.');
  if (dot <= 0) return null;
  const owner = id.slice(0, dot);
  const paramId = id.slice(dot + 1);

  let section: ParamSection;
  if (owner === 'fx') section = 'fx';
  else if (owner === 'magic') section = 'magic';
  else if (owner === activeEngineId) section = 'engine';
  else return null;

  const descriptor = descriptorFor(owner);
  if (descriptor === null) return null;
  const index = descriptor.params.findIndex((p) => p.id === paramId);
  if (index < 0) return null;
  return addressOf(section, index);
}

/**
 * How close is close enough to call it the same value.
 *
 * The round trip through a VST3 parameter is a normalised float, so a value the
 * UI just sent comes back a few parts in ten million different. Echoing that
 * back into React state mid-drag makes a knob stutter against the pointer. This
 * is a relative epsilon so it holds for a 0..1 mix as well as a 20000 Hz cutoff.
 */
function sameValue(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= scale * 1e-5;
}

export class PluginEngineHost extends EngineHost {
  private readonly backend: JuceBackend;

  /** False until the host's snapshot lands. See rule 2 in the file header. */
  private synced = false;

  private activeEngineId: string = DEFAULT_ENGINE_ID;

  /** Last value written per id, so an echo of our own write can be dropped. */
  private readonly sent = new Map<string, number>();

  /** The whole instrument as the plugin holds it. */
  onHydrate: ((snapshot: HostSnapshot) => void) | null = null;

  /** One or more parameters moved by the host: automation, or a preset in the DAW. */
  onRemote: ((update: RemoteUpdate) => void) | null = null;

  constructor(backend: JuceBackend) {
    super();
    this.backend = backend;
    backend.addEventListener(FROM_HOST, (payload) => { this.receive(payload); });
    // Asking is what starts the conversation: the plugin replies with a
    // snapshot, and only then are our writes allowed out.
    backend.emitEvent(TO_HOST, { t: 'ready' });
  }

  // -- inbound ------------------------------------------------------------

  private receive(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return;
    const msg = payload as Record<string, unknown>;

    if (msg['t'] === 'snapshot') {
      const snapshot = this.readSnapshot(msg);
      if (snapshot === null) return;
      this.activeEngineId = snapshot.engineId;
      this.sent.clear();
      for (const [owner, values] of Object.entries(snapshot.engines)) {
        for (const [id, v] of Object.entries(values)) this.sent.set(`${owner}.${id}`, v);
      }
      for (const [id, v] of Object.entries(snapshot.fx)) this.sent.set(`fx.${id}`, v);
      for (const [id, v] of Object.entries(snapshot.magic)) this.sent.set(`magic.${id}`, v);
      this.synced = true;
      this.onHydrate?.(snapshot);
      return;
    }

    if (msg['t'] === 'params') {
      const raw = msg['v'];
      const engineId = typeof msg['engine'] === 'string' ? msg['engine'] : undefined;
      if (engineId !== undefined) this.activeEngineId = engineId;

      const params: Array<readonly [number, number]> = [];
      if (typeof raw === 'object' && raw !== null) {
        for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof value !== 'number' || !Number.isFinite(value)) continue;
          const mine = this.sent.get(id);
          if (mine !== undefined && sameValue(mine, value)) continue;
          this.sent.set(id, value);
          const address = addressForId(this.activeEngineId, id);
          if (address !== null) params.push([address, value]);
        }
      }
      if (engineId !== undefined || params.length > 0) {
        this.onRemote?.({ ...(engineId !== undefined ? { engineId } : {}), params });
      }
    }
  }

  private readSnapshot(msg: Record<string, unknown>): HostSnapshot | null {
    const engineId = msg['engineId'];
    if (typeof engineId !== 'string') return null;
    const numbers = (v: unknown): Record<string, number> => {
      const out: Record<string, number> = {};
      if (typeof v !== 'object' || v === null) return out;
      for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
        if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
      }
      return out;
    };
    const engines: Record<string, Record<string, number>> = {};
    const rawEngines = msg['engines'];
    if (typeof rawEngines === 'object' && rawEngines !== null) {
      for (const [k, v] of Object.entries(rawEngines as Record<string, unknown>)) {
        engines[k] = numbers(v);
      }
    }
    const mark = msg['mark'];
    return {
      engineId,
      engines,
      fx: numbers(msg['fx']),
      magic: numbers(msg['magic']),
      name: typeof msg['name'] === 'string' ? msg['name'] : '',
      mark: typeof mark === 'number' && Number.isFinite(mark) ? Math.trunc(mark) : 0,
    };
  }

  // -- outbound -----------------------------------------------------------

  private send(payload: Record<string, unknown>): void {
    this.backend.emitEvent(TO_HOST, payload);
  }

  private write(id: string, value: number): [string, number] | null {
    const previous = this.sent.get(id);
    if (previous !== undefined && sameValue(previous, value)) return null;
    this.sent.set(id, value);
    return [id, value];
  }

  /**
   * No AudioContext, no worklet, no audio device. The plugin's `processBlock`
   * is the audio thread; this facade only moves parameters. Resolving straight
   * away is what lets the UI's power gesture (and the auto-power in
   * `useInstrument`) mark the instrument as running.
   */
  override async start(): Promise<void> {
    return Promise.resolve();
  }

  override async dispose(): Promise<void> {
    this.send({ t: 'panic' });
    return Promise.resolve();
  }

  override get running(): boolean {
    return true;
  }

  override setEngine(engineId: string): void {
    this.activeEngineId = engineId;
    if (!this.synced) return;
    this.send({ t: 'engine', id: engineId });
  }

  override setParam(address: number, value: number): void {
    if (!this.synced) return;
    const id = idForAddress(this.activeEngineId, address);
    if (id === null) return;
    const change = this.write(id, value);
    if (change === null) return;
    this.send({ t: 'param', id: change[0], v: change[1] });
  }

  override setAllParams(values: Float32Array): void {
    if (!this.synced) return;
    const out: Record<string, number> = {};
    for (let i = 0; i < values.length; i++) {
      const id = idForAddress(this.activeEngineId, addressOf('engine', i));
      if (id === null) continue;
      const change = this.write(id, values[i] as number);
      if (change !== null) out[change[0]] = change[1];
    }
    if (Object.keys(out).length > 0) this.send({ t: 'params', v: out });
  }

  /**
   * Renames this instance.
   *
   * Not guarded by `synced`, unlike every other outbound call. The rule those
   * follow exists to stop a stale SOUND being poured over a restored one, and a
   * name the player just typed is neither stale nor a sound — dropping it would
   * mean a rename made in the first second after opening silently did nothing.
   */
  setInstanceName(name: string): void {
    this.send({ t: 'name', v: name });
  }

  override noteOn(note: number, velocity: number): void {
    this.send({ t: 'note', on: true, note, vel: velocity });
  }

  override noteOff(note: number): void {
    this.send({ t: 'note', on: false, note, vel: 0 });
  }

  override allNotesOff(): void {
    this.send({ t: 'panic' });
  }

  /**
   * Tuning, sampling and capture do not cross this bridge yet — see the report.
   * They are overridden to no-ops rather than left inherited, because the
   * inherited versions post to a worklet port that is permanently null here and
   * would silently do nothing anyway; being explicit is the difference between
   * "not wired" and "quietly broken".
   */
  override setTuning(): void {}
  override loadSample(): void {}
  override startCapture(): boolean { return false; }
  override stopCapture(): Promise<null> { return Promise.resolve(null); }
}

/**
 * The one seam. In a browser this is `new EngineHost()` and nothing about the
 * web app changes; inside the plugin it is the bridge above.
 */
export function createEngineHost(): EngineHost {
  const backend = juceBackend();
  return backend === null ? new EngineHost() : new PluginEngineHost(backend);
}
