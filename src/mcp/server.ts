/**
 * The Model Context Protocol surface: the tool manifest a model reads, and the
 * JSON-RPC framing it speaks.
 *
 * This file knows about the protocol and nothing about music. Every tool body
 * lives in `src/mcp/tools.ts` and is testable without ever constructing a
 * request; `app/api/mcp/route.ts` is a twenty-line adapter over `handlePayload`.
 *
 * Transport is plain HTTP POST with a JSON body — the "streamable HTTP"
 * transport minus the SSE half, which SIGIL does not need because no tool here
 * is long-running and nothing is pushed server-to-client.
 */
import {
  addClip,
  addSection,
  addTrack,
  createArrangement,
  createPatch,
  describeEngine,
  generateProgression,
  getArrangement,
  listArrangements,
  listEngines,
  listPresets,
  modifyPatch,
  updateTrack,
  type ArrangementStore,
  type ToolResult,
} from './tools';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = { name: 'sigil', title: 'SIGIL', version: '1.0.0' } as const;

type Schema = Record<string, unknown>;

const S = {
  obj: (properties: Record<string, Schema>, required: readonly string[] = []): Schema => ({
    type: 'object', properties, required: [...required], additionalProperties: false,
  }),
  str: (description: string, extra: Schema = {}): Schema => ({ type: 'string', description, ...extra }),
  numb: (description: string, extra: Schema = {}): Schema => ({ type: 'number', description, ...extra }),
  bool: (description: string): Schema => ({ type: 'boolean', description }),
  arr: (items: Schema, description: string): Schema => ({ type: 'array', items, description }),
  map: (description: string): Schema => ({
    type: 'object', description, additionalProperties: { type: 'number' },
  }),
};

const ARR_ID = S.str('Arrangement id from create_arrangement, e.g. "arr_night_drive".');
const NOTE_ITEM = S.obj({
  midi: S.numb('MIDI note 0..127. Use this or "note".'),
  note: S.str('Note name instead of MIDI, e.g. "C3", "F#2", "Bb4".'),
  startTick: S.numb('Clip-local position in ticks at PPQ 96. Use this or bar+beat.'),
  bar: S.numb('1-indexed bar inside the clip. Converted to ticks here.'),
  beat: S.numb('1-indexed beat inside the bar; fractions allowed (2.5 = the "and" of 2).'),
  durationTicks: S.numb('Length in ticks at PPQ 96.'),
  durationBeats: S.numb('Length in beats. Default 1.'),
  velocity: S.numb('0..1. Default 0.8.'),
});

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  run: (store: ArrangementStore, args: unknown) => Promise<ToolResult>;
}

/**
 * Descriptions are written for a model with no other context. They say what the
 * tool is FOR, not what it does — "pick a sound by feel" beats "returns presets".
 */
