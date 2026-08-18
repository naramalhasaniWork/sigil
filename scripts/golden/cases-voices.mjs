/** Goldens for the six synthesis engines. */
import {
  emit, emitAsset, applyParams, extremeSet, noise, blockSizes, IRREGULAR_BLOCKS, SR,
} from './harness.mjs';

const FRAMES = 24000;
const NOTE_OFF_AT = 12000;
const VELOCITY = 0.8;

/**
 * Render one voice exactly the way the worklet does: allocate, set every
 * parameter, noteOn, then render additively into ONE zeroed buffer across a
 * fixed sequence of block sizes, with noteOff fired before the block containing
 * NOTE_OFF_AT.
 */
function renderVoice(engine, overrides, freq, voiceIndex, frames = FRAMES) {
  const params = engine.descriptor.params;
  const v = engine.allocVoice(SR);
  applyParams(v, params, overrides);
  v.noteOn(freq, VELOCITY, voiceIndex);
  const out = new Float32Array(frames);
  const blocks = blockSizes(frames, IRREGULAR_BLOCKS);
  let off = 0, released = false;
  for (const b of blocks) {
    if (!released && off + b > NOTE_OFF_AT) { v.noteOff(); released = true; }
    v.render(out, off, b);
    off += b;
  }
  return { out, blocks };
}

const NOTES = { a2: 110, a4: 440, a6: 1760 };

function engineCases(engine, extraSettings = {}) {
  const id = engine.descriptor.id;
  const params = engine.descriptor.params;
  const settings = {
    default: {},
    min: extremeSet(params, 'min'),
    max: extremeSet(params, 'max'),
    mid: extremeSet(params, 'mid'),
    ...extraSettings,
  };

  for (const [tag, over] of Object.entries(settings)) {
    const notes = tag === 'default' ? ['a2', 'a4', 'a6'] : ['a4'];
    for (const noteTag of notes) {
      const { out, blocks } = renderVoice(engine, over, NOTES[noteTag], 0);
      emit({
        id: `voice_${id}_${tag}_${noteTag}`, module: `${id}-voice.ts`, tol: 'chain',
        output: out,
        params: {
          engine: id, overrides: over, freqHz: NOTES[noteTag], velocity: VELOCITY,
          voiceIndex: 0, frames: FRAMES, noteOffBeforeBlockContaining: NOTE_OFF_AT,
          blockSizes: blocks,
        },
        notes: 'Buffer starts at ZERO and render() ADDS into it. Parameters are set '
          + 'by descriptor index (all defaults first, then overrides) BEFORE noteOn.',
      });
    }
  }
  // Non-zero voice index: every engine stagger/seed derives from it.
  {
    const { out, blocks } = renderVoice(engine, {}, NOTES.a4, 3);
    emit({
      id: `voice_${id}_default_voiceindex3`, module: `${id}-voice.ts`, tol: 'chain',
      output: out,
      params: { engine: id, overrides: {}, freqHz: NOTES.a4, velocity: VELOCITY,
        voiceIndex: 3, frames: FRAMES, noteOffBeforeBlockContaining: NOTE_OFF_AT,
        blockSizes: blocks },
      notes: 'voiceIndex 3 shifts oscillator start phases, drift phases, noise seed '
        + 'and LFO seed. A port that ignores voiceIndex passes index 0 and fails here.',
    });
  }
}

export function analogCases(D) {
  engineCases(D.AnalogEngine, {
    // Each filter model on its own, so a model bug is not hidden behind the default.
    ladder_hot: { 'filter-model': 0, 'filter-resonance': 0.9, drive: 0.8, 'filter-cutoff': 600 },
    svf_hot: { 'filter-model': 1, 'filter-resonance': 0.95, 'filter-cutoff': 900 },
    diode_hot: { 'filter-model': 2, 'filter-resonance': 0.95, 'filter-cutoff': 500 },
    // Unison + drift + spread: the per-copy phase and detune arithmetic.
    unison4: { 'unison-voices': 4, 'unison-detune': 0.8, 'osc-drift': 1, 'osc-detune': 0.3 },
    // Every oscillator shape reachable, plus sub and noise.
    shapes: { 'osc1-wave': 1, 'osc2-wave': 2, 'sub-mode': 3, 'sub-level': 0.8,
      'noise-level': 0.4, 'osc-pulse-width': 0.2 },
    // LFO free-running into pitch, cutoff, width and level at once.
    lfo_all: { 'lfo-rate': 7, 'lfo-shape': 4, 'lfo-sync': 0, 'lfo-delay': 0,
      'lfo-pitch': 0.5, 'lfo-cutoff': 0.8, 'lfo-pulse-width': 1, 'lfo-amp': 0.7,
      'osc1-wave': 1 },
    glide: { glide: 400 },
  });
}

