/**
 * Goldens for src/dsp/voice-manager.ts and the audio-thread half of
 * src/audio/worklet/sigil-processor.ts.
 *
 * These are the two files the VST3 wrapper depends on that are NOT covered by
 * the DSP goldens. What they actually pin down:
 *
 *   voicemanager_*  the real TypeScript VoiceManager, driven by a scripted note
 *                   sequence with more notes than slots so claim() has to steal,
 *                   plus parameter writes while voices are sounding, an
 *                   allNotesOff, and a retrigger of a stolen note. If the C++
 *                   steals a different slot, the output diverges immediately.
 *
 *   sigilchain_*    VoiceManager -> FxChain -> MagicChain wired exactly as
 *                   SigilProcessor.process() wires them, stereo. This covers the
 *                   glue: the zero-fill, the render-left-then-copy-right, and
 *                   the order of the two chains.
 *
 * Both sides run the same event script: a list of segment lengths, and events
 * applied BEFORE the segment they are attached to. The C++ runner in
 * native/test/cases/voice_manager_cases.cpp replays the same table.
 *
 * Event types: 0 noteOn(a=note, b=velocity), 1 noteOff(a=note),
 *              2 allNotesOff, 3 setParam(a=index, b=value),
 *              4 tuning(a=divisions, b=refHz).
 */
import { emit, SR } from './harness.mjs';

const EV_NOTE_ON = 0, EV_NOTE_OFF = 1, EV_ALL_OFF = 2, EV_SET_PARAM = 3, EV_TUNING = 4;

/** Irregular on purpose: a manager that only works on 128s is not working. */
const SEGMENTS = [64, 128, 37, 256, 128, 7, 512, 128, 301, 128, 64, 256, 128, 191, 256, 128];

function scriptFor(kind) {
  const ev = [];
  const at = (seg, type, a, b) => ev.push({ seg, type, a, b });

  if (kind === 'steal') {
    // Six notes into four slots: slots 0..3 fill, then two steals. The victims
    // are decided by claim(), which prefers released slots over held ones and
    // only then compares age - the whole point of the case.
    at(0, EV_NOTE_ON, 48, 1.0);
    at(1, EV_NOTE_ON, 55, 0.8);
    at(2, EV_NOTE_ON, 60, 0.6);
    at(3, EV_NOTE_ON, 64, 0.9);
    at(4, EV_NOTE_OFF, 55, 0);        // slot 1 is now released but still ringing
    at(5, EV_NOTE_ON, 67, 0.7);       // must take the released slot, not the oldest
    at(7, EV_NOTE_ON, 72, 0.5);       // now every slot is held: oldest wins
    at(9, EV_NOTE_OFF, 48, 0);
    at(10, EV_NOTE_ON, 48, 1.0);      // retrigger a note whose slot was stolen
    at(12, EV_ALL_OFF, 0, 0);
    at(14, EV_NOTE_ON, 43, 1.0);
  } else if (kind === 'params') {
    // Parameter writes while voices sound, then a note started AFTER the writes
    // so the "push every stored value at noteOn" path is exercised too.
    at(0, EV_NOTE_ON, 57, 1.0);
    at(2, EV_SET_PARAM, 2, 400);
    at(3, EV_SET_PARAM, 3, 0.7);
    at(4, EV_NOTE_ON, 60, 0.75);
    at(6, EV_SET_PARAM, 2, 3200);
    at(8, EV_NOTE_OFF, 57, 0);
    at(9, EV_SET_PARAM, 9, 0.6);
    // env-curve is the one parameter analog-voice.ts reads UNROUNDED inside
    // setParam, while noteOn re-pushes the Float32Array-rounded value. A value
    // that is not exactly representable in float32 is the only way to tell the
    // two apart, so this is deliberate rather than arbitrary.
    at(9, EV_SET_PARAM, 24, 0.7333333333333333);
    at(10, EV_NOTE_ON, 64, 0.5);
    at(13, EV_NOTE_OFF, 60, 0);
    at(14, EV_NOTE_OFF, 64, 0);
  } else {
    // 19-tone equal temperament off a 432 Hz reference: the tuning table feeds
    // frequency() at noteOn, so a wrong exponent is audible immediately.
    at(0, EV_TUNING, 19, 432);
    at(0, EV_NOTE_ON, 60, 1.0);
    at(2, EV_NOTE_ON, 67, 0.8);
    at(5, EV_NOTE_ON, 79, 0.6);
    at(9, EV_NOTE_OFF, 60, 0);
    at(11, EV_NOTE_OFF, 67, 0);
    at(13, EV_NOTE_OFF, 79, 0);
  }
  return ev;
}

function packEvents(ev) {
  return {
    evSeg: ev.map((e) => e.seg).join(','),
    evType: ev.map((e) => e.type).join(','),
    evA: ev.map((e) => e.a).join(','),
    evB: ev.map((e) => e.b).join(','),
  };
}

