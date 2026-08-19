// Port of src/dsp/analog-voice.ts
//
// Virtual analog: two polyBLEP oscillators with unison copies, a sub, noise,
// one of three filter models, two envelopes and an LFO.
//
// Porting notes beyond the general rules in dsp/util.h:
//
//  * `params` is a Float32Array in the TS. Every parameter read is therefore a
//    float32 value widened to double, and `setParam` narrows on store. This is
//    not cosmetic: `lfo-rate` 15.01 and `amp-attack` 2000.25 are stored rounded,
//    and the rounded value is what the coefficients are built from.
//    ONE exception is reproduced exactly: setParam's `env-curve` branch uses the
//    unrounded argument, because the TS closes over `value`, not `params[i]`.
//    noteOn then recomputes envK from the rounded field, which is what actually
//    reaches render().
//  * Phase/increment state is Float64Array in the TS, so it is double here. The
//    only f32 narrowing in the whole voice is the final `out[...] = ... + y`.
//  * `activeFilter` is an interface reference in the TS. Here it is an index and
//    a switch: same arithmetic, and it keeps this header from depending on how
//    the filters port chooses to spell its polymorphism.
//  * The noise generator is JS int32 xorshift, done in uint32 (identical bits,
//    defined behaviour).
//  * `subTri` is deliberately NOT cleared in noteOn - the TS does not clear it.
//  * The NaN/inf guard `if (!(y > -4 && y < 4))` is load-bearing: it catches NaN
//    through the failed comparison, not through an isnan() test.
#pragma once

#include <cmath>
#include <cstdint>

#include "dsp/envelope.h"
#include "dsp/filters.h"
#include "dsp/ladder.h"
#include "dsp/lfo.h"
#include "dsp/smoothing.h"
#include "dsp/util.h"

