/**
 * Sample loading, analysis and persistence. Main thread only, once per file — no
 * React, no audio-thread code. Persistence is IndexedDB, not localStorage: audio
 * is megabytes, localStorage caps near 5 MB and is synchronous, so one dropped
 * drum loop would blow the quota and freeze the interface on the way.
 */

export interface StoredSample {
  id: string;
  name: string;
  sampleRate: number;
  channels: number;
  frames: number;
  /** Planar, not interleaved: channel c occupies [c * frames, (c + 1) * frames). */
  data: Float32Array;
}

export type SampleMeta = Omit<StoredSample, 'data'>;

const DB_NAME = 'sigil-samples';
const DB_VERSION = 1;
const META = 'meta';
const BLOBS = 'blobs';
/** A zero crossing further away than this is not the edit anyone meant. */
const MAX_ZC_SEARCH = 16384;
const MIN_PITCH_HZ = 40;
const MAX_PITCH_HZ = 2000;
/** Below this, correlation is coincidence, not pitch. Returning null beats
 * guessing: the root note sets the playback rate for every key, so one wrong
 * answer detunes the entire keyboard and reads as a bug in the instrument. */
const PITCH_CLARITY = 0.7;
const PITCH_WINDOW = 4096;

let storeError: string | null = null;
/** Why the last store operation failed, in words a player can act on. */
export function lastSampleStoreError(): string | null { return storeError; }

function makeId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// ---------------------------------------------------------------- decoding
export async function decodeAudioFile(
  file: File | ArrayBuffer, ctx: BaseAudioContext,
): Promise<StoredSample> {
  const name = file instanceof ArrayBuffer ? 'sample' : file.name || 'sample';
  const raw = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  // decodeAudioData detaches the buffer it is handed, so give it a copy: the
  // caller may still want the original bytes.
  const buf = await ctx.decodeAudioData(raw.slice(0));
  const channels = buf.numberOfChannels > 0 ? buf.numberOfChannels : 1;
  const frames = buf.length, data = new Float32Array(channels * frames);
  for (let c = 0; c < channels; c++) data.set(buf.getChannelData(c), c * frames);
  return { id: makeId(), name, sampleRate: buf.sampleRate, channels, frames, data };
}

/** Sum to mono. The sampler plays one buffer, so stereo collapses here rather
 * than in the render loop. Mono input returns a view — treat it as read-only. */
export function toMono(sample: StoredSample): Float32Array {
  const { channels, frames, data } = sample;
  if (channels <= 1) return data.subarray(0, frames);
  const out = new Float32Array(frames);
  const scale = 1 / channels;
  for (let c = 0; c < channels; c++) {
    const base = c * frames;
    for (let i = 0; i < frames; i++) out[i] = (out[i] as number) + (data[base + i] as number) * scale;
  }
  return out;
}

/** Scale so the loudest point lands exactly on `peak`. Recorded material
 * arrives at wildly different levels; without this, swapping samples is a volume
 * jump. Silence returns unchanged rather than multiplied by infinity. */
export function normaliseSample(data: Float32Array, peak: number): Float32Array {
  const n = data.length, out = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(data[i] as number);
    if (a > max && Number.isFinite(a)) max = a;
  }
  const gain = max > 1e-12 ? peak / max : 1;
  for (let i = 0; i < n; i++) {
    const v = (data[i] as number) * gain;
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

/** Nearest index where the waveform crosses zero, searching in `direction`.
 * Trimming or looping anywhere else leaves a step, and a step is a click. */
export function findZeroCrossing(data: Float32Array, near: number, direction: 1 | -1): number {
  const last = data.length - 1;
  if (last < 0) return 0;
  let i = Math.round(near);
  if (!(i >= 0)) i = 0; else if (i > last) i = last;
  const from = i;
  for (let n = 0; n < MAX_ZC_SEARCH; n++) {
    const a = data[i] as number;
    if (a === 0) return i;
    const j = i + direction;
    if (j < 0 || j > last) break;
    const b = data[j] as number;
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) return Math.abs(a) <= Math.abs(b) ? i : j;
    i = j;
  }
  return from;
}

/** Normalised correlation of a window against itself `lag` samples later. */
function correlate(
  d: Float32Array, start: number, w: number, lag: number, mean: number, energy: number,
): number {
  let num = 0, den = 0;
  for (let i = 0; i < w; i++) {
    const a = (d[start + i] as number) - mean;
    const b = (d[start + i + lag] as number) - mean;
    num += a * b;
    den += b * b;
  }
  return num / Math.sqrt(energy * den + 1e-30);
}

/** Autocorrelation pitch detection. Returns null for unpitched material — a
 * drum hit, a noise wash — because a confident wrong answer is worse than none. */
