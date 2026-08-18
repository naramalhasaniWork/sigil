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
      macro: 2,
      macroDepth: 0.85,
      mutability: 0.9,
      explain: "Overdrives the signal going into the filter, adding harmonics and grit. A little adds weight; a lot turns the sound aggressive and compressed."
    },
    {
      id: "osc1-wave",
      name: "Wave 1",
      group: "Oscillators",
      unit: "none",
      min: 0,
      max: 3,
      default: 0,
      curve: "stepped",
      steps: 4,
      mutability: 0.7,
      explain: "Shape of the first oscillator: saw (bright and buzzy, the sound of strings and leads), pulse (hollow and woody), triangle (soft and flutey), sine (pure, no harmonics at all)."
    },
    {
      id: "osc2-wave",
      name: "Wave 2",
      group: "Oscillators",
      unit: "none",
      min: 0,
      max: 3,
      default: 0,
      curve: "stepped",
      steps: 4,
      mutability: 0.7,
      explain: "Shape of the second oscillator, same four choices. Mixing two different shapes is how you get a tone that no single waveform can make."
    },
    {
      id: "osc-pulse-width",
      name: "Pulse Width",
      group: "Oscillators",
      unit: "pct",
      min: 0.06,
      max: 0.94,
      default: 0.5,
      curve: "linear",
      mutability: 0.8,
      explain: "How lopsided the pulse wave is. At the halfway point it is a hollow square with no even harmonics; move away from centre and it thins out towards a nasal, reedy buzz. Only affects oscillators set to pulse."
    },
    {
      id: "osc-mix",
      name: "Osc Mix",
      group: "Oscillators",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.5,
      curve: "linear",
      mutability: 0.7,
      explain: "Balance between the two oscillators: fully left is only the first, fully right only the second. Use it to let one waveform dominate while the other just adds colour."
    },
    {
      id: "sub-mode",
      name: "Sub Shape",
      group: "Oscillators",
      unit: "none",
      min: 0,
      max: 3,
      default: 0,
      curve: "stepped",
      steps: 4,
      mutability: 0.6,
      explain: "Which sub-oscillator you get: square one octave down, square two octaves down, sine one octave down, sine two octaves down. Square is solid and present, sine is pure weight you feel more than hear."
    },
    {
      id: "sub-level",
      name: "Sub",
      group: "Oscillators",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.15,
      curve: "linear",
      macro: 0,
      macroDepth: 0.8,
      mutability: 0.8,
      explain: "Level of an extra oscillator an octave or two below the note. This is where the authority in a bass sound comes from - it adds weight without making the sound any muddier up top."
    },
    {
      id: "noise-level",
      name: "Noise",
      group: "Oscillators",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0,
      curve: "linear",
      mutability: 0.8,
      explain: "Mixes in hiss, which then passes through the filter like everything else. Essential for breath on a flute, the strike on a drum, or wind and texture under a pad."
    },
    {
      id: "unison-voices",
      name: "Unison",
      group: "Oscillators",
      unit: "none",
      min: 1,
      max: 4,
      default: 1,
      curve: "stepped",
      steps: 4,
      mutability: 0.5,
      explain: "How many detuned copies of the oscillators stack up on every note. One is clean and precise; four is the huge, shimmering wall that supersaw leads are made of. Costs proportionally more processing."
    },
    {
      id: "unison-detune",
      name: "Spread",
      group: "Oscillators",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.35,
      curve: "linear",
      mutability: 0.8,
      explain: "How far apart the stacked unison copies are tuned. Low is a gentle thickening, high is a wide chorusing swirl. Does nothing until Unison is above one."
    },
    {
      id: "glide",
      name: "Glide",
      group: "Oscillators",
      unit: "ms",
      min: 0,
      max: 2e3,
      default: 0,
      curve: "linear",
      mutability: 0.5,
      explain: "Time taken to slide from the previous note to the new one instead of jumping. Zero is a normal keyboard; a little makes leads sing, a lot makes them slither."
    },
    {
      id: "filter-keytrack",
      name: "Key Track",
      group: "Filter",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.35,
      curve: "linear",
      mutability: 0.5,
      explain: "Makes the cutoff follow the note you play, so high notes stay as bright as low ones. Without this, a patch that sings in the bass sounds muffled and dead two octaves up."
    },
    {
      id: "filter-model",
      name: "Filter Type",
      group: "Filter",
      unit: "none",
      min: 0,
      max: 2,
      default: 0,
      curve: "stepped",
      steps: 3,
      mutability: 0.6,
      explain: "Which filter circuit is doing the work: ladder (fat and steep, the classic), state-variable (cleaner and gentler, keeps more of the top), diode (squelchy and lopsided, bites hard when resonance is up). Most of a synth\u2019s personality lives here."
    },
    {
      id: "filter-velocity",
      name: "Vel > Cutoff",
      group: "Filter",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.35,
      curve: "linear",
      mutability: 0.6,
      explain: "How much playing harder opens the filter. This is why a real instrument gets brighter as well as louder when you dig in, and why a synth without it feels dead under the fingers."
    },
    {
      id: "amp-velocity",
      name: "Vel > Level",
      group: "Envelope",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.6,
      curve: "linear",
      mutability: 0.5,
      explain: "How much playing harder increases volume. At zero every note lands at exactly the same level, which is fine for organs and wrong for everything else."
    },
    {
      id: "env-curve",
      name: "Curve",
      group: "Envelope",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.5,
      curve: "linear",
      mutability: 0.6,
      explain: "Bends the shape of the envelope. Low is sharply exponential - notes snap in and drop away, which is what makes a pluck; high is slow and even, which is what makes a swell."
    },
    {
      id: "lfo-rate",
      name: "LFO Rate",
      group: "Character",
      unit: "hz",
      min: 0.02,
      max: 30,
      default: 4.5,
      curve: "exp",
      mutability: 0.8,
      explain: "Speed of the modulation wave, from one slow sweep every minute up to a fast flutter. Around 5 per second is a singer\u2019s vibrato."
    },
    {
      id: "lfo-shape",
      name: "LFO Shape",
      group: "Character",
      unit: "none",
      min: 0,
      max: 4,
      default: 0,
      curve: "stepped",
      steps: 5,
      mutability: 0.7,
      explain: "The modulation waveform: sine and triangle sweep smoothly, square jumps between two values, sample-and-hold steps randomly like an old sequencer, and random walk drifts unpredictably without ever repeating."
    },
    {
      id: "lfo-delay",
      name: "LFO Fade",
      group: "Character",
      unit: "ms",
      min: 0,
      max: 4e3,
      default: 250,
      curve: "linear",
      mutability: 0.6,
      explain: "How long the modulation takes to fade in after each note starts. Vibrato that arrives a moment late sounds like a player leaning into a note; vibrato that is already there sounds like a machine."
    },
    {
      id: "lfo-sync",
      name: "LFO Sync",
      group: "Character",
      unit: "none",
      min: 0,
      max: 1,
      default: 1,
      curve: "stepped",
      steps: 2,
      mutability: 0.5,
      explain: "On restarts the modulation wave at every note, so every note moves identically. Off lets it run free, so each note in a chord catches the wave at a different point and the chord breathes instead of pulsing as one block."
    },
    {
      id: "lfo-pitch",
      name: "LFO > Pitch",
      group: "Character",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0,
      curve: "linear",
      mutability: 0.8,
      explain: "Modulation applied to pitch: vibrato. A trace of it is the most human thing you can do to a sustained note; at maximum it is a full octave siren."
    },
    {
      id: "lfo-cutoff",
      name: "LFO > Cutoff",
      group: "Character",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0,
      curve: "linear",
      macro: 3,
      macroDepth: 0.7,
      mutability: 0.85,
      explain: "Modulation applied to filter brightness: a wobble, a slow sweep, or the throb under a dance track. This is the movement people hear first in a patch."
    },
    {
      id: "lfo-pulse-width",
      name: "LFO > Width",
      group: "Character",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.3,
      curve: "linear",
      mutability: 0.85,
      explain: "Modulation applied to pulse width, which is the sound of every string machine and lush 80s pad ever made. Needs an oscillator set to pulse before you can hear it."
    },
    {
      id: "lfo-amp",
      name: "LFO > Level",
      group: "Character",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0,
      curve: "linear",
      mutability: 0.8,
      explain: "Modulation applied to volume: tremolo. Gentle amounts add shimmer; with a square shape and full depth it chops the note into a rhythm."
    }
  ]
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