namespace sigil {

namespace analog_detail {

constexpr int P_DETUNE = 0, P_DRIFT = 1, P_CUTOFF = 2, P_RES = 3, P_FILTER_ENV = 4;
constexpr int P_ATTACK = 5, P_DECAY = 6, P_SUSTAIN = 7, P_RELEASE = 8, P_DRIVE = 9;
constexpr int P_WAVE1 = 10, P_WAVE2 = 11, P_PW = 12, P_MIX = 13;
constexpr int P_SUB_MODE = 14, P_SUB_LEVEL = 15, P_NOISE = 16;
constexpr int P_UNISON = 17, P_SPREAD = 18, P_GLIDE = 19;
constexpr int P_KEYTRACK = 20, P_MODEL = 21, P_VEL_CUT = 22, P_VEL_AMP = 23, P_CURVE = 24;
constexpr int P_LFO_RATE = 25, P_LFO_SHAPE = 26, P_LFO_DELAY = 27, P_LFO_SYNC = 28;
constexpr int P_LFO_PITCH = 29, P_LFO_CUT = 30, P_LFO_PW = 31, P_LFO_AMP = 32;

constexpr double LN2 = 0.6931471805599453;
constexpr double TWO_PI = 6.283185307179586;
/** One cent as a fractional frequency change; exact enough under 100 cents. */
constexpr double CENT = 5.7762265e-4;
/** log2(261.6256) - middle C, the note key tracking pivots around. */
constexpr double LOG2_REF = 8.0312500;
/** Modulation runs once per this many samples (6 kHz at 48 k). */
constexpr int CONTROL_STEP = 8;
constexpr int MAX_UNISON = 4;
constexpr double OSC_GAIN = 0.8;
/** Level-matched across engines, measured rather than chosen. */
constexpr double VOICE_GAIN = 0.55;

/** Cheap rational tanh - monotonic, bounded, shaped for hot loops. */
inline double saturate(double x) {
  const double x2 = x * x;
  return (x * (27.0 + x2)) / (27.0 + 9.0 * x2);
}

/** Bends a 0..1 envelope without moving its endpoints. */
inline double bend(double v, double k) {
  return (v * (1.0 + k)) / (1.0 + k * v);
}

}  // namespace analog_detail

/** ANALOG_DESCRIPTOR.params, in wire order. Index IS the parameter address. */
constexpr int kAnalogParamCount = 33;

inline constexpr const char* kAnalogParamIds[kAnalogParamCount] = {
  "osc-detune", "osc-drift", "filter-cutoff", "filter-resonance", "filter-env",
  "amp-attack", "amp-decay", "amp-sustain", "amp-release", "drive",
  "osc1-wave", "osc2-wave", "osc-pulse-width", "osc-mix",
  "sub-mode", "sub-level", "noise-level",
  "unison-voices", "unison-detune", "glide",
  "filter-keytrack", "filter-model", "filter-velocity", "amp-velocity", "env-curve",
  "lfo-rate", "lfo-shape", "lfo-delay", "lfo-sync",
  "lfo-pitch", "lfo-cutoff", "lfo-pulse-width", "lfo-amp",
};

inline constexpr double kAnalogParamDefaults[kAnalogParamCount] = {
  0.06, 0.25, 1800.0, 0.15, 0.5,
  4.0, 400.0, 0.7, 300.0, 0.2,
  0.0, 0.0, 0.5, 0.5,
  0.0, 0.15, 0.0,
  1.0, 0.35, 0.0,
  0.35, 0.0, 0.35, 0.6, 0.5,
  4.5, 0.0, 250.0, 1.0,
  0.0, 0.0, 0.3, 0.0,
};

class AnalogVoice {
public:
  explicit AnalogVoice(double sampleRate)
      : invSr_(1.0 / sampleRate),
        ctrlRate_(sampleRate / analog_detail::CONTROL_STEP),
        maxFreq_(sampleRate * 0.45),
        ladder_(sampleRate),
        svf_(sampleRate),
        diode_(sampleRate),
        ampEnv_(sampleRate),
        filterEnv_(sampleRate / analog_detail::CONTROL_STEP),
        // Smoother and LFO tick at control rate, so they are told that rate.
        cutoffSmooth_(sampleRate / analog_detail::CONTROL_STEP, 8.0),
        lfo_(sampleRate / analog_detail::CONTROL_STEP) {
    using namespace analog_detail;
    activeModel_ = 0;  // this.activeFilter = this.ladder
    for (int i = 0; i < kAnalogParamCount; i++) {
      params_[i] = static_cast<float>(kAnalogParamDefaults[i]);
    }
    spread_[4] = -1.0; spread_[5] = 1.0;
    spread_[8] = -1.0; spread_[10] = 1.0;
    spread_[12] = -1.0; spread_[13] = -0.34;
    spread_[14] = 0.34; spread_[15] = 1.0;
    applyEnvelopes();
    applyLfo();
    cutoffSmooth_.snap(p(P_CUTOFF));
  }

  void setParam(int index, double value) {
    using namespace analog_detail;
    if (index < 0 || index >= kAnalogParamCount) return;
    params_[index] = static_cast<float>(value);
    if (index >= P_ATTACK && index <= P_RELEASE) applyEnvelopes();
    // The TS closes over the unrounded `value` here, not over params[index].
    else if (index == P_CURVE) envK_ = (value - 0.5) * 1.6;
    else if (index >= P_LFO_RATE && index <= P_LFO_DELAY) applyLfo();
  }