export function fmCases(D) {
  engineCases(D.FmEngine, {
    hot_index: { index: 1, feedback: 0.9 },
    algo_last: { algorithm: 4 },
  });
}

export function physicalCases(D) {
  engineCases(D.PhysicalEngine, {
    long_decay: { decay: 1, damping: 0 },
    gritty: { grit: 1, hardness: 1 },
  });
}

export function granularCases(D) {
  engineCases(D.GranularEngine, {
    dense: { 'grain-density': 1, 'grain-size': 0.02, spray: 1, 'pitch-scatter': 1 },
    reverse: { reverse: 1, position: 0.7 },
  });
}

export function wavetableCases(D) {
  engineCases(D.WavetableEngine, {
    sweep: { 'position-env': 1, 'table-position': 0 },
    detuned: { 'osc-detune': 0.5, 'osc-mix': 0.5 },
  });
}

/**
 * Sampler. Two distinct material paths, and both matter:
 *   1. the module's built-in tone, created lazily on first voice allocation.
 *      Nothing has called setActiveSample yet at this point, so this MUST run
 *      before the injected cases.
 *   2. an injected buffer, written out as an asset so the port loads identical
 *      bytes rather than having to synthesise material of its own.
 */
export function samplerCases(D) {
  engineCases(D.SamplerEngine, {
    looped: { 'loop-mode': 1, 'loop-start': 0.2, 'loop-length': 0.3, 'loop-fade': 20 },
    pingpong: { 'loop-mode': 2, 'loop-start': 0.1, 'loop-length': 0.5 },
    reverse_crushed: { reverse: 1, crush: 5, drive: 0.7 },
  });

  // Injected material: 1 s of seeded noise through a fixed one-pole, so the
  // asset is broadband but not white and interpolation error is visible.
  const src = new Float32Array(SR);
  const n = noise(SR, 0x5a3f1e);
  let z = 0;
  for (let i = 0; i < SR; i++) { z += 0.15 * (n[i] - z); src[i] = z * 3; }
  emitAsset('sampler_testsample', src,
    'Injected via setActiveSample(data, 48000, 261.6255653) before the '
    + 'voice_sampler_injected_* cases. Load these exact bytes; do not regenerate.');

  D.setActiveSample(src, SR, 261.6255653);
  for (const [tag, over] of Object.entries({
    injected_default: {},
    injected_loop: { 'loop-mode': 1, 'loop-start': 0.25, 'loop-length': 0.25, 'loop-fade': 30 },
    injected_pitched: { tune: 12, fine: 0.5 },
  })) {
    const { out, blocks } = renderVoice(D.SamplerEngine, over, NOTES.a4, 0);
    emit({
      id: `voice_sampler_${tag}`, module: 'sampler-voice.ts', tol: 'chain',
      output: out, asset: 'sampler_testsample.f32',
      params: { engine: 'sampler', overrides: over, freqHz: NOTES.a4, velocity: VELOCITY,
        voiceIndex: 0, frames: FRAMES, noteOffBeforeBlockContaining: NOTE_OFF_AT,
        blockSizes: blocks, sampleRootHz: 261.6255653, sampleSr: SR },
      notes: 'setActiveSample(asset, 48000, 261.6255653) before allocating the voice.',
    });
  }
}

/**
 * The two module-private buffers the sampler and granular engines are built on.
 * Goldened separately so a port can tell "my source material is wrong" from
 * "my voice is wrong" — otherwise every granular case fails for one reason and
 * you cannot see which.
 */
export function sourceBufferCases(probes) {
  emit({
    id: 'source_sampler_builtin', module: 'sampler-voice.ts', tol: 'trans',
    output: probes.samplerDefault,
    params: { sampleRate: 48000, rootHz: 261.6255653, frames: probes.samplerDefault.length },
    notes: 'sampler-voice.ts buildDefault(). Four Math.sin partials with Math.exp '
      + 'decays, then peak-normalised to 0.9. Per-sample transcendentals, so '
      + 'expect ~1 ulp differences, NOT bit-exactness.',
  });
  emitAsset('source_sampler_builtin', probes.samplerDefault,
    'Same bytes as the golden; provided as an asset so a port can inject the '
    + 'reference material and isolate SamplerVoice from buildDefault().');

  emit({
    id: 'source_granular', module: 'granular-voice.ts', tol: 'chain',
    output: probes.granularSource,
    params: { sampleRate: 48000, seconds: 3, rootHz: 110,
      frames: probes.granularSource.length },
    notes: 'granular-voice.ts getSource(): three SawOscillators plus a '
      + 'LadderFilter-swept noise bed, peak-normalised. Depends on blep.ts and '
      + 'ladder.ts being correct first.',
  });
  emitAsset('source_granular', probes.granularSource,
    'Same bytes as the golden; inject to isolate GranularVoice from getSource().');
}
