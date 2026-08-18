// src/dsp/tuning.ts
var TuningTable = class {
  divisions = 12;
  refNote = 69;
  refHz = 440;
  setEqualDivisions(n) {
    this.divisions = n < 1 ? 1 : n;
  }
  setReference(midiNote, hz) {
    this.refNote = midiNote;
    this.refHz = hz;
  }
  frequency(midiNote) {
    return this.refHz * Math.pow(2, (midiNote - this.refNote) / this.divisions);
  }
};

// src/dsp/voice-manager.ts
var VoiceManager = class {
  tuning = new TuningTable();
  slots = [];
  paramCount;
  paramValues;
  counter = 0;
  constructor(engine, sampleRate2, maxVoices) {
    this.paramCount = engine.descriptor.params.length;
    this.paramValues = new Float32Array(this.paramCount);
    for (let i = 0; i < this.paramCount; i++) {
      this.paramValues[i] = engine.descriptor.params[i]?.default ?? 0;
    }
    for (let i = 0; i < maxVoices; i++) {
      this.slots.push({
        voice: engine.allocVoice(sampleRate2),
        index: i,
        note: -1,
        age: 0,
        held: false,
        busy: false
      });
    }
  }
  get activeCount() {
    let n = 0;
    for (const s of this.slots) if (s.busy) n++;
    return n;
  }
  setParam(index, value) {
    if (index < 0 || index >= this.paramCount) return;
    this.paramValues[index] = value;
    for (const s of this.slots) s.voice.setParam(index, value);
  }
  claim() {
    for (const s of this.slots) if (!s.busy) return s;
    let victim = this.slots[0];
    for (const s of this.slots) {
      const better = !s.held && victim.held || s.held === victim.held && s.age < victim.age;
      if (better) victim = s;
    }
    return victim;
  }
  noteOn(midiNote, velocity) {
    const slot = this.claim();
    for (let i = 0; i < this.paramCount; i++) {
      slot.voice.setParam(i, this.paramValues[i]);
    }
    slot.note = midiNote;
    slot.age = this.counter++;
    slot.held = true;
    slot.busy = true;
    slot.voice.noteOn(this.tuning.frequency(midiNote), velocity, slot.index);
  }
  /** Releases everything sounding — used when switching engines. */
  allNotesOff() {
    for (const s of this.slots) {
      if (s.busy) {
        s.held = false;
        s.voice.noteOff();
      }
    }
  }
  noteOff(midiNote) {
    for (const s of this.slots) {
      if (s.busy && s.held && s.note === midiNote) {
        s.held = false;
        s.voice.noteOff();
      }
    }
  }
  render(out, count) {
    for (const s of this.slots) {
      if (!s.busy) continue;
      s.voice.render(out, 0, count);
      if (s.voice.isFinished()) {
        s.busy = false;
        s.note = -1;
        s.held = false;
      }
    }
  }
};

// src/dsp/analog-descriptor.ts
var ANALOG_DESCRIPTOR = {
  id: "analog",
  name: "Analog",
  colour: "#FF6B6B",
  macroNames: ["Body", "Air", "Grit", "Motion"],
  params: [
    {
      id: "osc-detune",
      name: "Detune",
      group: "Oscillators",
      unit: "semitones",
      min: 0,
      max: 0.5,
      default: 0.06,
      curve: "linear",
      macro: 0,
      macroDepth: 0.4,
      mutability: 0.8,
      explain: "Pushes the two oscillators slightly out of tune with each other. Small amounts make the sound thicker and alive; large amounts sound broken and seasick."
    },
    {
      id: "osc-drift",
      name: "Drift",
      group: "Oscillators",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.25,
      curve: "linear",
      macro: 3,
      macroDepth: 0.5,
      mutability: 0.9,
      explain: "Slow random wandering of oscillator pitch, imitating analog circuits that never hold perfectly still. This is the cheapest way to stop a digital synth sounding sterile."
    },
    {
      id: "filter-cutoff",
      name: "Cutoff",
      group: "Filter",
      unit: "hz",
      min: 20,
      max: 18e3,
      default: 1800,
      curve: "exp",
      macro: 1,
      macroDepth: 0.8,
      mutability: 0.9,
      explain: "The brightness control. Everything above this frequency is progressively removed, so lowering it makes the sound darker and more distant."
    },
    {
      id: "filter-resonance",
      name: "Resonance",
      group: "Filter",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.15,
      curve: "linear",
      macro: 2,
      macroDepth: 0.5,
      mutability: 0.7,
      explain: "Emphasises frequencies right at the cutoff point. Raise it for a vocal, squelchy character; near maximum the filter starts to whistle on its own."
    },
    {
      id: "filter-env",
      name: "Env Amount",
      group: "Filter",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.5,
      curve: "linear",
      mutability: 0.8,
      explain: 'How far the envelope sweeps the cutoff when a note starts. This is what makes a note go "wow" or "pluck" rather than simply appearing.'
    },
    {
      id: "amp-attack",
      name: "Attack",
      group: "Envelope",
      unit: "ms",
      min: 0.5,
      max: 4e3,
      default: 4,
      curve: "exp",
      mutability: 0.6,
      explain: "How long the note takes to reach full volume. Short is percussive, long turns any sound into a pad that swells in."
    },
    {
      id: "amp-decay",
      name: "Decay",
      group: "Envelope",
      unit: "ms",
      min: 1,
      max: 8e3,
      default: 400,
      curve: "exp",
      mutability: 0.6,
      explain: "How quickly the note falls from its peak to the sustain level after the attack finishes."
    },
    {
      id: "amp-sustain",
      name: "Sustain",
      group: "Envelope",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.7,
      curve: "linear",
      mutability: 0.5,
      explain: "The level the note holds at while you keep the key down. Set it to zero and every note becomes a pluck regardless of how long you hold it."
    },
    {
      id: "amp-release",
      name: "Release",
      group: "Envelope",
      unit: "ms",
      min: 1,
      max: 8e3,
      default: 300,
      curve: "exp",
      mutability: 0.6,
      explain: "How long the sound takes to fade once you let go. Long releases let chords overlap and blur into each other."
    },
    {
      id: "drive",
      name: "Drive",
      group: "Character",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.2,
      curve: "linear",
      mutability: 0.9,
      explain: "Overdrives the signal going into the filter, adding harmonics and grit. A little adds weight; a lot turns the sound aggressive and compressed."
    }
  ]
};