  void noteOn(double freq, double velocity, double voiceIndex) {
    using namespace analog_detail;
    const double f = freq > 8.0 ? (freq < 12000.0 ? freq : 12000.0) : 8.0;
    const double target = std::log2(f);
    const double glideMs = p(P_GLIDE);
    // A voice that has never sounded has nothing to glide from.
    if (!active_ || !(glideMs > 0.0)) logFreq_ = target;
    logTarget_ = target;
    const double steps = std::fmax(1.0, (glideMs / 1000.0) * ctrlRate_);
    glideCoeff_ = glideMs > 0.0 ? 1.0 - std::exp(-4.0 / steps) : 1.0;

    velocity_ = velocity > 0.0 ? (velocity < 1.0 ? velocity : 1.0) : 0.0;
    envK_ = (p(P_CURVE) - 0.5) * 1.6;
    const double n = jsRound(p(P_UNISON));
    uni_ = n < 1.0 ? 1 : (n > MAX_UNISON ? MAX_UNISON : static_cast<int>(n));
    uniGain_ = 1.0 / std::sqrt(static_cast<double>(uni_));

    for (int u = 0; u < MAX_UNISON; u++) {
      // Staggered starts: copies that begin in phase sound like one loud
      // oscillator until they happen to drift apart.
      ph1_[u] = std::fmod(std::fmod(voiceIndex * 0.137 + u * 0.618, 1.0) + 1.0, 1.0);
      ph2_[u] = std::fmod(std::fmod(voiceIndex * 0.311 + u * 0.382, 1.0) + 1.0, 1.0);
      tri1_[u] = 0.0; tri2_[u] = 0.0;
      driftPhase_[u] = std::fmod(std::fmod(voiceIndex * 0.37 + u * 0.211, 1.0) + 1.0, 1.0);
      driftInc_[u] = (0.11 + u * 0.041 + std::fmod(voiceIndex, 4.0) * 0.017)
                     * invSr_ * CONTROL_STEP;
    }
    subPh_[0] = 0.0;
    const std::int32_t seed = toInt32((voiceIndex + 1.0) * 1831565813.0);
    noiseState_ = static_cast<std::uint32_t>(
        seed == 0 ? static_cast<std::int32_t>(0x9e3779b9) : seed);

    ladder_.reset(); svf_.reset(); diode_.reset();
    applyEnvelopes();
    applyLfo();
    lfo_.seed(voiceIndex);
    lfo_.trigger(p(P_LFO_SYNC) >= 0.5);
    ampEnv_.trigger(); filterEnv_.trigger();
    cutoffSmooth_.snap(p(P_CUTOFF));
    ctrl_ = 0;
    active_ = true;
  }

  void noteOff() {
    ampEnv_.release();
    filterEnv_.release();
  }

  /** True once a note has been triggered and its amp envelope has run out. */
  bool isFinished() const { return active_ && ampEnv_.isFinished(); }