// src/dsp/filters.ts
var DENORMAL2 = 1e-20;
var MIN_CUTOFF = 10;
var MAX_CUTOFF_RATIO = 0.49;
function softLimit(x, knee, span) {
  const a = x < 0 ? -x : x;
  if (a <= knee) return x;
  const over = a - knee;
  const lim = over >= span ? knee + span * 0.5 : knee + over * (1 - over / (span + span));
  return x < 0 ? -lim : lim;
}
function asymSat(x) {
  return x >= 0 ? softLimit(x, 0.7, 1.4) : softLimit(x, 1.4, 2.8);
}
var StateVariableFilter = class {
  ic1 = 0;
  ic2 = 0;
  a1 = 0;
  a2 = 0;
  a3 = 0;
  g = 0;
  k = 2;
  cLp = 1;
  cBp = 0;
  cHp = 0;
  sr;
  maxCutoff;
  constructor(sampleRate2) {
    this.sr = sampleRate2;
    this.maxCutoff = sampleRate2 * MAX_CUTOFF_RATIO;
    this.setCutoff(1e3);
    this.setResonance(0);
  }
  setCutoff(hz) {
    const c = hz < MIN_CUTOFF ? MIN_CUTOFF : hz > this.maxCutoff ? this.maxCutoff : hz;
    this.g = Math.tan(Math.PI * c / this.sr);
    this.updateCoeffs();
  }
  /** 0 = flat, 1 = a ~30 dB peak that rings for a long time. */
  setResonance(r) {
    const clamped = r < 0 ? 0 : r > 1 ? 1 : r;
    this.k = 2 - 1.97 * clamped;
    this.updateCoeffs();
  }
  setMode(mode) {
    this.cLp = mode === "lp" ? 1 : 0;
    this.cBp = mode === "bp" ? 1 : 0;
    this.cHp = mode === "hp" ? 1 : 0;
  }
  reset() {
    this.ic1 = 0;
    this.ic2 = 0;
  }
  updateCoeffs() {
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }
  process(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    let s1 = v1 + v1 - this.ic1;
    let s2 = v2 + v2 - this.ic2;
    s1 = softLimit(s1, 3, 6);
    s2 = softLimit(s2, 3, 6);
    if (s1 < DENORMAL2 && s1 > -DENORMAL2) s1 = 0;
    if (s2 < DENORMAL2 && s2 > -DENORMAL2) s2 = 0;
    this.ic1 = s1;
    this.ic2 = s2;
    const out = this.cLp * v2 + this.cBp * v1 + this.cHp * (x - this.k * v1 - v2);
    if (!(out > -1e12 && out < 1e12)) {
      this.reset();
      return 0;
    }
    return out;
  }
};
var DiodeFilter = class {
  z1 = 0;
  z2 = 0;
  z3 = 0;
  z4 = 0;
  g1 = 0;
  g2 = 0;
  g3 = 0;
  g4 = 0;
  oneMinusG = 0;
  invDen = 1;
  k = 0;
  sr;
  maxCutoff;
  constructor(sampleRate2) {
    this.sr = sampleRate2;
    this.maxCutoff = sampleRate2 * MAX_CUTOFF_RATIO;
    this.setCutoff(1e3);
    this.setResonance(0);
  }
  setCutoff(hz) {
    const c = hz < MIN_CUTOFF ? MIN_CUTOFF : hz > this.maxCutoff ? this.maxCutoff : hz;
    const g = Math.tan(Math.PI * c / this.sr);
    const gg = g / (1 + g);
    this.g1 = gg;
    this.g2 = gg * gg;
    this.g3 = this.g2 * gg;
    this.g4 = this.g3 * gg;
    this.oneMinusG = 1 - gg;
    this.updateDen();
  }
  /** Past ~0.9 the loop gain passes unity and the filter sings on its own. */
  setResonance(r) {
    const clamped = r < 0 ? 0 : r > 1 ? 1 : r;
    this.k = 4.5 * clamped;
    this.updateDen();
  }
  reset() {
    this.z1 = 0;
    this.z2 = 0;
    this.z3 = 0;
    this.z4 = 0;
  }
  updateDen() {
    this.invDen = 1 / (1 + this.k * this.g4);
  }
  process(x) {
    const s1 = this.oneMinusG * this.z1;
    const s2 = this.oneMinusG * this.z2;
    const s3 = this.oneMinusG * this.z3;
    const s4 = this.oneMinusG * this.z4;
    const sfb = this.g3 * s1 + this.g2 * s2 + this.g1 * s3 + s4;
    const yLin = (this.g4 * x + sfb) * this.invDen;
    const u = x - this.k * asymSat(yLin);
    const y1 = this.g1 * u + s1;
    this.z1 = y1 + y1 - this.z1;
    const y2 = this.g1 * y1 + s2;
    this.z2 = y2 + y2 - this.z2;
    const y3 = this.g1 * y2 + s3;
    this.z3 = y3 + y3 - this.z3;
    const y4 = this.g1 * y3 + s4;
    this.z4 = y4 + y4 - this.z4;
    if (this.z1 < DENORMAL2 && this.z1 > -DENORMAL2) this.z1 = 0;
    if (this.z2 < DENORMAL2 && this.z2 > -DENORMAL2) this.z2 = 0;
    if (this.z3 < DENORMAL2 && this.z3 > -DENORMAL2) this.z3 = 0;
    if (this.z4 < DENORMAL2 && this.z4 > -DENORMAL2) this.z4 = 0;
    if (!(y4 > -1e12 && y4 < 1e12)) {
      this.reset();
      return 0;
    }
    return y4;
  }
};
function createFilter(model, sampleRate2) {
  if (model === "svf") return new StateVariableFilter(sampleRate2);
  if (model === "diode") return new DiodeFilter(sampleRate2);
  return new LadderFilter(sampleRate2);
}

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