// src/dsp/blep.ts
function blep(t, dt) {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}
var SawOscillator = class {
  phase = 0;
  inc = 0;
  sr;
  constructor(sampleRate2) {
    this.sr = sampleRate2;
  }
  setFrequency(hz) {
    this.inc = hz / this.sr;
  }
  reset() {
    this.phase = 0;
  }
  next() {
    this.phase += this.inc;
    if (this.phase >= 1) this.phase -= 1;
    return 2 * this.phase - 1 - blep(this.phase, this.inc);
  }
};

// src/dsp/ladder.ts
var DENORMAL = 1e-20;
function saturate(x) {
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}
var LadderFilter = class {
  s1 = 0;
  s2 = 0;
  s3 = 0;
  s4 = 0;
  g = 0;
  feedback = 0;
  sr;
  maxCutoff;
  constructor(sampleRate2) {
    this.sr = sampleRate2;
    this.maxCutoff = sampleRate2 * 0.45;
    this.setCutoff(1e3);
    this.setResonance(0);
  }
  setCutoff(hz) {
    const c = hz < 10 ? 10 : hz > this.maxCutoff ? this.maxCutoff : hz;
    this.g = 1 - Math.exp(-2 * Math.PI * c / this.sr);
  }
  setResonance(r) {
    const clamped = r < 0 ? 0 : r > 1 ? 1 : r;
    this.feedback = clamped * 4;
  }
  reset() {
    this.s1 = 0;
    this.s2 = 0;
    this.s3 = 0;
    this.s4 = 0;
  }
  process(x) {
    const fb = this.feedback * (this.s4 - 0.5 * this.s3);
    const input = saturate(x - fb);
    this.s1 += this.g * (input - this.s1);
    this.s2 += this.g * (this.s1 - this.s2);
    this.s3 += this.g * (this.s2 - this.s3);
    this.s4 += this.g * (this.s3 - this.s4);
    if (this.s1 < DENORMAL && this.s1 > -DENORMAL) this.s1 = 0;
    if (this.s2 < DENORMAL && this.s2 > -DENORMAL) this.s2 = 0;
    if (this.s3 < DENORMAL && this.s3 > -DENORMAL) this.s3 = 0;
    if (this.s4 < DENORMAL && this.s4 > -DENORMAL) this.s4 = 0;
    return this.s4;
  }
};