  void render(float* out, int offset, int count) {
    using namespace analog_detail;
    if (!active_) return;
    const int model = static_cast<int>(jsRound(p(P_MODEL)));
    const int filter = model == 1 ? 1 : (model == 2 ? 2 : 0);
    activeModel_ = filter;
    filterSetResonance(filter, p(P_RES));

    const double drive = 1.0 + p(P_DRIVE) * 6.0, driveComp = 1.0 / std::sqrt(drive);
    const double w1 = jsRound(p(P_WAVE1)), w2 = jsRound(p(P_WAVE2));
    const double raw = p(P_MIX);
    const double bal = raw < 0.0 ? 0.0 : (raw > 1.0 ? 1.0 : raw);
    const double g1 = (1.0 - bal) * OSC_GAIN * uniGain_, g2 = bal * OSC_GAIN * uniGain_;
    const int subMode = static_cast<int>(jsRound(p(P_SUB_MODE)));
    const double subShape = subMode >= 2 ? WAVE_SINE : WAVE_PULSE;
    const double subLevel = p(P_SUB_LEVEL) * 0.9;
    const double noiseLevel = p(P_NOISE) * 0.5, velAmp = p(P_VEL_AMP);
    const double gain = (1.0 - velAmp + velAmp * velocity_ * velocity_) * VOICE_GAIN;
    const int n = uni_;
    const double k = envK_;
    detuneMul_ = std::exp((LN2 * p(P_DETUNE)) / 12.0);
    subRatio_ = (subMode & 1) == 1 ? 0.25 : 0.5;
    cutoffSmooth_.setTarget(p(P_CUTOFF));

    double* mix = mix_;
    std::uint32_t noise = noiseState_;
    int i = 0;
    while (i < count) {
      if (ctrl_ == 0) { updateControl(); ctrl_ = CONTROL_STEP; }
      const int m = ctrl_ < count - i ? ctrl_ : count - i;
      const double pw = pw_;
      for (int j = 0; j < m; j++) mix[j] = 0.0;
      for (int u = 0; u < n; u++) {
        addOsc(w1, mix, m, ph1_, tri1_, u, inc1_[u], pw, g1);
        addOsc(w2, mix, m, ph2_, tri2_, u, inc2_[u], pw, g2);
      }
      if (subLevel > 0.0) {
        addOsc(subShape, mix, m, subPh_, subTri_, 0, subInc_, 0.5, subLevel);
      }
      const double amp = gain * ampMod_;

      for (int j = 0; j < m; j++) {
        double sig = mix[j];
        if (noiseLevel > 0.0) {
          noise ^= noise << 13;
          noise ^= noise >> 17;
          noise ^= noise << 5;
          sig += (static_cast<double>(noise) / 2147483648.0 - 1.0) * noiseLevel;
        }
        sig = saturate(sig * drive) * driveComp;
        const double e = ampEnv_.next();
        double y = filterProcess(filter, sig) * (k == 0.0 ? e : bend(e, k)) * amp;
        // Catches NaN and infinity alike: a failed comparison falls to zero.
        if (!(y > -4.0 && y < 4.0)) y = y > 0.0 ? 4.0 : (y < 0.0 ? -4.0 : 0.0);
        const int idx = offset + i + j;
        out[idx] = static_cast<float>(static_cast<double>(out[idx]) + y);
      }
      i += m; ctrl_ -= m;
    }
    noiseState_ = noise;
  }

private:
  double p(int i) const { return static_cast<double>(params_[i]); }

  void applyEnvelopes() {
    using namespace analog_detail;
    const double a = p(P_ATTACK), d = p(P_DECAY);
    const double s = p(P_SUSTAIN), r = p(P_RELEASE);
    ampEnv_.set(a, d, s, r);
    // The filter closes a little ahead of the amplitude and sits lower.
    filterEnv_.set(a, d * 0.8, s * 0.5, r);
  }

  void applyLfo() {
    using namespace analog_detail;
    lfo_.setRate(p(P_LFO_RATE));
    lfo_.setShape(p(P_LFO_SHAPE));
    lfo_.setDelayMs(p(P_LFO_DELAY));
  }

  void filterSetResonance(int which, double r) {
    if (which == 1) svf_.setResonance(r);
    else if (which == 2) diode_.setResonance(r);
    else ladder_.setResonance(r);
  }

  void filterSetCutoff(int which, double hz) {
    if (which == 1) svf_.setCutoff(hz);
    else if (which == 2) diode_.setCutoff(hz);
    else ladder_.setCutoff(hz);
  }

  double filterProcess(int which, double x) {
    if (which == 1) return svf_.process(x);
    if (which == 2) return diode_.process(x);
    return ladder_.process(x);
  }