// src/dsp/lfo.ts
var TWO_PI = 6.283185307179586;
var DENORMAL3 = 1e-20;
var WAVE_SAW = 0;
var WAVE_PULSE = 1;
var WAVE_SINE = 3;
var TRI_SCALE = 4.083;
function addOsc(shape, out, count, ph, tri, u, inc, pw, gain) {
  let p = ph[u];
  if (shape <= WAVE_SAW) {
    for (let i = 0; i < count; i++) {
      p += inc;
      if (p >= 1) p -= 1;
      out[i] = out[i] + (2 * p - 1 - blep(p, inc)) * gain;
    }
  } else if (shape >= WAVE_SINE) {
    for (let i = 0; i < count; i++) {
      p += inc;
      if (p >= 1) p -= 1;
      out[i] = out[i] + Math.sin(p * TWO_PI) * gain;
    }
  } else if (shape === WAVE_PULSE) {
    for (let i = 0; i < count; i++) {
      p += inc;
      if (p >= 1) p -= 1;
      let q = p + pw;
      if (q >= 1) q -= 1;
      const sq = 2 * p - 1 - blep(p, inc) - (2 * q - 1 - blep(q, inc));
      out[i] = out[i] + sq * gain;
    }
  } else {
    let t = tri[u];
    const g = gain * TRI_SCALE;
    for (let i = 0; i < count; i++) {
      p += inc;
      if (p >= 1) p -= 1;
      let q = p + 0.5;
      if (q >= 1) q -= 1;
      const sq = 2 * p - 1 - blep(p, inc) - (2 * q - 1 - blep(q, inc));
      t = t * (1 - inc) + inc * sq;
      if (t < DENORMAL3 && t > -DENORMAL3) t = 0;
      out[i] = out[i] + t * g;
    }
    tri[u] = t;
  }
  ph[u] = p;
}
var LFO_SINE = 0;
var LFO_TRIANGLE = 1;
var LFO_SQUARE = 2;
var LFO_SAMPLE_HOLD = 3;
var LFO_SHAPE_COUNT = 5;
var WALK_STEP = 0.55;
var Lfo = class {
  phase = 0;
  inc = 0;
  shape = LFO_SINE;
  depth = 1;
  fade = 1;
  fadeInc = 1;
  held = 0;
  from = 0;
  to = 0;
  rngState = 2654435769 | 0;
  sr;
  constructor(sampleRate2) {
    this.sr = sampleRate2 > 1 ? sampleRate2 : 1;
    this.setRate(4);
  }
  /** Deterministic xorshift32 in -1..1. Seeded per voice, never Math.random. */
  rand() {
    let s = this.rngState;
    s ^= s << 13;
    s |= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s |= 0;
    this.rngState = s;
    return (s >>> 0) / 2147483648 - 1;
  }
  setRate(hz) {
    const max = this.sr * 0.45;
    const f = !(hz > 0) ? 0 : hz > max ? max : hz;
    this.inc = f / this.sr;
  }
  setShape(shape) {
    const s = Math.round(shape);
    this.shape = s < 0 ? 0 : s >= LFO_SHAPE_COUNT ? LFO_SHAPE_COUNT - 1 : s;
  }
  /** Overall output scale, 0..1. Destination depths multiply on top of this. */
  setDepth(depth) {
    this.depth = !(depth > 0) ? 0 : depth > 1 ? 1 : depth;
  }
  /** Time the LFO takes to fade up to full after each note starts. */
  setDelayMs(ms) {
    const samples = ms / 1e3 * this.sr;
    this.fadeInc = samples >= 1 ? 1 / samples : 1;
  }
  /** Decorrelates one voice from the next; same index gives the same stream. */
  seed(voiceIndex) {
    const s = Math.trunc(voiceIndex) * 2654435761 + 2246822507 | 0;
    this.rngState = s === 0 ? 1831565813 | 0 : s;
    this.from = this.rand();
    this.to = this.rand();
    this.held = this.from;
  }
  /**
   * Note start. The fade always restarts; the phase only resets when the
   * patch asked for keysync.
   */
  trigger(keysync) {
    this.fade = this.fadeInc >= 1 ? 1 : 0;
    if (keysync) this.phase = 0;
  }
  reset() {
    this.phase = 0;
    this.fade = 1;
    this.from = 0;
    this.to = 0;
    this.held = 0;
  }
  next() {
    let p = this.phase + this.inc;
    if (p >= 1) {
      p -= 1;
      if (p >= 1) p = 0;
      const r = this.rand();
      this.held = r;
      this.from = this.to;
      let t = this.to + r * WALK_STEP;
      if (t > 1) t = 2 - t;
      else if (t < -1) t = -2 - t;
      this.to = t;
    }
    this.phase = p;
    let v;
    if (this.shape === LFO_SINE) {
      v = Math.sin(p * TWO_PI);
    } else if (this.shape === LFO_TRIANGLE) {
      v = p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    } else if (this.shape === LFO_SQUARE) {
      v = p < 0.5 ? 1 : -1;
    } else if (this.shape === LFO_SAMPLE_HOLD) {
      v = this.held;
    } else {
      const s = p * p * (3 - 2 * p);
      v = this.from + (this.to - this.from) * s;
    }
    if (this.fade < 1) {
      this.fade += this.fadeInc;
      if (this.fade > 1) this.fade = 1;
    }
    const out = v * this.depth * this.fade;
    return out < DENORMAL3 && out > -DENORMAL3 ? 0 : out;
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
var P_WAVE1 = 10;
var P_WAVE2 = 11;
var P_PW = 12;
var P_MIX = 13;
var P_SUB_MODE = 14;
var P_SUB_LEVEL = 15;
var P_NOISE = 16;
var P_UNISON = 17;
var P_SPREAD = 18;
var P_GLIDE = 19;
var P_KEYTRACK = 20;
var P_MODEL = 21;
var P_VEL_CUT = 22;
var P_VEL_AMP = 23;
var P_CURVE = 24;
var P_LFO_RATE = 25;
var P_LFO_SHAPE = 26;
var P_LFO_DELAY = 27;
var P_LFO_SYNC = 28;
var P_LFO_PITCH = 29;
var P_LFO_CUT = 30;
var P_LFO_PW = 31;
var P_LFO_AMP = 32;
var LN2 = 0.6931471805599453;
var TWO_PI2 = 6.283185307179586;
var CENT = 57762265e-11;
var LOG2_REF = 8.03125;
var CONTROL_STEP = 8;
var MAX_UNISON = 4;
var OSC_GAIN = 0.8;
var VOICE_GAIN = 0.35;
function saturate2(x) {
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}
function bend(v, k) {
  return v * (1 + k) / (1 + k * v);
}
var AnalogVoice = class {
  ladder;
  svf;
  diode;
  activeFilter;
  ampEnv;
  filterEnv;
  cutoffSmooth;
  lfo;
  params = new Float32Array(ANALOG_DESCRIPTOR.params.length);
  ph1 = new Float64Array(MAX_UNISON);
  ph2 = new Float64Array(MAX_UNISON);
  tri1 = new Float64Array(MAX_UNISON);
  tri2 = new Float64Array(MAX_UNISON);
  inc1 = new Float64Array(MAX_UNISON);
  inc2 = new Float64Array(MAX_UNISON);
  driftPhase = new Float64Array(MAX_UNISON);
  driftInc = new Float64Array(MAX_UNISON);
  /** Detune positions per unison count, row-major: (count - 1) * 4 + slot. */
  spread = new Float64Array(MAX_UNISON * MAX_UNISON);
  /** Oscillator sum for one control step, before filter and amplifier. */
  mix = new Float64Array(CONTROL_STEP);
  invSr;
  ctrlRate;
  maxFreq;
  uni = 1;
  uniGain = 1;
  subPh = new Float64Array(1);
  subTri = new Float64Array(1);
  subInc = 0;
  subRatio = 0.5;
  detuneMul = 1;
  noiseState = 2654435769 | 0;
  ctrl = 0;
  pw = 0.5;
  ampMod = 1;
  envK = 0;
  logFreq = 7.78;
  logTarget = 7.78;
  glideCoeff = 1;
  velocity = 1;
  active = false;
  constructor(sampleRate2) {
    this.invSr = 1 / sampleRate2;
    this.ctrlRate = sampleRate2 / CONTROL_STEP;
    this.maxFreq = sampleRate2 * 0.45;
    this.ladder = createFilter("ladder", sampleRate2);
    this.svf = createFilter("svf", sampleRate2);
    this.diode = createFilter("diode", sampleRate2);
    this.activeFilter = this.ladder;
    this.ampEnv = new Envelope(sampleRate2);
    this.filterEnv = new Envelope(this.ctrlRate);
    this.cutoffSmooth = new Smoother(sampleRate2 / CONTROL_STEP, 8);
    this.lfo = new Lfo(sampleRate2 / CONTROL_STEP);
    for (let i = 0; i < this.params.length; i++) {
      this.params[i] = ANALOG_DESCRIPTOR.params[i]?.default ?? 0;
    }
    this.spread[4] = -1;
    this.spread[5] = 1;
    this.spread[8] = -1;
    this.spread[10] = 1;
    this.spread[12] = -1;
    this.spread[13] = -0.34;
    this.spread[14] = 0.34;
    this.spread[15] = 1;
    this.applyEnvelopes();
    this.applyLfo();
    this.cutoffSmooth.snap(this.params[P_CUTOFF]);
  }
  setParam(index, value) {
    if (index < 0 || index >= this.params.length) return;
    this.params[index] = value;
    if (index >= P_ATTACK && index <= P_RELEASE) this.applyEnvelopes();
    else if (index === P_CURVE) this.envK = (value - 0.5) * 1.6;
    else if (index >= P_LFO_RATE && index <= P_LFO_DELAY) this.applyLfo();
  }
  applyEnvelopes() {
    const p = this.params;
    const a = p[P_ATTACK], d = p[P_DECAY];
    const s = p[P_SUSTAIN], r = p[P_RELEASE];
    this.ampEnv.set(a, d, s, r);
    this.filterEnv.set(a, d * 0.8, s * 0.5, r);
  }
  applyLfo() {
    this.lfo.setRate(this.params[P_LFO_RATE]);
    this.lfo.setShape(this.params[P_LFO_SHAPE]);
    this.lfo.setDelayMs(this.params[P_LFO_DELAY]);
  }
  noteOn(freq, velocity, voiceIndex) {
    const p = this.params;
    const f = freq > 8 ? freq < 12e3 ? freq : 12e3 : 8;
    const target = Math.log2(f);
    const glideMs = p[P_GLIDE];
    if (!this.active || !(glideMs > 0)) this.logFreq = target;
    this.logTarget = target;
    const steps = Math.max(1, glideMs / 1e3 * this.ctrlRate);
    this.glideCoeff = glideMs > 0 ? 1 - Math.exp(-4 / steps) : 1;
    this.velocity = velocity > 0 ? velocity < 1 ? velocity : 1 : 0;
    this.envK = (p[P_CURVE] - 0.5) * 1.6;
    const n = Math.round(p[P_UNISON]);
    this.uni = n < 1 ? 1 : n > MAX_UNISON ? MAX_UNISON : n;
    this.uniGain = 1 / Math.sqrt(this.uni);
    for (let u = 0; u < MAX_UNISON; u++) {
      this.ph1[u] = ((voiceIndex * 0.137 + u * 0.618) % 1 + 1) % 1;
      this.ph2[u] = ((voiceIndex * 0.311 + u * 0.382) % 1 + 1) % 1;
      this.tri1[u] = 0;
      this.tri2[u] = 0;
      this.driftPhase[u] = ((voiceIndex * 0.37 + u * 0.211) % 1 + 1) % 1;
      this.driftInc[u] = (0.11 + u * 0.041 + voiceIndex % 4 * 0.017) * this.invSr * CONTROL_STEP;
    }
    this.subPh[0] = 0;
    const seed = (voiceIndex + 1) * 1831565813 | 0;
    this.noiseState = seed === 0 ? 2654435769 | 0 : seed;
    this.ladder.reset();
    this.svf.reset();
    this.diode.reset();
    this.applyEnvelopes();
    this.applyLfo();
    this.lfo.seed(voiceIndex);
    this.lfo.trigger(p[P_LFO_SYNC] >= 0.5);
    this.ampEnv.trigger();
    this.filterEnv.trigger();
    this.cutoffSmooth.snap(p[P_CUTOFF]);
    this.ctrl = 0;
    this.active = true;
  }
  noteOff() {
    this.ampEnv.release();
    this.filterEnv.release();
  }
  /** True once a note has been triggered and its amp envelope has run out. */
  isFinished() {
    return this.active && this.ampEnv.isFinished();
  }
  /** Everything that moves slower than audio, recomputed once per control step. */
  updateControl() {
    const p = this.params;
    const lfoV = this.lfo.next();
    this.logFreq += this.glideCoeff * (this.logTarget - this.logFreq);
    const vib = p[P_LFO_PITCH] * p[P_LFO_PITCH] * lfoV;
    const base = Math.exp(LN2 * (this.logFreq + vib));
    const driftAmt = p[P_DRIFT] * 0.012;
    const spreadAmt = p[P_SPREAD] * 30 * CENT;
    const row = (this.uni - 1) * MAX_UNISON;
    const max = this.maxFreq;
    for (let u = 0; u < this.uni; u++) {
      let dp = this.driftPhase[u] + this.driftInc[u];
      if (dp >= 1) dp -= 1;
      this.driftPhase[u] = dp;
      const dev = Math.sin(dp * TWO_PI2) * driftAmt + this.spread[row + u] * spreadAmt;
      const f1 = base * (1 + dev);
      const f2 = base * this.detuneMul * (1 - dev);
      this.inc1[u] = (f1 > max ? max : f1 < 0.01 ? 0.01 : f1) * this.invSr;
      this.inc2[u] = (f2 > max ? max : f2 < 0.01 ? 0.01 : f2) * this.invSr;
    }
    const fs = base * this.subRatio;
    this.subInc = (fs > max ? max : fs < 0.01 ? 0.01 : fs) * this.invSr;
    const fenv = bend(this.filterEnv.next(), this.envK);
    const oct = p[P_KEYTRACK] * (this.logFreq - LOG2_REF) + p[P_LFO_CUT] * 3 * lfoV - p[P_VEL_CUT] * 4 * (1 - this.velocity);
    let cut = this.cutoffSmooth.next() * Math.exp(LN2 * oct) * (1 + p[P_FILTER_ENV] * fenv * 6);
    if (!(cut > 10)) cut = 10;
    else if (cut > max) cut = max;
    this.activeFilter.setCutoff(cut);
    const w = p[P_PW] + p[P_LFO_PW] * lfoV * 0.45;
    this.pw = w < 0.06 ? 0.06 : w > 0.94 ? 0.94 : w;
    this.ampMod = 1 - p[P_LFO_AMP] * 0.5 * (1 - lfoV);
  }
  render(out, offset, count) {
    if (!this.active) return;
    const p = this.params;
    const model = Math.round(p[P_MODEL]);
    const filter = model === 1 ? this.svf : model === 2 ? this.diode : this.ladder;
    this.activeFilter = filter;
    filter.setResonance(p[P_RES]);
    const drive = 1 + p[P_DRIVE] * 6, driveComp = 1 / Math.sqrt(drive);
    const w1 = Math.round(p[P_WAVE1]), w2 = Math.round(p[P_WAVE2]);
    const raw = p[P_MIX];
    const bal = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    const g1 = (1 - bal) * OSC_GAIN * this.uniGain, g2 = bal * OSC_GAIN * this.uniGain;
    const subMode = Math.round(p[P_SUB_MODE]);
    const subShape = subMode >= 2 ? WAVE_SINE : WAVE_PULSE;
    const subLevel = p[P_SUB_LEVEL] * 0.9;
    const noiseLevel = p[P_NOISE] * 0.5, velAmp = p[P_VEL_AMP];
    const gain = (1 - velAmp + velAmp * this.velocity * this.velocity) * VOICE_GAIN;
    const n = this.uni;
    const k = this.envK;
    this.detuneMul = Math.exp(LN2 * p[P_DETUNE] / 12);
    this.subRatio = (subMode & 1) === 1 ? 0.25 : 0.5;
    this.cutoffSmooth.setTarget(p[P_CUTOFF]);
    const mix = this.mix;
    let noise = this.noiseState;
    let i = 0;
    while (i < count) {
      if (this.ctrl === 0) {
        this.updateControl();
        this.ctrl = CONTROL_STEP;
      }
      const m = this.ctrl < count - i ? this.ctrl : count - i;
      const pw = this.pw;
      for (let j = 0; j < m; j++) mix[j] = 0;
      for (let u = 0; u < n; u++) {
        addOsc(w1, mix, m, this.ph1, this.tri1, u, this.inc1[u], pw, g1);
        addOsc(w2, mix, m, this.ph2, this.tri2, u, this.inc2[u], pw, g2);
      }
      if (subLevel > 0) {
        addOsc(subShape, mix, m, this.subPh, this.subTri, 0, this.subInc, 0.5, subLevel);
      }
      const amp = gain * this.ampMod;
      for (let j = 0; j < m; j++) {
        let sig = mix[j];
        if (noiseLevel > 0) {
          noise ^= noise << 13;
          noise |= 0;
          noise ^= noise >>> 17;
          noise ^= noise << 5;
          noise |= 0;
          sig += ((noise >>> 0) / 2147483648 - 1) * noiseLevel;
        }
        sig = saturate2(sig * drive) * driveComp;
        const e = this.ampEnv.next();
        let y = filter.process(sig) * (k === 0 ? e : bend(e, k)) * amp;
        if (!(y > -4 && y < 4)) y = y > 0 ? 4 : y < 0 ? -4 : 0;
        out[offset + i + j] = out[offset + i + j] + y;
      }
      i += m;
      this.ctrl -= m;
    }
    this.noiseState = noise;
  }
};
var AnalogEngine = {
  descriptor: ANALOG_DESCRIPTOR,
  allocVoice: (sampleRate2) => new AnalogVoice(sampleRate2)
};

// src/dsp/fm-descriptor.ts
function op(n, ratio, level, why) {
  return [
    {
      id: `op${n}-ratio`,
      name: `Op ${n} Ratio`,
      group: `Operator ${n}`,
      unit: "ratio",
      min: 0.5,
      max: 16,
      default: ratio,
      curve: "stepped",
      steps: 17,
      mutability: 0.7,
      explain: `How fast operator ${n} runs compared to the note you played. Whole numbers stay musical and harmonic; the half-speed setting adds an octave-below weight. ${why}`
    },
    {
      id: `op${n}-fine`,
      name: `Op ${n} Fine`,
      group: `Operator ${n}`,
      unit: "semitones",
      min: -0.5,
      max: 0.5,
      default: 0,
      curve: "linear",
      mutability: 0.8,
      explain: `Nudges operator ${n} slightly off its exact ratio. Tiny amounts make the tone breathe and beat slowly instead of standing dead still; large amounts sound out of tune.`
    },
    {
      id: `op${n}-level`,
      name: `Op ${n} Level`,
      group: `Operator ${n}`,
      unit: "pct",
      min: 0,
      max: 1,
      default: level,
      curve: "linear",
      mutability: 0.8,
      explain: `How loud operator ${n} is. When it is a carrier this is volume; when it is a modulator this is how hard it bends the operator below it, which means brightness.`
    }
  ];
}
var FM_DESCRIPTOR = {
  id: "fm",
  name: "FM",
  colour: "#4ECDC4",
  macroNames: ["Body", "Air", "Grit", "Motion"],
  params: [
    {
      id: "algorithm",
      name: "Algorithm",
      group: "Routing",
      unit: "none",
      min: 0,
      max: 4,
      default: 2,
      curve: "stepped",
      steps: 5,
      mutability: 0.6,
      explain: "Which operators feed which: 0 is a two-operator stack, 1 a three-operator stack, 2 two stacks side by side, 3 four plain sines together, 4 a feedback branch. This is the single biggest change to the character of the sound."
    },
    ...op(1, 1, 1, "Operator 1 is a carrier in every algorithm, so its ratio sets the pitch you actually hear."),
    ...op(2, 2, 0.75, "As a modulator its ratio decides which overtones appear above the note."),
    ...op(3, 1, 0.9, "It is a carrier in the twin-stack and parallel algorithms, a modulator elsewhere."),
    ...op(4, 3, 0.7, "This is the operator that can feed back into itself, so odd ratios here get noisy fast."),
    {
      id: "index",
      name: "Index",
      group: "Tone",
      unit: "pct",
      min: 0,
      max: 12,
      default: 3,
      curve: "exp",
      macro: 1,
      macroDepth: 0.7,
      mutability: 0.9,
      explain: "How hard the modulating operators bend the carriers. At zero you get plain sine tones; raise it and overtones pile on, turning soft bells into bright metallic attacks. This is the brightness control of an FM synth."
    },
    {
      id: "key-scale",
      name: "Key Scale",
      group: "Tone",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.6,
      curve: "linear",
      mutability: 0.5,
      explain: "Pulls the index back down as you play higher notes. Without it a patch that sounds rich in the bass turns into harsh fizz at the top of the keyboard, because the overtones run past what your ears can take."
    },
    {
      id: "feedback",
      name: "Feedback",
      group: "Tone",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.15,
      curve: "linear",
      macro: 2,
      macroDepth: 0.6,
      mutability: 0.9,
      explain: "Feeds operator 4 back into itself. A little roughens the tone the way a bowed string is rough; pushed hard the sine collapses toward noise, which is how FM makes cymbals and breath."
    },
    {
      id: "spread",
      name: "Spread",
      group: "Tone",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.2,
      curve: "linear",
      macro: 3,
      macroDepth: 0.6,
      mutability: 0.9,
      explain: "Detunes the four operators away from each other by small, different amounts. The overtones then drift in and out of step, so a held note keeps moving instead of freezing into a dead tone."
    },
    {
      id: "balance",
      name: "Balance",
      group: "Mix",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.45,
      curve: "linear",
      macro: 0,
      macroDepth: 0.5,
      mutability: 0.7,
      explain: "Tilts the mix between the lower and upper carriers. Turn it down for weight and fundamental; turn it up for the thinner, brighter carrier on top. With a single-carrier algorithm it simply sets how much body the note has."
    },
    {
      id: "amp-attack",
      name: "Attack",
      group: "Carrier Envelope",
      unit: "ms",
      min: 0.5,
      max: 4e3,
      default: 3,
      curve: "exp",
      mutability: 0.6,
      explain: "How long the note takes to reach full volume. Very short is what makes FM pianos and basses snap; long turns the same patch into a glass pad."
    },
    {
      id: "amp-decay",
      name: "Decay",
      group: "Carrier Envelope",
      unit: "ms",
      min: 1,
      max: 8e3,
      default: 700,
      curve: "exp",
      mutability: 0.6,
      explain: "How quickly the note falls from its peak toward the sustain level. Short decays with no sustain give you the classic FM bell and electric piano."
    },
    {
      id: "amp-sustain",
      name: "Sustain",
      group: "Carrier Envelope",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.55,
      curve: "linear",
      mutability: 0.5,
      explain: "The level the note holds at while the key is down. Set it to zero and every note decays away on its own like a struck object."
    },
    {
      id: "amp-release",
      name: "Release",
      group: "Carrier Envelope",
      unit: "ms",
      min: 1,
      max: 8e3,
      default: 400,
      curve: "exp",
      mutability: 0.6,
      explain: "How long the note takes to fade after you let go. Longer releases let chords ring into each other, which flatters bell and mallet tones."
    },
    {
      id: "mod-attack",
      name: "Mod Attack",
      group: "Modulator Envelope",
      unit: "ms",
      min: 0.5,
      max: 4e3,
      default: 1,
      curve: "exp",
      mutability: 0.7,
      explain: "How long the modulating operators take to reach full strength. Slow it down and the note fades in from dull to bright, which reads as a bowed or blown attack."
    },
    {
      id: "mod-decay",
      name: "Mod Decay",
      group: "Modulator Envelope",
      unit: "ms",
      min: 1,
      max: 8e3,
      default: 400,
      curve: "exp",
      mutability: 0.8,
      explain: "How fast the brightness falls away after the attack. A short mod decay with a long carrier decay is the whole trick behind FM electric pianos: bright strike, mellow tail."
    },
    {
      id: "mod-sustain",
      name: "Mod Sustain",
      group: "Modulator Envelope",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.3,
      curve: "linear",
      mutability: 0.7,
      explain: "How much brightness remains while you hold the note. Low values keep held notes calm no matter how extreme the initial attack was."
    },
    {
      id: "mod-release",
      name: "Mod Release",
      group: "Modulator Envelope",
      unit: "ms",
      min: 1,
      max: 8e3,
      default: 300,
      curve: "exp",
      mutability: 0.6,
      explain: "How the overtones fade once you let go. Making this shorter than the carrier release means notes soften into pure sine as they die away."
    }
  ]
};

// src/dsp/fm-voice.ts
var P_ALGO = 0;
var P_OP_BASE = 1;
var P_OP_STRIDE = 3;
var P_INDEX = 13;
var P_KEY_SCALE = 14;
var P_FEEDBACK = 15;
var P_SPREAD2 = 16;
var P_BALANCE = 17;
var P_AMP_A = 18;
var P_MOD_A = 22;
var N_OPS = 4;
var MAX_ALGO = 4;
var TAU = Math.PI * 2;
var DENORM = 1e-20;
var REF_HZ = 261.6256;
var CARRIER_MASK = new Uint8Array([1, 1, 5, 15, 3]);
var SPREAD_SEMIS = new Float32Array([0, 0.035, -0.026, 0.061]);
function softClip(x) {
  return x / (1 + (x < 0 ? -x : x));
}
function quantizeRatio(v) {
  if (v < 0.75) return 0.5;
  const r = Math.round(v);
  return r < 1 ? 1 : r > 16 ? 16 : r;
}
var FmVoice = class {
  params = new Float32Array(FM_DESCRIPTOR.params.length);
  inc = new Float32Array(N_OPS);
  level = new Float32Array(N_OPS);
  carrierGain = new Float32Array(N_OPS);
  envA;
  envB;
  envC;
  envD;
  indexSmooth;
  fbSmooth;
  sr;
  baseFreq = 220;
  velocity = 1;
  active = false;
  algo = 0;
  carrierMask = 1;
  keyScale = 1;
  ph0 = 0;
  ph1 = 0;
  ph2 = 0;
  ph3 = 0;
  fbZ1 = 0;
  fbZ2 = 0;
  constructor(sampleRate2) {
    this.sr = sampleRate2;
    this.envA = new Envelope(sampleRate2);
    this.envB = new Envelope(sampleRate2);
    this.envC = new Envelope(sampleRate2);
    this.envD = new Envelope(sampleRate2);
    this.indexSmooth = new Smoother(sampleRate2, 12);
    this.fbSmooth = new Smoother(sampleRate2, 12);
    for (let i = 0; i < FM_DESCRIPTOR.params.length; i++) {
      this.params[i] = FM_DESCRIPTOR.params[i]?.default ?? 0;
    }
    this.applyRouting();
    this.indexSmooth.snap(this.params[P_INDEX]);
    this.fbSmooth.snap(this.params[P_FEEDBACK]);
  }
  setParam(index, value) {
    if (index < 0 || index >= this.params.length) return;
    this.params[index] = value;
    if (index === P_ALGO) this.applyRouting();
    else if (index >= P_AMP_A) this.applyEnvelopes();
  }
  applyRouting() {
    const raw = this.params[P_ALGO];
    const q = raw < 0 ? 0 : raw > MAX_ALGO ? MAX_ALGO : Math.round(raw);
    this.algo = q;
    this.carrierMask = CARRIER_MASK[q];
    this.applyEnvelopes();
  }
  /** Carriers follow the amp ADSR, modulators the brightness ADSR. */
  configure(env, bit) {
    const base = (this.carrierMask & bit) !== 0 ? P_AMP_A : P_MOD_A;
    env.set(
      this.params[base],
      this.params[base + 1],
      this.params[base + 2],
      this.params[base + 3]
    );
  }
  applyEnvelopes() {
    this.configure(this.envA, 1);
    this.configure(this.envB, 2);
    this.configure(this.envC, 4);
    this.configure(this.envD, 8);
  }
  /** Block-rate work: operator increments, levels, carrier balance, key scaling. */
  updateBlock() {
    const spread = this.params[P_SPREAD2];
    for (let k = 0; k < N_OPS; k++) {
      const b = P_OP_BASE + k * P_OP_STRIDE;
      const ratio = quantizeRatio(this.params[b]);
      const semis = this.params[b + 1] + SPREAD_SEMIS[k] * spread;
      const f = this.baseFreq * ratio * Math.pow(2, semis / 12) / this.sr;
      this.inc[k] = f > 0.45 ? 0.45 : f;
      this.level[k] = this.params[b + 2];
    }
    const ks = Math.pow(REF_HZ / this.baseFreq, this.params[P_KEY_SCALE]);
    this.keyScale = ks < 0.15 ? 0.15 : ks > 2.5 ? 2.5 : ks;
    const mask = this.carrierMask;
    let n = 0;
    for (let k = 0; k < N_OPS; k++) if ((mask & 1 << k) !== 0) n++;
    const tilt = this.params[P_BALANCE];
    let rank = 0;
    for (let k = 0; k < N_OPS; k++) {
      if ((mask & 1 << k) === 0) {
        this.carrierGain[k] = 0;
        continue;
      }
      const p = n > 1 ? rank / (n - 1) : 0;
      this.carrierGain[k] = (1 - tilt) * (1 - 0.85 * p) + tilt * (0.15 + 0.85 * p);
      rank++;
    }
  }
  noteOn(freq, velocity, voiceIndex) {
    this.baseFreq = freq > 1 ? freq : 1;
    this.velocity = velocity;
    this.active = true;
    const off = voiceIndex * 0.113 % 1;
    this.ph0 = off;
    this.ph1 = (off + 0.017) % 1;
    this.ph2 = (off + 0.041) % 1;
    this.ph3 = (off + 0.073) % 1;
    this.fbZ1 = 0;
    this.fbZ2 = 0;
    this.applyRouting();
    this.envA.trigger();
    this.envB.trigger();
    this.envC.trigger();
    this.envD.trigger();
    this.indexSmooth.snap(this.params[P_INDEX]);
    this.fbSmooth.snap(this.params[P_FEEDBACK]);
  }
  noteOff() {
    this.envA.release();
    this.envB.release();
    this.envC.release();
    this.envD.release();
  }
  /** Finished once every carrier envelope has run out; modulators do not
   *  hold a voice open because they make no sound of their own. */
  isFinished() {
    if (!this.active) return false;
    const m = this.carrierMask;
    if ((m & 1) !== 0 && !this.envA.isFinished()) return false;
    if ((m & 2) !== 0 && !this.envB.isFinished()) return false;
    if ((m & 4) !== 0 && !this.envC.isFinished()) return false;
    if ((m & 8) !== 0 && !this.envD.isFinished()) return false;
    return true;
  }
  render(out, offset, count) {
    if (!this.active) return;
    this.updateBlock();
    const i0 = this.inc[0];
    const i1 = this.inc[1];
    const i2 = this.inc[2];
    const i3 = this.inc[3];
    const l0 = this.level[0];
    const l1 = this.level[1];
    const l2 = this.level[2];
    const l3 = this.level[3];
    const g0 = this.carrierGain[0];
    const g1 = this.carrierGain[1];
    const g2 = this.carrierGain[2];
    const g3 = this.carrierGain[3];
    const algo = this.algo;
    const ks = this.keyScale;
    const amp = this.velocity * 0.32;
    this.indexSmooth.setTarget(this.params[P_INDEX]);
    this.fbSmooth.setTarget(this.params[P_FEEDBACK]);
    for (let n = 0; n < count; n++) {
      const e0 = this.envA.next();
      const e1 = this.envB.next();
      const e2 = this.envC.next();
      const e3 = this.envD.next();
      const index = this.indexSmooth.next() * ks;
      this.ph0 += i0;
      if (this.ph0 >= 1) this.ph0 -= 1;
      this.ph1 += i1;
      if (this.ph1 >= 1) this.ph1 -= 1;
      this.ph2 += i2;
      if (this.ph2 >= 1) this.ph2 -= 1;
      this.ph3 += i3;
      if (this.ph3 >= 1) this.ph3 -= 1;
      const fbArg = softClip((this.fbZ1 + this.fbZ2) * 0.5) * this.fbSmooth.next() * Math.PI;
      const m3 = Math.sin(this.ph3 * TAU + fbArg) * l3 * e3;
      this.fbZ2 = this.fbZ1 < DENORM && this.fbZ1 > -DENORM ? 0 : this.fbZ1;
      this.fbZ1 = m3 < DENORM && m3 > -DENORM ? 0 : m3;
      let y = 0;
      if (algo === 0) {
        const m1 = Math.sin(this.ph1 * TAU) * l1 * e1 * index;
        y = Math.sin(this.ph0 * TAU + m1) * l0 * e0 * g0;
      } else if (algo === 1) {
        const m2 = Math.sin(this.ph2 * TAU) * l2 * e2 * index;
        const m1 = Math.sin(this.ph1 * TAU + m2) * l1 * e1 * index;
        y = Math.sin(this.ph0 * TAU + m1) * l0 * e0 * g0;
      } else if (algo === 2) {
        const m1 = Math.sin(this.ph1 * TAU) * l1 * e1 * index;
        y = Math.sin(this.ph0 * TAU + m1) * l0 * e0 * g0 + Math.sin(this.ph2 * TAU + m3 * index) * l2 * e2 * g2;
      } else if (algo === 3) {
        y = Math.sin(this.ph0 * TAU) * l0 * e0 * g0 + Math.sin(this.ph1 * TAU) * l1 * e1 * g1 + Math.sin(this.ph2 * TAU) * l2 * e2 * g2 + m3 * g3;
      } else {
        const m2 = Math.sin(this.ph2 * TAU) * l2 * e2 * index;
        y = Math.sin(this.ph0 * TAU + m2) * l0 * e0 * g0 + Math.sin(this.ph1 * TAU + m3 * index) * l1 * e1 * g1;
      }
      const s = y * amp;
      out[offset + n] = out[offset + n] + (s === s ? s : 0);
    }
  }
};
var FmEngine = {
  descriptor: FM_DESCRIPTOR,
  allocVoice: (sampleRate2) => new FmVoice(sampleRate2)
};

// src/dsp/physical-descriptor.ts
var PHYSICAL_DESCRIPTOR = {
  id: "physical",
  name: "Physical",
  colour: "#FFD93D",
  macroNames: ["Body", "Air", "Grit", "Motion"],
  params: [
    {
      id: "material",
      name: "Material",
      group: "Body",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.62,
      curve: "linear",
      macro: 0,
      macroDepth: 0.9,
      mutability: 0.9,
      explain: "Morphs the resonator between four real objects: drum head, wood bar, struck metal and glass. It reshapes the whole set of ringing frequencies, so it changes what the sound IS rather than how it is filtered."
    },
    {
      id: "structure",
      name: "Structure",
      group: "Body",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.25,
      curve: "linear",
      mutability: 0.8,
      explain: "Stretches the upper partials sharp, the way a stiff or thick object goes out of tune with itself. A little makes the body feel solid and real; a lot makes it clangy and bell-like."
    },
    {
      id: "decay",
      name: "Decay",
      group: "Body",
      unit: "ms",
      min: 20,
      max: 3e3,
      default: 900,
      curve: "exp",
      mutability: 0.7,
      explain: "How long the object rings after it is hit, before it falls silent. Short is a tap on a table, long is a struck cymbal left to ring out."
    },
    {
      id: "damping",
      name: "Damping",
      group: "Body",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.35,
      curve: "linear",
      macro: 3,
      macroDepth: 0.55,
      mutability: 0.9,
      explain: "Muffles the object, killing high partials much faster than low ones \u2014 exactly what happens when you rest a hand on a cymbal or wrap a drum in cloth. It makes a bright ring turn into a dull thud over time."
    },
    {
      id: "position",
      name: "Position",
      group: "Body",
      unit: "pct",
      min: 0.02,
      max: 0.98,
      default: 0.28,
      curve: "linear",
      mutability: 0.9,
      explain: "Where on the object you strike it. Near the edge you wake up the higher, thinner partials; nearer the middle you get the fat fundamental. It is the difference between a rim shot and a centre hit."
    },
    {
      id: "air",
      name: "Air",
      group: "Body",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.55,
      curve: "linear",
      macro: 1,
      macroDepth: 0.7,
      mutability: 0.9,
      explain: "How many partials the object is allowed to ring with, and how loud the high ones are. Low is a small dead object, high is a big shimmering one with lots of overtones in the air."
    },
    {
      id: "exciter-type",
      name: "Exciter",
      group: "Exciter",
      unit: "none",
      min: 0,
      max: 2,
      default: 0,
      curve: "stepped",
      steps: 3,
      mutability: 0.5,
      explain: "What sets the object moving: a mallet strike, a burst of noise like a scrape, or a continuous bow that keeps feeding it energy for as long as you hold the note."
    },
    {
      id: "grit",
      name: "Grit",
      group: "Exciter",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.4,
      curve: "linear",
      macro: 2,
      macroDepth: 0.6,
      mutability: 0.9,
      explain: "How rough and noisy the contact is. Turn it up for scratchy, dirty, hand-made attacks; turn it down for a clean, polished, almost synthetic hit."
    },
    {
      id: "hardness",
      name: "Hardness",
      group: "Exciter",
      unit: "ms",
      min: 0.2,
      max: 80,
      default: 3,
      curve: "exp",
      mutability: 0.8,
      explain: "How long the exciter stays in contact with the object. A very short contact is a hard stick and sounds bright and clicky; a long one is a soft felt beater and only wakes the low partials."
    },
    {
      id: "exciter-tone",
      name: "Exciter Tone",
      group: "Exciter",
      unit: "hz",
      min: 200,
      max: 16e3,
      default: 4500,
      curve: "exp",
      mutability: 0.8,
      explain: "Filters the exciter before it reaches the object, deciding which partials it is able to wake up. Lower it for a soft muted knock, raise it for a sharp bright crack."
    },
    {
      id: "release",
      name: "Release",
      group: "Exciter",
      unit: "ms",
      min: 5,
      max: 2e3,
      default: 120,
      curve: "exp",
      mutability: 0.6,
      explain: "How quickly the bow lifts off when you let go of the note. It only matters for the bowed exciter, where you are feeding the object continuously and have to stop."
    },
    {
      id: "level",
      name: "Level",
      group: "Output",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.75,
      curve: "linear",
      mutability: 0.4,
      explain: "Output volume of the voice, with gentle saturation as it is pushed. Useful for balancing this engine against the others rather than for shaping the sound."
    }
  ]
};

// src/dsp/physical-voice.ts
var P_MATERIAL = 0;
var P_STRUCTURE = 1;
var P_DECAY2 = 2;
var P_DAMPING = 3;
var P_POSITION = 4;
var P_AIR = 5;
var P_EXCITER = 6;
var P_GRIT = 7;
var P_HARDNESS = 8;
var P_TONE = 9;
var P_RELEASE2 = 10;
var P_LEVEL = 11;
var EX_MALLET = 0;
var EX_NOISE = 1;
var EX_BOW = 2;
var MAX_MODES = 20;
var MATERIALS = 4;
var DENORMAL4 = 1e-20;
var R_MAX = 0.99997;
var LN1000 = 6.907755278982137;
var TWO_PI3 = 6.283185307179586;
var RATIOS = new Float32Array([
  // membrane: circular drum head, stretched and strongly inharmonic
  1,
  1.593,
  2.135,
  2.295,
  2.653,
  2.917,
  3.155,
  3.5,
  3.598,
  3.652,
  3.965,
  4.06,
  4.23,
  4.372,
  4.601,
  4.831,
  4.903,
  5.084,
  5.242,
  5.412,
  // wood: bar-like, wide spacing, upper partials die almost immediately
  1,
  2.9,
  5.8,
  8.9,
  12.4,
  15.9,
  19.8,
  23.6,
  27.9,
  32.1,
  36.7,
  41.3,
  46.3,
  51.3,
  56.6,
  62,
  67.6,
  73.4,
  79.3,
  85.4,
  // metal: struck bell, the classic inharmonic set
  1,
  2,
  2.4,
  3,
  3.61,
  4.17,
  5.43,
  6.8,
  8.21,
  9.75,
  11.4,
  13.2,
  15.1,
  17.2,
  19.4,
  21.7,
  24.2,
  26.8,
  29.5,
  32.4,
  // glass: near-harmonic and slightly stretched, bright and long
  1,
  2.01,
  3.03,
  4.06,
  5.11,
  6.17,
  7.25,
  8.35,
  9.47,
  10.6,
  11.8,
  13,
  14.2,
  15.5,
  16.8,
  18.1,
  19.5,
  20.9,
  22.3,
  23.8
]);
var AMP_TILT = new Float32Array([0.8, 1.15, 0.55, 0.45]);
var DECAY_TILT = new Float32Array([1.2, 1.7, 0.55, 0.35]);
var DECAY_SCALE = new Float32Array([0.55, 0.28, 1.25, 1.5]);
function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x === x ? x : lo;
}
var PhysicalVoice = class {
  a1 = new Float32Array(MAX_MODES);
  a2 = new Float32Array(MAX_MODES);
  b0 = new Float32Array(MAX_MODES);
  y1 = new Float32Array(MAX_MODES);
  y2 = new Float32Array(MAX_MODES);
  params = new Float32Array(PHYSICAL_DESCRIPTOR.params.length);
  excEnv;
  excFilter;
  driveSmooth;
  sr;
  activeModes = 0;
  bowScale = 1;
  baseFreq = 220;
  velocity = 1;
  active = false;
  dirty = true;
  needsSnap = true;
  quietBlocks = 0;
  rng = 22222;
  constructor(sampleRate2) {
    this.sr = sampleRate2;
    this.excEnv = new Envelope(sampleRate2);
    this.excFilter = new LadderFilter(sampleRate2);
    this.driveSmooth = new Smoother(sampleRate2, 12);
    for (let i = 0; i < this.params.length; i++) {
      this.params[i] = PHYSICAL_DESCRIPTOR.params[i]?.default ?? 0;
    }
    this.applyExciter();
  }
  setParam(index, value) {
    if (index < 0 || index >= this.params.length) return;
    this.params[index] = value;
    this.dirty = true;
    if (index === P_EXCITER || index === P_HARDNESS || index === P_RELEASE2) {
      this.applyExciter();
    }
  }
  applyExciter() {
    const type = Math.round(clamp(this.params[P_EXCITER], 0, 2));
    const hard = clamp(this.params[P_HARDNESS], 0.2, 80);
    const rel = clamp(this.params[P_RELEASE2], 5, 2e3);
    if (type === EX_BOW) {
      this.excEnv.set(8 + hard * 3, 60, 1, rel);
    } else if (type === EX_NOISE) {
      this.excEnv.set(0.5 + hard * 0.4, hard * 2.5, 0, hard);
    } else {
      this.excEnv.set(0.2 + hard * 0.3, hard, 0, hard);
    }
  }
  /** Recomputes the whole modal bank. Never runs inside the sample loop. */
  updateModes() {
    this.dirty = false;
    const morph = clamp(this.params[P_MATERIAL], 0, 1) * (MATERIALS - 1);
    let i0 = Math.floor(morph);
    if (i0 > MATERIALS - 2) i0 = MATERIALS - 2;
    if (i0 < 0) i0 = 0;
    const f = morph - i0;
    const o0 = i0 * MAX_MODES;
    const o1 = o0 + MAX_MODES;
    const ampTilt = AMP_TILT[i0] + (AMP_TILT[i0 + 1] - AMP_TILT[i0]) * f;
    const decTilt = DECAY_TILT[i0] + (DECAY_TILT[i0 + 1] - DECAY_TILT[i0]) * f;
    const decScale = DECAY_SCALE[i0] + (DECAY_SCALE[i0 + 1] - DECAY_SCALE[i0]) * f;
    const stretch = clamp(this.params[P_STRUCTURE], 0, 1);
    const damping = clamp(this.params[P_DAMPING], 0, 1);
    const air = clamp(this.params[P_AIR], 0, 1);
    const pos = clamp(this.params[P_POSITION], 0.02, 0.98);
    const t60 = clamp(this.params[P_DECAY2], 20, 3e3) / 1e3 * (1 - 0.55 * damping);
    const decayExp = decTilt + damping * 1.6;
    const ampExp = (air - 0.5) * 1.4;
    const nyquist = this.sr * 0.47;
    const wScale = TWO_PI3 / this.sr;
    let want = 3 + Math.round(air * (MAX_MODES - 3));
    if (want > MAX_MODES) want = MAX_MODES;
    let count = 0;
    let gainSum = 0;
    let noisePower = 0;
    for (let k = 0; k < want; k++) {
      const base = RATIOS[o0 + k] + (RATIOS[o1 + k] - RATIOS[o0 + k]) * f;
      const ratio = base * (1 + stretch * 0.05 * (base - 1));
      const freq = this.baseFreq * ratio;
      if (freq >= nyquist || freq < 5) break;
      const w = freq * wScale;
      const t60k = clamp(t60 * decScale * Math.pow(ratio, -decayExp), 2e-3, 8);
      let r = Math.exp(-LN1000 / (t60k * this.sr));
      if (!(r > 0)) r = 0;
      if (r > R_MAX) r = R_MAX;
      const gain = Math.pow(k + 1, -ampTilt) * Math.pow(ratio, ampExp) * (0.12 + 0.88 * Math.abs(Math.sin(Math.PI * pos * ratio)));
      this.a1[k] = 2 * r * Math.cos(w);
      this.a2[k] = -r * r;
      this.b0[k] = gain * Math.sin(w);
      gainSum += gain;
      noisePower += gain * gain / (4 * (1 - r));
      count = k + 1;
    }
    const norm = 1.2 * Math.sqrt((count + 1) / 8) / (1e-3 + gainSum);
    for (let k = 0; k < count; k++) this.b0[k] = this.b0[k] * norm;
    for (let k = count; k < MAX_MODES; k++) {
      this.b0[k] = 0;
      this.y1[k] = 0;
      this.y2[k] = 0;
    }
    this.activeModes = count;
    this.bowScale = 1.8 / (0.05 + norm * Math.sqrt(noisePower));
  }
  resetModes() {
    for (let k = 0; k < MAX_MODES; k++) {
      this.y1[k] = 0;
      this.y2[k] = 0;
    }
  }
  noteOn(freq, velocity, voiceIndex) {
    this.baseFreq = clamp(freq, 8, this.sr * 0.4);
    this.velocity = clamp(velocity, 0, 1);
    this.active = true;
    this.dirty = true;
    this.needsSnap = true;
    this.quietBlocks = 0;
    this.rng = 22222 + voiceIndex * 7919;
    this.resetModes();
    this.excFilter.reset();
    this.applyExciter();
    this.excEnv.trigger();
  }
  noteOff() {
    this.excEnv.release();
  }
  isFinished() {
    return this.active && this.quietBlocks >= 3;
  }
  render(out, offset, count) {
    if (!this.active) return;
    if (this.dirty) this.updateModes();
    const a1 = this.a1;
    const a2 = this.a2;
    const b0 = this.b0;
    const y1 = this.y1;
    const y2 = this.y2;
    const n = this.activeModes;
    const type = Math.round(clamp(this.params[P_EXCITER], 0, 2));
    const grit = clamp(this.params[P_GRIT], 0, 1);
    const air = clamp(this.params[P_AIR], 0, 1);
    const tone = clamp(this.params[P_TONE], 200, 16e3);
    const dc = type === EX_MALLET ? 1 : type === EX_NOISE ? 0.2 : 0;
    const noiseAmt = type === EX_MALLET ? grit * 0.7 : 1;
    const rootTau = Math.sqrt(clamp(this.params[P_HARDNESS], 0.2, 80) * this.sr / 4e3);
    const drive = type === EX_BOW ? this.bowScale : type === EX_NOISE ? 2.2 / (1 + 0.35 * rootTau) : 1.6 / (1 + 0.9 * rootTau);
    const level = clamp(this.params[P_LEVEL], 0, 1) * this.velocity * 0.34;
    this.excFilter.setCutoff(tone * (0.35 + 1.2 * grit) * (0.55 + air));
    this.excFilter.setResonance(grit * 0.25);
    this.driveSmooth.setTarget(drive);
    if (this.needsSnap) {
      this.driveSmooth.snap(drive);
      this.needsSnap = false;
    }
    let rs = this.rng;
    let peak = 0;
    let excPeak = 0;
    for (let i = 0; i < count; i++) {
      rs ^= rs << 13;
      rs ^= rs >>> 17;
      rs ^= rs << 5;
      const noise = rs * 4656612873077393e-25;
      const e = this.excEnv.next();
      if (e > excPeak) excPeak = e;
      const x = this.excFilter.process((dc + noiseAmt * noise) * e) * this.driveSmooth.next();
      let acc = 0;
      for (let m = 0; m < n; m++) {
        const y = b0[m] * x + a1[m] * y1[m] + a2[m] * y2[m];
        y2[m] = y1[m];
        y1[m] = y;
        acc += y;
      }
      if (acc !== acc) {
        this.resetModes();
        acc = 0;
      }
      const mag = acc < 0 ? -acc : acc;
      if (mag > peak) peak = mag;
      const v = Math.tanh(acc * level) * 0.9;
      out[offset + i] = out[offset + i] + v;
    }
    for (let m = 0; m < n; m++) {
      if (y1[m] < DENORMAL4 && y1[m] > -DENORMAL4) y1[m] = 0;
      if (y2[m] < DENORMAL4 && y2[m] > -DENORMAL4) y2[m] = 0;
    }
    this.rng = rs;
    if (peak < 1e-4 && excPeak < 1e-4) this.quietBlocks++;
    else this.quietBlocks = 0;
  }
};
var PhysicalEngine = {
  descriptor: PHYSICAL_DESCRIPTOR,
  allocVoice: (sampleRate2) => new PhysicalVoice(sampleRate2)
};

// src/dsp/granular-descriptor.ts
var GRANULAR_DESCRIPTOR = {
  id: "granular",
  name: "Granular",
  colour: "#8B5CF6",
  macroNames: ["Body", "Air", "Grit", "Motion"],
  params: [
    {
      id: "grain-density",
      name: "Density",
      group: "Cloud",
      unit: "hz",
      min: 0.5,
      max: 200,
      default: 32,
      curve: "exp",
      macro: 3,
      macroDepth: 0.7,
      mutability: 0.9,
      explain: "How many grains are thrown per second. Low counts sound like scattered droplets you can hear individually; high counts fuse into one continuous, thick texture."
    },
    {
      id: "grain-size",
      name: "Grain Size",
      group: "Cloud",
      unit: "ms",
      min: 5,
      max: 400,
      default: 90,
      curve: "exp",
      macro: 0,
      macroDepth: 0.6,
      mutability: 0.8,
      explain: "How long each slice of sound lasts. Tiny grains lose their pitch and turn into buzzing texture; long grains keep the character of the source and sound smooth and vocal."
    },
    {
      id: "position",
      name: "Position",
      group: "Source",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.12,
      curve: "linear",
      macro: 1,
      macroDepth: 0.8,
      mutability: 0.9,
      explain: "Where in the source material the grains are read from. Moving it walks you through different timbres, from dark and thick at one end to bright and airy at the other."
    },
    {
      id: "spray",
      name: "Spray",
      group: "Source",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.12,
      curve: "linear",
      macro: 2,
      macroDepth: 0.7,
      mutability: 0.9,
      explain: "Scatters each grain randomly around the read position instead of taking them all from the same spot. A little stops the cloud sounding like a stuck loop; a lot smears everything into noise."
    },
    {
      id: "pitch-scatter",
      name: "Pitch Scatter",
      group: "Source",
      unit: "semitones",
      min: 0,
      max: 12,
      default: 0.25,
      curve: "linear",
      mutability: 0.8,
      explain: "Detunes every grain by a random amount. Small values thicken the note like a chorus; large values spray it into a shimmering, atonal cloud that no longer has one clear pitch."
    },
    {
      id: "reverse",
      name: "Reverse",
      group: "Source",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.1,
      curve: "linear",
      mutability: 0.7,
      explain: "The chance that any given grain plays backwards. Mixed in small amounts it removes the forward push of the sound and makes the texture feel suspended rather than moving."
    },
    {
      id: "window-shape",
      name: "Window",
      group: "Cloud",
      unit: "pct",
      min: 0,
      max: 1,
      default: 1,
      curve: "linear",
      mutability: 0.6,
      explain: "How gently each grain fades in and out. Fully up is a soft bell shape that sounds smooth; turned down the grains hold flat for longer, which sounds punchier and more percussive."
    },
    {
      id: "amp-attack",
      name: "Attack",
      group: "Envelope",
      unit: "ms",
      min: 0.5,
      max: 4e3,
      default: 25,
      curve: "exp",
      mutability: 0.6,
      explain: "How long the whole cloud takes to reach full volume. Long attacks let the grains gather gradually, which is what turns this engine into a slow-blooming pad."
    },
    {
      id: "amp-decay",
      name: "Decay",
      group: "Envelope",
      unit: "ms",
      min: 1,
      max: 8e3,
      default: 700,
      curve: "exp",
      mutability: 0.6,
      explain: "How quickly the cloud settles from its loudest point down to the level it holds at while the key is down."
    },
    {
      id: "amp-sustain",
      name: "Sustain",
      group: "Envelope",
      unit: "pct",
      min: 0,
      max: 1,
      default: 0.75,
      curve: "linear",
      mutability: 0.5,
      explain: "The level the cloud holds while you keep the key down. Drop it to zero and each note becomes a single burst of grains rather than a sustained texture."
    },
    {
      id: "amp-release",
      name: "Release",
      group: "Envelope",
      unit: "ms",
      min: 1,
      max: 8e3,
      default: 900,
      curve: "exp",
      mutability: 0.6,
      explain: "How long the cloud takes to disperse after you let go. Long releases let overlapping notes blur into a continuous wash, which is most of the appeal of granular sound."
    }
  ]
};

// src/dsp/granular-voice.ts
var P_DENSITY = 0;
var P_SIZE = 1;
var P_POSITION2 = 2;
var P_SPRAY = 3;
var P_PITCH_SCATTER = 4;
var P_REVERSE = 5;
var P_WINDOW = 6;
var P_ATTACK2 = 7;
var P_DECAY3 = 8;
var P_SUSTAIN2 = 9;
var P_RELEASE3 = 10;
var MAX_GRAINS = 32;
var DENORMAL5 = 1e-20;
var TWO_PI4 = 6.283185307179586;
var SOURCE_SR = 48e3;
var SOURCE_SECONDS = 3;
var SOURCE_ROOT_HZ = 110;
var RISE_STEPS = 1024;
var RISE = new Float32Array(RISE_STEPS + 1);
for (let i = 0; i <= RISE_STEPS; i++) {
  RISE[i] = 0.5 - 0.5 * Math.cos(Math.PI * i / RISE_STEPS);
}
function rise(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const f = x * RISE_STEPS;
  const i = f | 0;
  const a = RISE[i];
  const b = RISE[i + 1];
  return a + (b - a) * (f - i);
}
function grainWindow(phase, taper) {
  if (phase <= 0 || phase >= 1) return 0;
  if (phase < taper) return rise(phase / taper);
  if (phase > 1 - taper) return rise((1 - phase) / taper);
  return 1;
}
function saturate3(x) {
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}
var sourceBuffer = null;
function getSource() {
  if (sourceBuffer) return sourceBuffer;
  const len = SOURCE_SR * SOURCE_SECONDS;
  const buf = new Float32Array(len);
  const s1 = new SawOscillator(SOURCE_SR), s2 = new SawOscillator(SOURCE_SR);
  const s3 = new SawOscillator(SOURCE_SR), noiseFilter = new LadderFilter(SOURCE_SR);
  noiseFilter.setResonance(0.3);
  let rng = 2654435769;
  let peak = 1e-9;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const wob = Math.sin(t * TWO_PI4 * 3) * 4e-3;
    s1.setFrequency(SOURCE_ROOT_HZ);
    s2.setFrequency(SOURCE_ROOT_HZ * (1.006 + wob));
    s3.setFrequency(SOURCE_ROOT_HZ * 2 * (0.994 - wob));
    rng ^= rng << 13;
    rng >>>= 0;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    rng >>>= 0;
    const noise = rng / 4294967296 * 2 - 1;
    noiseFilter.setCutoff(300 * Math.pow(2, 4.5 * (0.5 - 0.5 * Math.cos(t * TWO_PI4 * 2))));
    const air = 0.2 + 0.28 * (0.5 - 0.5 * Math.cos(t * TWO_PI4 * 5));
    const v = (s1.next() + s2.next() + s3.next() * 0.6) * 0.32 + noiseFilter.process(noise) * air * 1.1;
    buf[i] = v;
    if (v > peak) peak = v;
    else if (-v > peak) peak = -v;
  }
  const norm = 0.9 / peak;
  for (let i = 0; i < len; i++) buf[i] = buf[i] * norm;
  sourceBuffer = buf;
  return buf;
}
var GranularVoice = class {
  params = new Float32Array(GRANULAR_DESCRIPTOR.params.length);
  ampEnv;
  posSmooth;
  densitySmooth;
  gActive = new Uint8Array(MAX_GRAINS);
  gPos = new Float64Array(MAX_GRAINS);
  // read head, samples
  gInc = new Float64Array(MAX_GRAINS);
  // rate, negative = reverse
  gAge = new Float64Array(MAX_GRAINS);
  gLen = new Float64Array(MAX_GRAINS);
  gTaper = new Float32Array(MAX_GRAINS);
  gGainL = new Float32Array(MAX_GRAINS);
  gGainR = new Float32Array(MAX_GRAINS);
  src;
  srcLen;
  sr;
  invSr;
  srcRateRatio;
  rng = 1;
  spawnAccum = 0;
  pitchRatio = 1;
  velocity = 1;
  active = false;
  dcX1 = 0;
  dcY1 = 0;
  constructor(sampleRate2) {
    this.sr = sampleRate2;
    this.invSr = 1 / sampleRate2;
    this.src = getSource();
    this.srcLen = this.src.length;
    this.srcRateRatio = SOURCE_SR / sampleRate2;
    this.ampEnv = new Envelope(sampleRate2);
    this.posSmooth = new Smoother(sampleRate2, 25);
    this.densitySmooth = new Smoother(sampleRate2, 40);
    for (let i = 0; i < this.params.length; i++) {
      this.params[i] = GRANULAR_DESCRIPTOR.params[i]?.default ?? 0;
    }
    this.posSmooth.snap(this.params[P_POSITION2]);
    this.densitySmooth.snap(this.params[P_DENSITY]);
  }
  /** xorshift32. Seeded per voice so a rendered patch is reproducible. */
  rand() {
    let x = this.rng;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.rng = x;
    return x / 4294967296;
  }
  setParam(index, value) {
    if (index < 0 || index >= this.params.length) return;
    this.params[index] = value;
    if (index === P_ATTACK2 || index === P_DECAY3 || index === P_SUSTAIN2 || index === P_RELEASE3) {
      this.applyEnvelope();
    }
  }
  applyEnvelope() {
    this.ampEnv.set(
      this.params[P_ATTACK2],
      this.params[P_DECAY3],
      this.params[P_SUSTAIN2],
      this.params[P_RELEASE3]
    );
  }
  noteOn(freq, velocity, voiceIndex) {
    this.velocity = velocity;
    this.active = true;
    this.pitchRatio = freq / SOURCE_ROOT_HZ;
    this.rng = (voiceIndex * 2654435761 ^ 1542469173) >>> 0 || 1;
    this.spawnAccum = 1;
    this.dcX1 = 0;
    this.dcY1 = 0;
    this.gActive.fill(0);
    this.applyEnvelope();
    this.ampEnv.trigger();
    this.posSmooth.snap(this.params[P_POSITION2]);
    this.densitySmooth.snap(this.params[P_DENSITY]);
  }
  noteOff() {
    this.ampEnv.release();
  }
  isFinished() {
    return this.active && this.ampEnv.isFinished();
  }
  spawn(posNorm, sizeSamples) {
    let slot = -1;
    for (let g = 0; g < MAX_GRAINS; g++) {
      if (this.gActive[g] === 0) {
        slot = g;
        break;
      }
    }
    if (slot < 0) return;
    const len = this.srcLen;
    const spray = clamp2(this.params[P_SPRAY], 0, 1);
    let start = (clamp2(posNorm, 0, 1) + (this.rand() * 2 - 1) * spray) * len;
    start %= len;
    if (start < 0) start += len;
    const scatter = clamp2(this.params[P_PITCH_SCATTER], 0, 12);
    const cents = (this.rand() * 2 - 1) * scatter;
    let inc = this.pitchRatio * this.srcRateRatio * Math.pow(2, cents / 12);
    if (inc > 16) inc = 16;
    if (this.rand() < clamp2(this.params[P_REVERSE], 0, 1)) inc = -inc;
    let dur = sizeSamples * (1 + (this.rand() * 2 - 1) * 0.15 * spray);
    if (dur < 8) dur = 8;
    const pan = this.rand();
    const shape = clamp2(this.params[P_WINDOW], 0, 1);
    this.gActive[slot] = 1;
    this.gPos[slot] = start;
    this.gInc[slot] = inc;
    this.gAge[slot] = 0;
    this.gLen[slot] = dur;
    this.gTaper[slot] = 0.05 + 0.45 * shape;
    this.gGainL[slot] = Math.cos(pan * Math.PI * 0.5) * 0.45;
    this.gGainR[slot] = Math.sin(pan * Math.PI * 0.5) * 0.45;
  }
  render(out, offset, count) {
    if (!this.active) return;
    const src = this.src;
    const len = this.srcLen;
    const sizeSamples = clamp2(this.params[P_SIZE], 1, 4e3) * 1e-3 * this.sr;
    this.posSmooth.setTarget(clamp2(this.params[P_POSITION2], 0, 1));
    this.densitySmooth.setTarget(clamp2(this.params[P_DENSITY], 0, 400));
    for (let i = 0; i < count; i++) {
      const pos = this.posSmooth.next();
      this.spawnAccum += this.densitySmooth.next() * this.invSr;
      if (this.spawnAccum >= 1) {
        this.spawnAccum -= 1;
        if (this.spawnAccum > 1) this.spawnAccum = 1;
        this.spawn(pos, sizeSamples);
      }
      let sumL = 0;
      let sumR = 0;
      for (let g = 0; g < MAX_GRAINS; g++) {
        if (this.gActive[g] === 0) continue;
        const age = this.gAge[g];
        const glen = this.gLen[g];
        if (age >= glen) {
          this.gActive[g] = 0;
          continue;
        }
        let p = this.gPos[g];
        const i0 = p | 0;
        let i1 = i0 + 1;
        if (i1 >= len) i1 = 0;
        const a = src[i0];
        const b = src[i1];
        const s = (a + (b - a) * (p - i0)) * grainWindow(age / glen, this.gTaper[g]);
        sumL += s * this.gGainL[g];
        sumR += s * this.gGainR[g];
        p += this.gInc[g];
        if (p >= len) p -= len;
        else if (p < 0) p += len;
        this.gPos[g] = p;
        this.gAge[g] = age + 1;
      }
      const mono = (sumL + sumR) * 0.7071067811865476;
      let hp = mono - this.dcX1 + 0.995 * this.dcY1;
      if (hp < DENORMAL5 && hp > -DENORMAL5) hp = 0;
      this.dcX1 = mono < DENORMAL5 && mono > -DENORMAL5 ? 0 : mono;
      this.dcY1 = hp;
      const y = saturate3(hp * 0.7) * this.ampEnv.next() * this.velocity * 0.9;
      out[offset + i] = out[offset + i] + (y === y ? y : 0);
    }
  }
};
function clamp2(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
var GranularEngine = {
  descriptor: GRANULAR_DESCRIPTOR,
  allocVoice: (sampleRate2) => new GranularVoice(sampleRate2)
};

// src/dsp/registry.ts
var ENGINES = [
  AnalogEngine,
  FmEngine,
  PhysicalEngine,
  GranularEngine
];
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
    if (opts && opts["mode"] === "bounce") {
      const engineId = opts["engineId"];
      if (typeof engineId === "string") {
        const vm = this.managers.get(engineId);
        if (vm) this.active = vm;
      }
      const values = opts["patchParams"];
      if (values instanceof Float32Array) {
        for (let i = 0; i < values.length; i++) {
          this.active.setParam(i, values[i]);
        }
      }
      const releaseFrame = opts["releaseFrame"];
      if (typeof releaseFrame === "number") this.releaseAtSample = releaseFrame;
      const velocityOpt = opts["velocity"];
      const velocity = typeof velocityOpt === "number" ? velocityOpt : 1;
      const notes = opts["midiNotes"];
      if (Array.isArray(notes)) {
        for (const n of notes) {
          if (typeof n === "number") {
            this.active.noteOn(n, velocity);
            this.bounceNotes.push(n);
          }
        }
      }
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
  bounceNotes = [];
  samplesRendered = 0;
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output) return true;
    const left = output[0];
    if (!left) return true;
    left.fill(0);
    this.active.render(left, left.length);
    if (this.releaseAtSample >= 0 && this.bounceNotes.length > 0) {
      this.samplesRendered += left.length;
      if (this.samplesRendered >= this.releaseAtSample) {
        for (const n of this.bounceNotes) this.active.noteOff(n);
        this.bounceNotes.length = 0;
      }
    }
    for (let ch = 1; ch < output.length; ch++) {
      output[ch]?.set(left);
    }
    return true;
  }
};
registerProcessor("sigil-processor", SigilProcessor);
