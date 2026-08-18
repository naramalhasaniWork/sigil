import {
  KO2_SAMPLE_RATE,
  applyFades,
  encodeWav16,
  normalisePeak,
  resampleSinc,
  trimToZeroCrossings,
} from './wav';

/**
 * Offline render → KO II-ready WAV.
 *
 * MEASURED FINDING (spec §8, 2026-08-17): an OfflineAudioContext finishes
 * rendering before `port.postMessage` is ever delivered, so a worklet
 * configured by postMessage renders pure silence. Every piece of patch state
 * therefore travels through `processorOptions` at node construction, and this
 * module never calls postMessage. Silence out is the failure signature, so a
 * silent render throws rather than writing a dead file.
 */

/** The construction-time contract with the worklet processor. */
export interface BounceProcessorOptions {
  readonly mode: 'bounce';
  readonly engineId: string;
  readonly patchParams: Float32Array;
  readonly midiNotes: readonly number[];
  readonly velocity: number;
  /** Frame at which the voice is released, relative to render start. */
  readonly releaseFrame: number;
  readonly renderFrames: number;
  readonly sampleRate: number;
}

export interface BounceOptions {
  patchParams: Float32Array;
  engineId: string;
  /** Every note sounds together, so a held chord bounces as one sample. */
  midiNotes: readonly number[];
  durationMs: number;
  releaseAtMs: number;
  targetSampleRate: number;
}

export interface BounceResult {
  wav: Uint8Array;
  sampleRate: number;
  usedResample: boolean;
}

/** Rendered at 48 kHz whenever the browser refuses the KO II's native rate. */
const FALLBACK_SAMPLE_RATE = 48000;
const WORKLET_URL = '/worklet/sigil-processor.js';
const PROCESSOR_NAME = 'sigil-processor';
const FADE_IN_MS = 1.5;
const FADE_OUT_MS = 4;
const HEADROOM_DB = 1;
const SILENCE_FLOOR = 1e-6;

function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const mag = Math.abs(samples[i] as number);
    if (mag > peak) peak = mag;
  }
  return peak;
}

function makeContext(sampleRate: number, frames: number): OfflineAudioContext | null {
  try {
    return new OfflineAudioContext({
      numberOfChannels: 1,
      length: frames,
      sampleRate,
    });
  } catch {
    return null;
  }
}

/**
 * Renders one note offline and returns a finished 16-bit WAV.
 * `usedResample` records which path ran — never guessed, because the two paths
 * do not sound identical and the Render row stores which one produced the file.
 */
export async function bouncePatch(opts: BounceOptions): Promise<BounceResult> {
  const target = opts.targetSampleRate > 0 ? opts.targetSampleRate : KO2_SAMPLE_RATE;
  const durationSec = Math.max(0.001, opts.durationMs / 1000);

  let renderRate = target;
  let usedResample = false;
  let ctx = makeContext(target, Math.ceil(durationSec * target));
  if (!ctx) {
    renderRate = FALLBACK_SAMPLE_RATE;
    usedResample = true;
    ctx = makeContext(renderRate, Math.ceil(durationSec * renderRate));
  }
  if (!ctx) {
    throw new Error(
      `bounce: could not create an OfflineAudioContext at ${target} Hz or ${FALLBACK_SAMPLE_RATE} Hz`,
    );
  }

  const renderFrames = Math.ceil(durationSec * renderRate);
  const processorOptions: BounceProcessorOptions = {
    mode: 'bounce',
    engineId: opts.engineId,
    // Copied: the caller's patch buffer must not be observable mid-render.
    patchParams: opts.patchParams.slice(),
    midiNotes: opts.midiNotes,
    velocity: 1,
    releaseFrame: Math.max(0, Math.round((opts.releaseAtMs / 1000) * renderRate)),
    renderFrames,
    sampleRate: renderRate,
  };

  await ctx.audioWorklet.addModule(WORKLET_URL);
  const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions,
  });
  node.connect(ctx.destination);

  const rendered = await ctx.startRendering();
  const raw = rendered.getChannelData(0).slice();

  if (peakOf(raw) < SILENCE_FLOOR) {
    throw new Error(
      'bounce: offline render produced silence — the worklet did not receive its ' +
        'processorOptions patch state (see spec §8).',
    );
  }

  const atTarget = usedResample ? resampleSinc(raw, renderRate, target) : raw;
  const trimmed = trimToZeroCrossings(atTarget);
  const body = trimmed.length > 0 ? trimmed : atTarget;
  const faded = applyFades(body, FADE_IN_MS, FADE_OUT_MS, target);
  const levelled = normalisePeak(faded, HEADROOM_DB);
  const wav = encodeWav16([levelled], target);

  return { wav, sampleRate: target, usedResample };
}
