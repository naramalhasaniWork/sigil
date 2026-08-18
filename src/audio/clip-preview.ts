import type { EngineModule } from '@/audio/types';
import { VoiceManager } from '@/dsp/voice-manager';

/**
 * Renders a clip's notes offline and reduces the result to a peak envelope, so
 * a cell in the arrangement can show the shape of what is actually in it.
 *
 * A cell holds NOTES, not audio, so there is no waveform to read — it has to be
 * played to exist. That is the whole reason this module is here rather than a
 * few lines inside a component: it is real synthesis, it belongs with the
 * audio code, and it must be testable without a browser.
 *
 * It is deliberately NOT the bounce path. A bounce is the artefact you keep and
 * must be correct at full rate; this is a thumbnail nobody listens to, so it
 * runs at a low sample rate and a small voice budget. Preview quality that
 * costs what a real render costs would simply not get drawn.
 */

/** Enough to distinguish a pad from a stab. Detail past this is invisible. */
export const PREVIEW_SAMPLE_RATE = 16000;
const PREVIEW_MAX_VOICES = 8;
/** Rendering granularity. Note events land on the nearest block boundary. */
const BLOCK = 64;

export interface PreviewNote {
  readonly midi: number;
  readonly velocity: number;
  /** Position inside the pattern, in ticks. */
  readonly startTick: number;
  readonly durationTicks: number;
}

export interface ClipWaveformOptions {
  readonly notes: readonly PreviewNote[];
  readonly engine: EngineModule;
  /** The track's patch, already resolved to engine parameter order. */
  readonly params: Float32Array;
  readonly patternTicks: number;
  readonly ppq: number;
  readonly bpm: number;
  /** Output resolution. One value per horizontal pixel is the useful maximum. */
  readonly buckets: number;
}

export interface ClipWaveform {
  /**
   * Peak magnitude per bucket, in signal units rather than normalised — so two
   * clips drawn side by side show their real loudness difference. A caller that
   * wants each clip to fill its own box can divide by `peak`.
   */
  readonly peaks: Float32Array;
  /** The loudest bucket. Zero when the clip makes no sound at all. */
  readonly peak: number;
}

/** Empty result, so callers never branch on null. */
function silent(buckets: number): ClipWaveform {
  return { peaks: new Float32Array(Math.max(0, buckets)), peak: 0 };
}

/**
 * One note-on and one note-off, flattened into a single list ordered by time,
 * so the render loop never searches. Offs sort before ons at the same instant:
 * a repeated note must release before it restarts, or the voice manager steals
 * from itself and the second note is swallowed.
 */
interface Event { readonly sample: number; readonly on: boolean; readonly midi: number; readonly velocity: number }

function buildEvents(
  notes: readonly PreviewNote[], samplesPerTick: number, total: number,
): Event[] {
  const events: Event[] = [];
  for (const n of notes) {
    if (!Number.isFinite(n.midi) || n.midi < 0 || n.midi > 127) continue;
    const start = Math.round(n.startTick * samplesPerTick);
    if (start >= total) continue;
    // A zero or corrupt duration would leave the note on forever, which turns
    // a thumbnail into a solid block. One tick is the shortest honest answer.
    const dur = Number.isFinite(n.durationTicks) && n.durationTicks > 0
      ? n.durationTicks
      : 1;
    const end = Math.min(total, Math.round((n.startTick + dur) * samplesPerTick));
    const velocity = Number.isFinite(n.velocity) ? Math.min(1, Math.max(0, n.velocity)) : 1;
    events.push({ sample: Math.max(0, start), on: true, midi: n.midi, velocity });
    events.push({ sample: Math.max(0, end), on: false, midi: n.midi, velocity });
  }
  events.sort((a, b) => (a.sample - b.sample) || ((a.on ? 1 : 0) - (b.on ? 1 : 0)));
  return events;
}

export function clipWaveform(o: ClipWaveformOptions): ClipWaveform {
  const { notes, engine, params, patternTicks, ppq, bpm, buckets } = o;
  if (
    buckets <= 0 || notes.length === 0 || patternTicks <= 0
    || !Number.isFinite(bpm) || bpm <= 0 || ppq <= 0
  ) return silent(buckets);

  const samplesPerTick = (60 / bpm) * (PREVIEW_SAMPLE_RATE / ppq);
  const total = Math.round(patternTicks * samplesPerTick);
  if (total <= 0) return silent(buckets);

  const voices = new VoiceManager(engine, PREVIEW_SAMPLE_RATE, PREVIEW_MAX_VOICES);
  for (let i = 0; i < params.length; i++) voices.setParam(i, params[i] as number);

  const events = buildEvents(notes, samplesPerTick, total);
  const peaks = new Float32Array(buckets);
  const block = new Float32Array(BLOCK);
  const samplesPerBucket = total / buckets;

  let cursor = 0, next = 0, peak = 0;
  while (cursor < total) {
    // Everything due by the start of this block. Sub-block timing is below the
    // resolution of a thumbnail, and quantising here keeps the loop branchless.
    while (next < events.length && (events[next] as Event).sample <= cursor) {
      const e = events[next] as Event;
      if (e.on) voices.noteOn(e.midi, e.velocity);
      else voices.noteOff(e.midi);
      next++;
    }

    const count = Math.min(BLOCK, total - cursor);
    block.fill(0, 0, count);
    voices.render(block, count);

    for (let i = 0; i < count; i++) {
      const v = block[i] as number;
      // A voice that has gone bad must not poison the whole thumbnail.
      if (!Number.isFinite(v)) continue;
      const a = v < 0 ? -v : v;
      const b = Math.min(buckets - 1, Math.floor((cursor + i) / samplesPerBucket));
      if (a > (peaks[b] as number)) peaks[b] = a;
      if (a > peak) peak = a;
    }
    cursor += count;
  }
  voices.allNotesOff();
  return { peaks, peak };
}
