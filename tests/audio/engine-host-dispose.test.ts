import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineHost } from '@/audio/engine-host';

/*
 * EngineHost.dispose() — the teardown that was missing.
 *
 * Without it, every remount of the controlling hook built a SECOND
 * AudioWorkletNode onto the same destination while the first kept running, and
 * two engines summing into one output comb-filter each other. That is a bug you
 * hear rather than see, so it is worth pinning with assertions instead of ears.
 *
 * Vitest runs in a node environment here, so the Web Audio surface EngineHost
 * touches is stubbed — deliberately minimal, and counting rather than faking
 * behaviour, because what is under test is what gets released.
 */

interface FakePort {
  postMessage: (msg: unknown, transfer?: unknown) => void;
  close: () => void;
  onmessage: ((e: MessageEvent<unknown>) => void) | null;
  messages: unknown[];
  closed: number;
}

interface FakeNode {
  port: FakePort;
  connect: () => void;
  disconnect: () => void;
  disconnected: number;
}

interface FakeContext {
  state: string;
  sampleRate: number;
  destination: object;
  audioWorklet: { addModule: (url: string) => Promise<void> };
  createAnalyser: () => { fftSize: number; smoothingTimeConstant: number; connect: () => void; disconnect: () => void; disconnected: number };
  createGain: () => { gain: { value: number }; connect: () => void };
  resume: () => Promise<void>;
  close: () => Promise<void>;
  closed: number;
}

const contexts: FakeContext[] = [];
const nodes: FakeNode[] = [];
const analysers: { disconnected: number }[] = [];

function makeContext(): FakeContext {
  const ctx: FakeContext = {
    state: 'running',
    sampleRate: 48000,
    destination: {},
    audioWorklet: { addModule: async (): Promise<void> => undefined },
    createAnalyser: () => {
      const a = {
        fftSize: 0,
        smoothingTimeConstant: 0,
        connect: (): void => undefined,
        disconnect: (): void => { a.disconnected += 1; },
        disconnected: 0,
      };
      analysers.push(a);
      return a;
    },
    createGain: () => ({ gain: { value: 0 }, connect: (): void => undefined }),
    resume: async (): Promise<void> => { ctx.state = 'running'; },
    close: async (): Promise<void> => { ctx.closed += 1; ctx.state = 'closed'; },
    closed: 0,
  };
  contexts.push(ctx);
  return ctx;
}

function makeNode(): FakeNode {
  const node: FakeNode = {
    port: {
      messages: [],
      closed: 0,
      onmessage: null,
      postMessage: (msg: unknown): void => { node.port.messages.push(msg); },
      close: (): void => { node.port.closed += 1; },
    },
    connect: (): void => undefined,
    disconnect: (): void => { node.disconnected += 1; },
    disconnected: 0,
  };
  nodes.push(node);
  return node;
}

type Global = Record<'AudioContext' | 'AudioWorkletNode', unknown>;

beforeEach(() => {
  contexts.length = 0;
  nodes.length = 0;
  analysers.length = 0;
  (globalThis as unknown as Global).AudioContext = function AudioContextStub(): FakeContext {
    return makeContext();
  } as unknown as typeof AudioContext;
  (globalThis as unknown as Global).AudioWorkletNode = function AudioWorkletNodeStub(): FakeNode {
    return makeNode();
  } as unknown as typeof AudioWorkletNode;
});

afterEach(() => {
  (globalThis as unknown as Global).AudioContext = undefined;
  (globalThis as unknown as Global).AudioWorkletNode = undefined;
});

describe('EngineHost.dispose', () => {
  it('is safe before start() and safe to call twice', async () => {
    const host = new EngineHost();
    await expect(host.dispose()).resolves.toBeUndefined();
    await expect(host.dispose()).resolves.toBeUndefined();
    expect(contexts).toHaveLength(0);
    expect(host.context).toBeNull();
    expect(host.analyser).toBeNull();
  });

  it('releases the node, the analyser and the audio device', async () => {
    const host = new EngineHost();
    await host.start();
    expect(contexts).toHaveLength(1);
    expect(nodes).toHaveLength(1);

    await host.dispose();

    const ctx = contexts[0];
    const node = nodes[0];
    const analyser = analysers[0];
    expect(node?.port.messages).toContainEqual({ type: 'allNotesOff' });
    expect(node?.port.onmessage).toBeNull();
    expect(node?.port.closed).toBe(1);
    expect(node?.disconnected).toBe(1);
    expect(analyser?.disconnected).toBe(1);
    expect(ctx?.closed).toBe(1);
    expect(host.context).toBeNull();
    expect(host.running).toBe(false);
  });

  it('does not close the device twice when disposed twice', async () => {
    const host = new EngineHost();
    await host.start();
    await host.dispose();
    await host.dispose();
    expect(contexts[0]?.closed).toBe(1);
  });

  /*
   * The one that actually hangs a UI. stopCapture() resolves from a worklet
   * message, and after dispose that message can never arrive — so an awaited
   * capture would sit there forever, leaving the record button lit.
   */
  it('settles a pending capture instead of leaving it hanging', async () => {
    const host = new EngineHost();
    await host.start();
    expect(host.startCapture()).toBe(true);

    const pending = host.stopCapture();
    await host.dispose();

    await expect(pending).resolves.toBeNull();
    expect(host.isRecording).toBe(false);
  });

  /**
   * After a dispose the ref holder builds a fresh host, but a host that is
   * restarted directly must not resume the context it just closed — that is
   * how "power on does nothing" happens.
   */
  it('builds a new context when started again after dispose', async () => {
    const host = new EngineHost();
    await host.start();
    await host.dispose();
    await host.start();
    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.state).toBe('running');
    expect(host.running).toBe(true);
  });
});

/*
 * Latency reporting and the buffer profile.
 *
 * The number this produces is meant to be typed into a DAW's track delay, so
 * being confidently wrong is worse than admitting ignorance — baseLatency and
 * outputLatency are both optional in the spec and some browsers report neither.
 */
describe('latency readout', () => {
  it('says it has no number rather than claiming zero before start', () => {
    const host = new EngineHost();
    const l = host.latency;
    expect(l.reported).toBe(false);
    expect(l.totalMs).toBe(0);
  });

  it('defaults to the most responsive profile', () => {
    expect(new EngineHost().latencyProfile).toBe('responsive');
  });

  /* latencyHint is fixed at construction, so a profile change while stopped
   * must still be remembered for the next start rather than silently ignored. */
  it('remembers a profile set while stopped', async () => {
    const host = new EngineHost();
    await host.setLatencyProfile('stable');
    expect(host.latencyProfile).toBe('stable');
  });

  it('is safe to set the profile it already has', async () => {
    const host = new EngineHost();
    await host.setLatencyProfile('balanced');
    await host.setLatencyProfile('balanced');
    expect(host.latencyProfile).toBe('balanced');
  });
});