export function detectPitchHz(data: Float32Array, sampleRate: number): number | null {
  const len = data.length;
  if (len < 512 || !(sampleRate > 0)) return null;
  const maxLag = Math.min(Math.floor(sampleRate / MIN_PITCH_HZ), len >> 1);
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_PITCH_HZ));
  if (maxLag <= minLag + 2) return null;

  // Skip leading silence: room tone before the note buries the periodic part.
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const a = Math.abs(data[i] as number);
    if (a > peak) peak = a;
  }
  if (peak < 1e-7) return null;
  const gate = peak * 0.2;
  let start = 0;
  while (start < len && Math.abs(data[start] as number) < gate) start++;
  let w = Math.min(PITCH_WINDOW, len - maxLag - start);
  if (w < 256) { start = 0; w = Math.min(PITCH_WINDOW, len - maxLag); }
  if (w < 256) return null;

  const total = w + maxLag;
  let mean = 0, energy = 0;
  for (let i = 0; i < total; i++) mean += data[start + i] as number;
  mean /= total;
  for (let i = 0; i < w; i++) {
    const a = (data[start + i] as number) - mean;
    energy += a * a;
  }
  if (energy < 1e-12) return null;

  const r = new Float32Array(maxLag + 2);
  let bestLag = -1, best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const v = correlate(data, start, w, lag, mean, energy);
    r[lag] = v;
    if (v > best) { best = v; bestLag = lag; }
  }
  if (bestLag < 0 || best < PITCH_CLARITY) return null;

  // Take the earliest *peak* that is nearly as good as the best. The global
  // maximum often lands on a multiple of the true period, which reads as an
  // octave error; insisting on a local maximum stops the search settling on the
  // shoulder of the first peak rather than its top.
  const accept = best * 0.9;
  let chosen = bestLag;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    const v = r[lag] as number;
    if (v >= accept && v > (r[lag - 1] as number) && v >= (r[lag + 1] as number)) {
      chosen = lag;
      break;
    }
  }
  // Parabolic interpolation across neighbouring lags: the true period is almost
  // never a whole number of samples, and rounding costs a semitone in the treble.
  const prev = chosen > minLag ? (r[chosen - 1] as number) : 0;
  const next = r[chosen + 1] as number;
  const denom = prev - 2 * (r[chosen] as number) + next;
  const shift = denom !== 0 ? (0.5 * (prev - next)) / denom : 0;
  const hz = sampleRate / (chosen + (shift > -1 && shift < 1 ? shift : 0));
  return hz >= MIN_PITCH_HZ && hz <= MAX_PITCH_HZ ? hz : null;
}

// ------------------------------------------------------------- persistence
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise<T>((ok, no) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error ?? new Error('IndexedDB request failed'));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((ok, no) => {
    tx.oncomplete = () => ok();
    tx.onabort = () => no(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => no(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/** Turns a storage failure into something worth showing a person. */
function describe(e: unknown): string {
  const n = e instanceof Error ? e.name : '';
  if (n === 'QuotaExceededError') return 'Storage is full. Delete a sample or two and try again.';
  if (n === 'InvalidStateError' || n === 'SecurityError') {
    return 'This browser is blocking storage, most likely private browsing. Samples work for this session but will not be saved.';
  }
  return e instanceof Error ? e.message : 'Could not reach browser storage.';
}

async function openDb(): Promise<IDBDatabase | null> {
  const idb = globalThis.indexedDB as IDBFactory | undefined;
  if (!idb) {
    storeError = 'This browser has no IndexedDB, so samples cannot be saved.';
    return null;
  }
  try {
    const open = idb.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
    };
    return await request(open);
  } catch (e) {
    storeError = describe(e);
    return null;
  }
}

/** Every store call funnels through here, so a quota error or a private-browsing
 * block degrades to the fallback instead of throwing into a click handler. */
async function withDb<T>(
  stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>, fallback: T,
): Promise<T> {
  const db = await openDb();
  if (!db) return fallback;
  try {
    const value = await run(db.transaction(stores, mode));
    storeError = null;
    return value;
  } catch (e) {
    storeError = describe(e);
    return fallback;
  } finally {
    db.close();
  }
}

function isMeta(v: unknown): v is SampleMeta {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.name === 'string'
    && typeof r.sampleRate === 'number' && typeof r.channels === 'number'
    && typeof r.frames === 'number';
}

/** Metadata and audio sit in separate stores, so listing the library does not
 * drag every megabyte of audio into memory to read a name off it. */
export async function saveSample(s: StoredSample): Promise<void> {
  const { id, name, sampleRate, channels, frames } = s;
  await withDb([META, BLOBS], 'readwrite', async (tx) => {
    tx.objectStore(META).put({ id, name, sampleRate, channels, frames });
    tx.objectStore(BLOBS).put(s.data, id);
    await finished(tx);
  }, undefined);
}

export async function listSamples(): Promise<SampleMeta[]> {
  return withDb([META], 'readonly', async (tx) => {
    const rows: unknown = await request(tx.objectStore(META).getAll());
    return Array.isArray(rows) ? rows.filter(isMeta) : [];
  }, []);
}

export async function loadSample(id: string): Promise<StoredSample | null> {
  return withDb([META, BLOBS], 'readonly', async (tx) => {
    const meta: unknown = await request(tx.objectStore(META).get(id));
    const blob: unknown = await request(tx.objectStore(BLOBS).get(id));
    if (!isMeta(meta) || !(blob instanceof Float32Array)) return null;
    return { ...meta, data: blob };
  }, null);
}

export async function deleteSample(id: string): Promise<void> {
  await withDb([META, BLOBS], 'readwrite', async (tx) => {
    tx.objectStore(META).delete(id);
    tx.objectStore(BLOBS).delete(id);
    await finished(tx);
  }, undefined);
}