  /** Everything that moves slower than audio, recomputed once per control step. */
  void updateControl() {
    using namespace analog_detail;
    const double lfoV = lfo_.next();
    logFreq_ += glideCoeff_ * (logTarget_ - logFreq_);

    const double vib = p(P_LFO_PITCH) * p(P_LFO_PITCH) * lfoV;
    const double base = std::exp(LN2 * (logFreq_ + vib));
    const double driftAmt = p(P_DRIFT) * 0.012;
    const double spreadAmt = p(P_SPREAD) * 30.0 * CENT;
    const int row = (uni_ - 1) * MAX_UNISON;
    const double max = maxFreq_;
    for (int u = 0; u < uni_; u++) {
      double dp = driftPhase_[u] + driftInc_[u];
      if (dp >= 1.0) dp -= 1.0;
      driftPhase_[u] = dp;
      const double dev = std::sin(dp * TWO_PI) * driftAmt + spread_[row + u] * spreadAmt;
      const double f1 = base * (1.0 + dev);
      const double f2 = base * detuneMul_ * (1.0 - dev);
      inc1_[u] = (f1 > max ? max : (f1 < 0.01 ? 0.01 : f1)) * invSr_;
      inc2_[u] = (f2 > max ? max : (f2 < 0.01 ? 0.01 : f2)) * invSr_;
    }
    const double fs = base * subRatio_;
    subInc_ = (fs > max ? max : (fs < 0.01 ? 0.01 : fs)) * invSr_;

    const double fenv = bend(filterEnv_.next(), envK_);
    // Key track, velocity and LFO are all pitch-like: sum them in octaves and
    // pay for exactly one exp().
    const double oct = p(P_KEYTRACK) * (logFreq_ - LOG2_REF)
      + p(P_LFO_CUT) * 3.0 * lfoV
      - p(P_VEL_CUT) * 4.0 * (1.0 - velocity_);
    double cut = cutoffSmooth_.next() * std::exp(LN2 * oct)
      * (1.0 + p(P_FILTER_ENV) * fenv * 6.0);
    if (!(cut > 10.0)) cut = 10.0;
    else if (cut > max) cut = max;
    filterSetCutoff(activeModel_, cut);

    const double w = p(P_PW) + p(P_LFO_PW) * lfoV * 0.45;
    pw_ = w < 0.06 ? 0.06 : (w > 0.94 ? 0.94 : w);
    ampMod_ = 1.0 - p(P_LFO_AMP) * 0.5 * (1.0 - lfoV);
  }

  // --- state, in the order the TS declares it -------------------------------
  double invSr_, ctrlRate_, maxFreq_;

  LadderFilter ladder_;
  StateVariableFilter svf_;
  DiodeFilter diode_;
  int activeModel_ = 0;
  Envelope ampEnv_;
  Envelope filterEnv_;
  Smoother cutoffSmooth_;
  Lfo lfo_;

  float params_[kAnalogParamCount] = {};
  double ph1_[analog_detail::MAX_UNISON] = {};
  double ph2_[analog_detail::MAX_UNISON] = {};
  double tri1_[analog_detail::MAX_UNISON] = {};
  double tri2_[analog_detail::MAX_UNISON] = {};
  double inc1_[analog_detail::MAX_UNISON] = {};
  double inc2_[analog_detail::MAX_UNISON] = {};
  double driftPhase_[analog_detail::MAX_UNISON] = {};
  double driftInc_[analog_detail::MAX_UNISON] = {};
  /** Detune positions per unison count, row-major: (count - 1) * 4 + slot. */
  double spread_[analog_detail::MAX_UNISON * analog_detail::MAX_UNISON] = {};
  /** Oscillator sum for one control step, before filter and amplifier. */
  double mix_[analog_detail::CONTROL_STEP] = {};

  int uni_ = 1;
  double uniGain_ = 1.0;
  double subPh_[1] = {};
  double subTri_[1] = {};
  double subInc_ = 0.0;
  double subRatio_ = 0.5;
  double detuneMul_ = 1.0;
  std::uint32_t noiseState_ = 0x9e3779b9u;
  int ctrl_ = 0;
  double pw_ = 0.5;
  double ampMod_ = 1.0;
  double envK_ = 0.0;
  double logFreq_ = 7.78;
  double logTarget_ = 7.78;
  double glideCoeff_ = 1.0;
  double velocity_ = 1.0;
  bool active_ = false;
};

}  // namespace sigil