// src/dsp/envelope.ts
var IDLE = 0;
var ATTACK = 1;
var DECAY = 2;
var SUSTAIN = 3;
var RELEASE = 4;
var Envelope = class {
  stage = IDLE;
  value = 0;
  attackCoeff = 0;
  decayCoeff = 0;
  releaseCoeff = 0;
  sustainLevel = 0.7;
  sr;
  constructor(sampleRate2) {
    this.sr = sampleRate2;
    this.set(5, 100, 0.7, 200);
  }
  coeff(ms) {
    const samples = Math.max(1, ms / 1e3 * this.sr);
    return 1 - Math.exp(-1 / (samples / 4));
  }
  set(attackMs, decayMs, sustain, releaseMs) {
    this.attackCoeff = this.coeff(attackMs);
    this.decayCoeff = this.coeff(decayMs);
    this.releaseCoeff = this.coeff(releaseMs);
    this.sustainLevel = sustain < 0 ? 0 : sustain > 1 ? 1 : sustain;
  }
  trigger() {
    this.stage = ATTACK;
  }
  release() {
    if (this.stage !== IDLE) this.stage = RELEASE;
  }
  isFinished() {
    return this.stage === IDLE;
  }
  next() {
    if (this.stage === ATTACK) {
      this.value += this.attackCoeff * (1.2 - this.value);
      if (this.value >= 1) {
        this.value = 1;
        this.stage = DECAY;
      }
    } else if (this.stage === DECAY) {
      this.value += this.decayCoeff * (this.sustainLevel - this.value);
      if (Math.abs(this.value - this.sustainLevel) < 1e-4) {
        this.value = this.sustainLevel;
        this.stage = SUSTAIN;
      }
    } else if (this.stage === RELEASE) {
      this.value += this.releaseCoeff * (0 - this.value);
      if (this.value < 1e-5) {
        this.value = 0;
        this.stage = IDLE;
      }
    }
    return this.value;
  }
};

// src/dsp/smoothing.ts
var Smoother = class {
  current = 0;
  target = 0;
  coeff;
  constructor(sampleRate2, timeMs) {
    this.coeff = 1 - Math.exp(-1 / (timeMs / 1e3 * sampleRate2));
  }
  setTarget(v) {
    this.target = v;
  }
  snap(v) {
    this.current = v;
    this.target = v;
  }
  next() {
    this.current += this.coeff * (this.target - this.current);
    if (this.current < 1e-20 && this.current > -1e-20) this.current = 0;
    return this.current;
  }
};

// src/dsp/analog-voice.ts
var P_DETUNE = 0;
var P_DRIFT = 1;
var P_CUTOFF = 2;
var P_RES = 3;
var P_FILTER_ENV = 4;
var P_ATTACK = 5;
var P_DECAY = 6;
var P_SUSTAIN = 7;
var P_RELEASE = 8;
var P_DRIVE = 9;
function saturate2(x) {
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}
var AnalogVoice = class {
  osc1;
  osc2;
  filter;
  ampEnv;
  filterEnv;
  cutoffSmooth;
  params = new Float32Array(ANALOG_DESCRIPTOR.params.length);
  baseFreq = 220;
  velocity = 1;
  active = false;
  driftPhase = 0;
  driftInc;
  constructor(sampleRate2) {
    this.osc1 = new SawOscillator(sampleRate2);
    this.osc2 = new SawOscillator(sampleRate2);
    this.filter = new LadderFilter(sampleRate2);
    this.ampEnv = new Envelope(sampleRate2);
    this.filterEnv = new Envelope(sampleRate2);
    this.cutoffSmooth = new Smoother(sampleRate2, 8);
    this.driftInc = 0.13 / sampleRate2;
    for (let i = 0; i < ANALOG_DESCRIPTOR.params.length; i++) {
      this.params[i] = ANALOG_DESCRIPTOR.params[i]?.default ?? 0;
    }
    this.cutoffSmooth.snap(this.params[P_CUTOFF]);
  }
  setParam(index, value) {
    if (index < 0 || index >= this.params.length) return;
    this.params[index] = value;
    if (index === P_ATTACK || index === P_DECAY || index === P_SUSTAIN || index === P_RELEASE) {
      this.applyEnvelopes();
    }
  }
  applyEnvelopes() {
    this.ampEnv.set(
      this.params[P_ATTACK],
      this.params[P_DECAY],
      this.params[P_SUSTAIN],
      this.params[P_RELEASE]
    );
    this.filterEnv.set(
      this.params[P_ATTACK],
      this.params[P_DECAY] * 0.8,
      this.params[P_SUSTAIN] * 0.5,
      this.params[P_RELEASE]
    );
  }
  noteOn(freq, velocity, voiceIndex) {
    this.baseFreq = freq;
    this.velocity = velocity;
    this.active = true;
    this.driftPhase = voiceIndex * 0.37 % 1;
    this.filter.reset();
    this.applyEnvelopes();
    this.ampEnv.trigger();
    this.filterEnv.trigger();
    this.cutoffSmooth.snap(this.params[P_CUTOFF]);
  }
  noteOff() {
    this.ampEnv.release();
    this.filterEnv.release();
  }
  /**
   * True only once a note has been triggered and its amp envelope has run out.
   * A freshly allocated voice reports false; VoiceManager only asks about
   * slots it has marked busy, so that is correct but worth knowing.
   */
  isFinished() {
    return this.active && this.ampEnv.isFinished();
  }
  render(out, offset, count) {
    if (!this.active) return;
    const detuneRatio = Math.pow(2, this.params[P_DETUNE] / 12);
    const driftAmt = this.params[P_DRIFT];
    const envAmt = this.params[P_FILTER_ENV];
    const drive = 1 + this.params[P_DRIVE] * 6;
    const driveComp = 1 / Math.sqrt(drive);
    this.filter.setResonance(this.params[P_RES]);
    this.cutoffSmooth.setTarget(this.params[P_CUTOFF]);
    for (let i = 0; i < count; i++) {
      this.driftPhase += this.driftInc;
      if (this.driftPhase > 1) this.driftPhase -= 1;
      const drift = Math.sin(this.driftPhase * 6.283185307) * driftAmt * 0.012;
      this.osc1.setFrequency(this.baseFreq * (1 + drift));
      this.osc2.setFrequency(this.baseFreq * detuneRatio * (1 - drift));
      let sig = (this.osc1.next() + this.osc2.next()) * 0.4;
      sig = saturate2(sig * drive) * driveComp;
      const fenv = this.filterEnv.next();
      this.filter.setCutoff(this.cutoffSmooth.next() * (1 + envAmt * fenv * 6));
      const y = this.filter.process(sig) * this.ampEnv.next() * this.velocity * 0.35;
      out[offset + i] = out[offset + i] + (y === y ? y : 0);
    }
  }
};
var AnalogEngine = {
  descriptor: ANALOG_DESCRIPTOR,
  allocVoice: (sampleRate2) => new AnalogVoice(sampleRate2)
};