export const TOOLS: readonly ToolSpec[] = [
  {
    name: 'list_engines',
    title: 'List engines',
    description: 'The six synthesis engines. Start here: every track names one. Returns id, name, macro names and how many presets each has.',
    inputSchema: S.obj({ engineId: S.str('Optional: restrict to one engine.') }),
    run: (_s, a) => listEngines(a),
  },
  {
    name: 'describe_engine',
    title: 'Describe engine parameters',
    description: 'Every parameter of one engine with its real units, range, default and a plain-language "explain" sentence. Read the explains before setting values — they are what let you choose "filter-cutoff" for the word "brighter". Pass "fx" or "character" for the shared effect chains.',
    inputSchema: S.obj({
      engineId: S.str('An engine id, or "fx", or "character".'),
      group: S.str('Optional: only parameters in this group, e.g. "Filter".'),
    }, ['engineId']),
    run: (_s, a) => describeEngine(a),
  },
  {
    name: 'list_presets',
    title: 'List presets by character',
    description: 'The preset library, organised by CHARACTER rather than instrument role — "glassy", "huge", "broken". Call with no arguments to see the whole tag vocabulary first.',
    inputSchema: S.obj({
      character: S.str('A character tag, e.g. "warm".'),
      engineId: S.str('Optional: only presets for this engine.'),
    }),
    run: (_s, a) => listPresets(a),
  },
  {
    name: 'create_patch',
    title: 'Create a patch',
    description: 'Build a sound. Give an engine and optionally a preset to start from, then override only the parameters you care about — anything you omit keeps the preset or the engine default. Values are in REAL units (Hz, ms, dB), not 0..1.',
    inputSchema: S.obj({
      engineId: S.str('The engine this patch is for.'),
      presetId: S.str('Optional starting point from list_presets.'),
      values: S.map('Parameter id -> value, e.g. {"filter-cutoff": 800}. Partial is fine.'),
      fx: S.map('Optional effects-chain values; see describe_engine("fx").'),
      character: S.map('Optional character-chain values; see describe_engine("character").'),
      name: S.str('Optional name for the patch.'),
    }, ['engineId']),
    run: (_s, a) => createPatch(a),
  },
  {
    name: 'modify_patch',
    title: 'Modify a patch',
    description: 'Change parameters on an existing patch and get the new one back. Everything you do not mention is kept.',
    inputSchema: S.obj({
      patch: S.obj({}, []),
      values: S.map('Parameter id -> new value.'),
      fx: S.map('Effects-chain overrides.'),
      character: S.map('Character-chain overrides.'),
      name: S.str('Optional new name.'),
    }, ['patch']),
    run: (_s, a) => modifyPatch(a),
  },
  {
    name: 'generate_progression',
    title: 'Generate a chord progression',
    description: 'A diatonic progression built from SIGIL\'s own theory module, so every note is in key by construction. Returns the chords with labels AND a "notes" array you can pass straight to add_clip.',
    inputSchema: S.obj({
      degrees: S.arr({ type: ['number', 'string'] }, 'Scale degrees in order: [1,6,4,5] or ["i","VI","III","VII"].'),
      root: S.str('Key centre: pitch class 0..11 or a note name like "F#". Default C.'),
      scale: S.str('minor, major, dorian, phrygian, lydian, mixolydian, harmonicMinor, pentatonicMinor, wholeTone, chromatic. Default minor.'),
      octave: S.numb('Octave of the chord roots, 0..7. Default 3.'),
      barsPerChord: S.numb('0.25..8. Default 1.'),
      beatsPerBar: S.numb('Default 4.'),
      notesPerChord: S.numb('3 for triads, 4 for sevenths, 5 for ninths. Default 3.'),
      spread: S.numb('0 is close position; higher lifts upper voices by octaves. Default 0.'),
      velocity: S.numb('0..1. Default 0.8.'),
      gate: S.numb('Fraction of the chord slot the notes sound for, 0.05..1. Default 0.95.'),
    }, ['degrees']),
    run: (_s, a) => generateProgression(a),
  },
  {
    name: 'create_arrangement',
    title: 'Create an arrangement',
    description: 'Start a song: one tempo, one key, and a list of sections in play order. Sections ARE the timeline — there are no free-floating clips.',
    inputSchema: S.obj({
      name: S.str('Song name.'),
      bpm: S.numb('20..300. Default 100.'),
      beatsPerBar: S.numb('Default 4.'),
      root: S.str('Key centre: 0..11 or a note name. Default C.'),
      scale: S.str('Scale name. Default minor.'),
      sections: S.arr(
        S.obj({ name: S.str('e.g. "Intro", "Drop".'), bars: S.numb('1..64.'), repeats: S.numb('Play the section this many times.') }, ['name']),
        'Sections in play order. Order in this array is the order of the song.',
      ),
    }, ['name']),
    run: (s, a) => createArrangement(s, a),
  },
  {
    name: 'add_section',
    title: 'Add a section',
    description: 'Append a section, or insert one after another by id.',
    inputSchema: S.obj({
      arrangementId: ARR_ID,
      name: S.str('Section name.'),
      bars: S.numb('1..64. Default 4.'),
      repeats: S.numb('Play the section this many times.'),
      after: S.str('Optional section id to insert after. Omitted means append.'),
    }, ['arrangementId', 'name']),
    run: (s, a) => addSection(s, a),
  },
  {
    name: 'add_track',
    title: 'Add a track',
    description: 'Add an instrument. Eight tracks maximum, and only one sampler track. Give a presetId or partial values to set its sound at the same time.',
    inputSchema: S.obj({
      arrangementId: ARR_ID,
      name: S.str('Track name, e.g. "Bass". Becomes the id, e.g. "track_bass".'),
      engineId: S.str('An engine id from list_engines.'),
      presetId: S.str('Optional preset to start the sound from.'),
      values: S.map('Optional parameter overrides.'),
      fx: S.map('Optional effects-chain values.'),
      character: S.map('Optional character-chain values.'),
      gain: S.numb('0..1. Default 0.8.'),
      pan: S.numb('-1..1. Stored, and honoured once the voices are stereo.'),
      muted: S.bool('Start muted.'),
    }, ['arrangementId', 'name', 'engineId']),
    run: (s, a) => addTrack(s, a),
  },
  {
    name: 'update_track',
    title: 'Update a track',
    description: 'Change a track\'s level, mute state or sound after the fact. Parameter values merge onto whatever the track already has.',
    inputSchema: S.obj({
      arrangementId: ARR_ID,
      trackId: S.str('e.g. "track_bass".'),
      name: S.str('Rename.'),
      presetId: S.str('Replace the sound with this preset.'),
      values: S.map('Parameter overrides merged onto the current patch.'),
      gain: S.numb('0..1.'),
      pan: S.numb('-1..1.'),
      muted: S.bool('Mute.'),
      soloed: S.bool('Solo.'),
    }, ['arrangementId', 'trackId']),
    run: (s, a) => updateTrack(s, a),
  },
  {
    name: 'add_clip',
    title: 'Put a clip in a cell',
    description: 'Place notes where a track crosses a section — a CELL, not a time offset. Pass "notes" (from generate_progression, or written by hand with bar/beat) and a pattern is made for you. One clip per cell: placing into an occupied cell replaces it.',
    inputSchema: S.obj({
      arrangementId: ARR_ID,
      trackId: S.str('e.g. "track_bass".'),
      sectionId: S.str('e.g. "sec_drop".'),
      notes: S.arr(NOTE_ITEM, 'The notes. Omit only if you pass patternId.'),
      patternId: S.str('Reuse an existing pattern instead of supplying notes.'),
      lengthBars: S.numb('Pattern length. Defaults to the section length.'),
      fill: S.str('"loop" repeats the pattern to fill the section (default); "once" plays it and stops.'),
      transpose: S.numb('-24..24 semitones.'),
      velocityScale: S.numb('0..2.'),
      muted: S.bool('Mute this clip.'),
    }, ['arrangementId', 'trackId', 'sectionId']),
    run: (s, a) => addClip(s, a),
  },
  {
    name: 'get_arrangement',
    title: 'Read an arrangement',
    description: 'The whole song back, plus a summary with total bars, duration in seconds and an ASCII grid of which cells are filled. Read this before deciding what is missing.',
    inputSchema: S.obj({
      arrangementId: ARR_ID,
      includePatterns: S.bool('Set false to omit note data and get just the shape.'),
    }, ['arrangementId']),
    run: (s, a) => getArrangement(s, a),
  },
  {
    name: 'list_arrangements',
    title: 'List arrangements',
    description: 'Every song this server currently holds, with its id, name and how many tracks and sections it has. Use it to recover an arrangement id you no longer have.',
    inputSchema: S.obj({}),
    run: (s) => listArrangements(s),
  },
];

