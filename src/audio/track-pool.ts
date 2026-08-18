import { packParams } from './param-transport';

/**
 * One AudioWorkletNode per track, so a track's engine and patch are actually
 * ITS OWN.
 *
 * The decisive fact this is built on: `SigilProcessor` builds a VoiceManager
 * for every engine but renders exactly one — one `active` manager, one FxChain,
 * one MagicChain, PER PROCESSOR INSTANCE. A processor instance is per node, so
 * N tracks = N nodes, each independently `setEngine`'d and each carrying its
 * own FX and Character chains, with zero changes to the worklet.
 *
 * Before this existed the whole arrangement played through the single
 * `EngineHost` node, which meant a track's clips sounded like whatever the UI
 * happened to be pointed at: record a physical part on one track and an FM part
 * on another and you got two of the same. That is a piano roll, not an
 * arrangement.
 *
 * The pool BORROWS the context and the analyser from `EngineHost` rather than
 * opening its own. One AudioContext per page is the rule — browsers cap how
 * many a page may hold — and hanging every track off the same analyser is what
 * keeps Scope and Spectrum showing the mix without either of them changing.
 *
 * The selected track deliberately has NO node here: it plays through the
 * EngineHost, which is the thing the tabs are editing, the thing Panic reaches
 * and the thing capture and bounce read. So the pool holds at most
 * `MAX_TRACKS - 1` nodes, and what you hear from the keyboard is always what
 * the surface in front of you says it is.
 */
export class TrackPool {
  private ctx: AudioContext | null = null;
  private sink: AudioNode | null = null;
  private nodes = new Map<string, { node: AudioWorkletNode; gain: GainNode; engineId: string }>();
  /** midi notes currently held per track, so a release never gets lost. */
  private held = new Map<string, Set<number>>();

  /** Point the pool at a running EngineHost's graph. Idempotent. */
  attach(ctx: AudioContext, sink: AudioNode): void {
    if (this.ctx === ctx && this.sink === sink) return;
    this.releaseAll();
    this.dispose();
    this.ctx = ctx;
    this.sink = sink;
  }

  get attached(): boolean {
    return this.ctx !== null && this.sink !== null;
  }

  get size(): number {
    return this.nodes.size;
  }

  /**
   * Get the node for a track, building it if this is the first time. Returns
   * null when the pool is not attached — before Power, there is no graph and
   * nothing to build one on.
   */
  private nodeFor(trackId: string, engineId: string): AudioWorkletNode | null {
    const ctx = this.ctx;
    const sink = this.sink;
    if (ctx === null || sink === null) return null;

    const existing = this.nodes.get(trackId);
    if (existing !== undefined) {
      if (existing.engineId !== engineId) {
        existing.node.port.postMessage({ type: 'setEngine', engineId });
        existing.engineId = engineId;
      }
      return existing.node;
    }

    let node: AudioWorkletNode;
    try {
      node = new AudioWorkletNode(ctx, 'sigil-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
    } catch {
      // The worklet module belongs to EngineHost.start(). If it is not loaded
      // yet the track simply does not sound this time round rather than
      // throwing out of a scheduler callback.
      return null;
    }
    const gain = ctx.createGain();
    gain.gain.value = 0.8;
    node.connect(gain);
    gain.connect(sink);
    node.port.postMessage({ type: 'setEngine', engineId });
    this.nodes.set(trackId, { node, gain, engineId });
    return node;
  }

  /** Build the node and load the whole sound onto it. Safe to call repeatedly. */
  prepare(
    trackId: string,
    engineId: string,
    values: Float32Array | null,
    extras: readonly (readonly [number, number])[] = [],
  ): void {
    const node = this.nodeFor(trackId, engineId);
    if (node === null) return;
    if (values !== null && values.length > 0) {
      const pairs: Array<readonly [number, number]> = [];
      for (let i = 0; i < values.length; i++) pairs.push([i, values[i] as number]);
      const data = packParams(pairs);
      node.port.postMessage({ type: 'params', data }, [data.buffer]);
    }
    if (extras.length > 0) {
      const data = packParams(extras);
      node.port.postMessage({ type: 'params', data }, [data.buffer]);
    }
  }

  setGain(trackId: string, gain: number): void {
    const entry = this.nodes.get(trackId);
    if (entry === undefined) return;
    entry.gain.gain.value = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 0.8;
  }

  noteOn(trackId: string, midi: number, velocity: number): void {
    const entry = this.nodes.get(trackId);
    if (entry === undefined) return;
    entry.node.port.postMessage({ type: 'noteOn', note: midi, velocity });
    let set = this.held.get(trackId);
    if (set === undefined) { set = new Set(); this.held.set(trackId, set); }
    set.add(midi);
  }

  noteOff(trackId: string, midi: number): void {
    const entry = this.nodes.get(trackId);
    if (entry === undefined) return;
    entry.node.port.postMessage({ type: 'noteOff', note: midi });
    this.held.get(trackId)?.delete(midi);
  }

  /** Panic reaches every track, not the one in front of you. */
  releaseAll(): void {
    for (const [, entry] of this.nodes) entry.node.port.postMessage({ type: 'allNotesOff' });
    this.held.clear();
  }

  releaseTrack(trackId: string): void {
    const entry = this.nodes.get(trackId);
    if (entry === undefined) return;
    entry.node.port.postMessage({ type: 'allNotesOff' });
    this.held.delete(trackId);
  }

  /** Give a track's node back — it removed a track, or it became the live one. */
  release(trackId: string): void {
    const entry = this.nodes.get(trackId);
    if (entry === undefined) return;
    entry.node.port.postMessage({ type: 'allNotesOff' });
    entry.node.disconnect();
    entry.gain.disconnect();
    this.nodes.delete(trackId);
    this.held.delete(trackId);
  }

  /** Drop every node but keep the borrowed context — the page still owns it. */
  dispose(): void {
    for (const id of [...this.nodes.keys()]) this.release(id);
    this.nodes.clear();
    this.held.clear();
  }
}