// src/dsp/registry.ts
var ENGINES = [AnalogEngine];
var DEFAULT_ENGINE_ID = "analog";

// src/audio/param-transport.ts
function forEachParam(packed, fn) {
  for (let i = 0; i + 1 < packed.length; i += 2) {
    fn(packed[i], packed[i + 1]);
  }
}

// src/audio/worklet/sigil-processor.ts
var SigilProcessor = class extends AudioWorkletProcessor {
  managers = /* @__PURE__ */ new Map();
  active;
  constructor(options) {
    super(options);
    for (const engine of ENGINES) {
      this.managers.set(engine.descriptor.id, new VoiceManager(engine, sampleRate, 16));
    }
    const fallback = this.managers.get(DEFAULT_ENGINE_ID);
    if (!fallback) throw new Error("default engine missing from registry");
    this.active = fallback;
    const opts = options?.processorOptions;
    if (opts) {
      const engineId = opts["engineId"];
      if (typeof engineId === "string") {
        const vm = this.managers.get(engineId);
        if (vm) this.active = vm;
      }
      const values = opts["params"];
      if (values instanceof Float32Array) {
        for (let i = 0; i < values.length; i++) {
          this.active.setParam(i, values[i]);
        }
      }
      const note = opts["midiNote"];
      if (typeof note === "number") this.active.noteOn(note, 1);
      const releaseAt = opts["releaseAtSample"];
      if (typeof releaseAt === "number") this.releaseAtSample = releaseAt;
      const held = opts["midiNote"];
      if (typeof held === "number") this.heldNote = held;
    }
    this.port.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case "noteOn":
          this.active.noteOn(msg.note, msg.velocity);
          break;
        case "noteOff":
          this.active.noteOff(msg.note);
          break;
        case "params":
          forEachParam(msg.data, (i, v) => {
            this.active.setParam(i, v);
          });
          break;
        case "setEngine": {
          const next = this.managers.get(msg.engineId);
          if (next && next !== this.active) {
            this.active.allNotesOff();
            this.active = next;
          }
          break;
        }
        case "tuning":
          for (const vm of this.managers.values()) {
            vm.tuning.setEqualDivisions(msg.divisions);
            vm.tuning.setReference(msg.refNote, msg.refHz);
          }
          break;
        case "allNotesOff":
          this.active.allNotesOff();
          break;
      }
    };
  }
  releaseAtSample = -1;
  heldNote = -1;
  samplesRendered = 0;
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output) return true;
    const left = output[0];
    if (!left) return true;
    left.fill(0);
    this.active.render(left, left.length);
    if (this.releaseAtSample >= 0 && this.heldNote >= 0) {
      this.samplesRendered += left.length;
      if (this.samplesRendered >= this.releaseAtSample) {
        this.active.noteOff(this.heldNote);
        this.heldNote = -1;
      }
    }
    for (let ch = 1; ch < output.length; ch++) {
      output[ch]?.set(left);
    }
    return true;
  }
};
registerProcessor("sigil-processor", SigilProcessor);