function apply(vm, e) {
  if (e.type === EV_NOTE_ON) vm.noteOn(e.a, e.b);
  else if (e.type === EV_NOTE_OFF) vm.noteOff(e.a);
  else if (e.type === EV_ALL_OFF) vm.allNotesOff();
  else if (e.type === EV_SET_PARAM) vm.setParam(e.a, e.b);
  else if (e.type === EV_TUNING) {
    vm.tuning.setEqualDivisions(e.a);
    vm.tuning.setReference(69, e.b);
  }
}

/** VoiceManager alone, mono, no effects. */
export function voiceManagerCases(D) {
  const configs = [
    { id: 'voicemanager_analog_steal', engine: D.AnalogEngine, kind: 'steal', voices: 4 },
    { id: 'voicemanager_analog_params', engine: D.AnalogEngine, kind: 'params', voices: 4 },
    { id: 'voicemanager_fm_steal', engine: D.FmEngine, kind: 'steal', voices: 3 },
    { id: 'voicemanager_analog_tuning', engine: D.AnalogEngine, kind: 'tuning', voices: 8 },
    { id: 'voicemanager_wavetable_steal', engine: D.WavetableEngine, kind: 'steal', voices: 2 },
  ];

  for (const cfg of configs) {
    const vm = new D.VoiceManager(cfg.engine, SR, cfg.voices);
    const ev = scriptFor(cfg.kind);
    const total = SEGMENTS.reduce((a, b) => a + b, 0);
    const out = new Float32Array(total);
    const scratch = new Float32Array(Math.max(...SEGMENTS));

    let pos = 0;
    for (let s = 0; s < SEGMENTS.length; s++) {
      for (const e of ev) if (e.seg === s) apply(vm, e);
      const n = SEGMENTS[s];
      scratch.fill(0);
      vm.render(scratch, n);
      out.set(scratch.subarray(0, n), pos);
      pos += n;
    }

    emit({
      id: cfg.id,
      module: 'voice-manager.ts',
      tol: 'chain',
      output: out,
      params: {
        engineId: cfg.engine.descriptor.id,
        maxVoices: cfg.voices,
        segments: SEGMENTS.join(','),
        ...packEvents(ev),
      },
      notes: 'VoiceManager only: render() is additive into a zeroed buffer, no FX.',
    });
  }
}

/**
 * The processor's own signal flow, transcribed from SigilProcessor.process():
 * zero the left channel, render the active manager into it, copy to right, then
 * FxChain.processStereo and MagicChain.processStereo in that order.
 */
export function sigilChainCases(D) {
  const configs = [
    {
      id: 'sigilchain_analog_fx',
      engine: D.AnalogEngine,
      kind: 'steal',
      voices: 4,
      fx: { 0: 0.4, 1: 0.6, 8: 220, 12: 0.35, 14: 0.7, 17: 0.4 },
      magic: { 19: 0.3 },
    },
    {
      id: 'sigilchain_analog_magic',
      engine: D.AnalogEngine,
      kind: 'params',
      voices: 4,
      fx: { 17: 0.25 },
      magic: { 3: 0.5, 11: 0.6, 12: 0.4, 19: 0.5, 20: 0.4 },
    },
  ];

  for (const cfg of configs) {
    const vm = new D.VoiceManager(cfg.engine, SR, cfg.voices);
    const fx = new D.FxChain(SR);
    const magic = new D.MagicChain(SR);
    for (const [k, v] of Object.entries(cfg.fx)) fx.setParam(Number(k), v);
    for (const [k, v] of Object.entries(cfg.magic)) magic.setParam(Number(k), v);

    const ev = scriptFor(cfg.kind);
    const total = SEGMENTS.reduce((a, b) => a + b, 0);
    const outL = new Float32Array(total);
    const outR = new Float32Array(total);
    const maxSeg = Math.max(...SEGMENTS);
    const left = new Float32Array(maxSeg);
    const right = new Float32Array(maxSeg);

    let pos = 0;
    for (let s = 0; s < SEGMENTS.length; s++) {
      for (const e of ev) if (e.seg === s) apply(vm, e);
      const n = SEGMENTS[s];
      const l = left.subarray(0, n);
      const r = right.subarray(0, n);
      l.fill(0);
      vm.render(l, n);
      r.set(l);
      fx.processStereo(l, r, n);
      magic.processStereo(l, r, n);
      outL.set(l, pos);
      outR.set(r, pos);
      pos += n;
    }

    emit({
      id: cfg.id,
      module: 'sigil-processor.ts',
      tol: 'chain',
      output: [outL, outR],
      params: {
        engineId: cfg.engine.descriptor.id,
        maxVoices: cfg.voices,
        segments: SEGMENTS.join(','),
        fxIndices: Object.keys(cfg.fx).join(','),
        fxValues: Object.values(cfg.fx).join(','),
        magicIndices: Object.keys(cfg.magic).join(','),
        magicValues: Object.values(cfg.magic).join(','),
        ...packEvents(ev),
      },
      notes: 'VoiceManager -> FxChain.processStereo -> MagicChain.processStereo.',
    });
  }
}