export const TOOL_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(
  TOOLS.map((t) => [t.name, t]),
);

/* ------------------------------------------------------------- JSON-RPC */

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function err(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** MCP wants tool failures as content the model can read, not transport errors. */
function toolContent(result: ToolResult): Record<string, unknown> {
  const payload = result.ok ? result.data : { error: result.error };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(result.ok ? { structuredContent: result.data } : { isError: true }),
  };
}

/**
 * One JSON-RPC message. Returns null for notifications, which by the spec get
 * no response at all.
 */
export async function handleMessage(
  store: ArrangementStore, message: unknown,
): Promise<JsonRpcResponse | null> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return err(null, INVALID_REQUEST, 'Expected a JSON-RPC object.');
  }
  const msg = message as Record<string, unknown>;
  const method = typeof msg['method'] === 'string' ? msg['method'] : '';
  const rawId = msg['id'];
  const id: JsonRpcId =
    typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
  const isNotification = rawId === undefined;

  if (method === '') return err(id, INVALID_REQUEST, 'Missing "method".');
  if (method.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Compose in SIGIL. Read list_engines and list_presets first, create_arrangement '
          + 'next, then add_track, generate_progression and add_clip. Time is ticks at PPQ 96; '
          + 'clips live in cells (track x section), never at absolute offsets.',
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case 'tools/call': {
      if (isNotification) return null;
      const params = msg['params'];
      const p = typeof params === 'object' && params !== null
        ? (params as Record<string, unknown>) : {};
      const name = typeof p['name'] === 'string' ? p['name'] : '';
      const spec = TOOL_BY_NAME.get(name);
      if (!spec) {
        return err(id, INVALID_PARAMS, `No tool "${name}". Call tools/list for the ${TOOLS.length} that exist.`);
      }
      const result = await spec.run(store, p['arguments'] ?? {});
      return ok(id, toolContent(result));
    }
    default:
      return err(id, METHOD_NOT_FOUND, `Unsupported method "${method}".`);
  }
}

/**
 * A whole request body: one message or a batch. Returns null when every message
 * was a notification, which the transport answers with 202 and no body.
 */
export async function handlePayload(
  store: ArrangementStore, payload: unknown,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) return err(null, INVALID_REQUEST, 'Empty batch.');
    const out: JsonRpcResponse[] = [];
    for (const item of payload) {
      const res = await handleMessage(store, item);
      if (res !== null) out.push(res);
    }
    return out.length === 0 ? null : out;
  }
  return handleMessage(store, payload);
}

/** For the route: turn an unparseable body into the right JSON-RPC error. */
export function parseError(): JsonRpcResponse {
  return err(null, PARSE_ERROR, 'Request body was not valid JSON.');
}
