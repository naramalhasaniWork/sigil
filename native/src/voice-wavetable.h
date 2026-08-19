// Port of src/dsp/wavetable-voice.ts
//
// Eight additively-built waveforms in a row, band-limited at ten octave levels.
// Two oscillators read the row with linear interpolation and crossfade between
// neighbouring tables; a ladder filter, three envelopes and two smoothers frame
// the scan.
//
// Porting notes beyond the general rules in dsp/util.h:
//
//  * `params` is a Float32Array in the TS, so every parameter read is a float32
//    widened to double and every write narrows. `amp-attack 2000.25` and
//    `filter-cutoff 9010` are stored rounded, and the rounded value is what the
//    envelope coefficients and the smoother targets are built from.
//  * The bank is a Float32Array built from a Float64Array accumulator. Both
//    widths are reproduced exactly: the harmonic sum and the peak search are
//    double, the stored table is float32, and the interpolation reads that
//    rounded float32 back as a double. The rounding is audible state.
//  * hash01 is JS int32 arithmetic (`Math.imul`, `>>>`). Done in uint32 here:
//    identical bit patterns, defined behaviour.
//  * Each table stores its first sample again at index TABLE_SIZE, so the
//    interpolating read never wraps and never needs a branch.
//  * `updateControl` calls posSmooth.next(), posEnv.next(), filterEnv.next(),
//    cutoffSmooth.next() in exactly that order. They are stateful; the order is
//    the signal.
//  * The NaN/inf guard `if (!(y > -4 && y < 4))` is load-bearing: it catches NaN
//    through the failed comparison, not through an isnan() test.
//  * The bank is built once into a function-local static. No allocation happens
//    in render().
#pragma once

#include <cmath>
#include <cstdint>

#include "dsp/envelope.h"
#include "dsp/ladder.h"
#include "dsp/smoothing.h"
#include "dsp/util.h"

namespace sigil {

namespace wavetable_detail {

constexpr int P_POS = 0, P_POS_ENV = 1, P_DETUNE = 2, P_MIX = 3;
constexpr int P_CUTOFF = 4, P_RES = 5, P_FILTER_ENV = 6, P_DRIVE = 7;
constexpr int P_ATTACK = 8, P_DECAY = 9, P_SUSTAIN = 10, P_RELEASE = 11;
constexpr int P_KEYTRACK = 12, P_VEL_AMP = 13;

constexpr double LN2 = 0.6931471805599453;
constexpr double TWO_PI = 6.283185307179586;
/** log2(261.6256) - middle C, the note key tracking pivots around. */
constexpr double LOG2_REF = 8.03125;
constexpr int CONTROL_STEP = 8;
constexpr double OSC_GAIN = 0.9;
/** Level-matched with the other engines - see analog-voice.ts. */
constexpr double VOICE_GAIN = 0.55;

constexpr int TABLE_COUNT = 8;
constexpr int TABLE_SIZE = 2048;
/** Each table stores its first sample again at the end: interpolation never wraps. */
constexpr int STRIDE = TABLE_SIZE + 1;
/** Band-limit levels; level k keeps harmonics 1..2^k. */
constexpr int LEVELS = 10;
constexpr int MAX_HARM = 1 << (LEVELS - 1);
constexpr int BANK_SIZE = LEVELS * TABLE_COUNT * STRIDE;

/** Deterministic hash to 0..1 - the "random" phases and sparse metallic partials. */
inline double hash01(double n) {
  // Math.imul(n, k) is ToUint32(n) * k truncated to 32 bits; every call site
  // passes a small non-negative integer.
  std::uint32_t x = static_cast<std::uint32_t>(static_cast<std::int64_t>(n)) * 0x9e3779b9u;
  x ^= x >> 16; x = x * 0x45d9f3bu; x ^= x >> 13;
  return static_cast<double>(x) / 4294967296.0;
}

inline double bump(double n, double centre, double width) {
  const double d = (n - centre) / width; return std::exp(-d * d);
}

/**
 * Amplitude of harmonic n for table t. The row runs from pure to complex:
 * sine, triangle, soft organic, square, saw, two vocal formants, metallic.
 */
inline double harmonicAmp(int t, int n) {
  const double dn = static_cast<double>(n);
  switch (t) {
    case 0: return n == 1 ? 1.0 : 0.0;
    case 1: return (n & 1) == 1 ? 1.0 / (dn * dn) : 0.0;
    // Organic: a fast harmonic rolloff with a touch of octave.
    case 2: return std::exp(-0.75 * (dn - 1.0)) + (n == 2 ? 0.22 : 0.0);
    case 3: return (n & 1) == 1 ? 1.0 / dn : 0.0;
    case 4: return 1.0 / dn;
    // Vocal shapes: a thin sawtooth bed with formant bumps.
    case 5: return 0.1 / dn + bump(dn, 3.0, 1.6) + 0.65 * bump(dn, 10.0, 3.5);
    case 6: return 0.1 / dn + bump(dn, 2.0, 1.2) + 0.55 * bump(dn, 16.0, 5.0);
    // Metallic: sparse pseudo-random partials.
    default: return n == 1 ? 0.5 : (hash01(dn) < 0.2 ? 1.0 / std::sqrt(dn) : 0.0);
  }
}

inline double harmonicPhase(int t, int n) {
  if (t == 1) return (n & 3) == 3 ? 3.141592653589793 : 0.0;
  if (t >= 5) return hash01(static_cast<double>(n) * 17.0 + t) * TWO_PI;
  return 0.0;
}

/**
 * Builds every table at every band-limit level, additively. Harmonics are
 * accumulated in ascending order and the running sum is snapshotted each time
 * it crosses a power-of-two cap, so each harmonic is computed exactly once.
 */
struct Bank {
  float data[BANK_SIZE];

  Bank() {
    for (int i = 0; i < BANK_SIZE; i++) data[i] = 0.0f;
    double acc[TABLE_SIZE];
    for (int t = 0; t < TABLE_COUNT; t++) {
      for (int i = 0; i < TABLE_SIZE; i++) acc[i] = 0.0;
      int level = 0;
      for (int n = 1; n <= MAX_HARM; n++) {
        const double a = harmonicAmp(t, n);
        if (a != 0.0) {
          // Rotate a unit phasor instead of calling sin() per sample.
          const double step = (TWO_PI * n) / TABLE_SIZE;
          const double cosD = std::cos(step), sinD = std::sin(step);
          const double ph = harmonicPhase(t, n);
          double s = std::sin(ph), c = std::cos(ph);
          for (int i = 0; i < TABLE_SIZE; i++) {
            acc[i] = acc[i] + a * s;
            const double ns = s * cosD + c * sinD;
            c = c * cosD - s * sinD;
            s = ns;
          }
        }
        if (level < LEVELS && n == (1 << level)) {
          double peak = 1e-9;
          for (int i = 0; i < TABLE_SIZE; i++) {
            const double v = acc[i];
            if (v > peak) peak = v; else if (-v > peak) peak = -v;
          }
          const double g = 0.95 / peak;
          const int off = (level * TABLE_COUNT + t) * STRIDE;
          for (int i = 0; i < TABLE_SIZE; i++) {
            data[off + i] = static_cast<float>(acc[i] * g);
          }
          data[off + TABLE_SIZE] = data[off];
          level++;
        }
      }
    }
  }
};

inline const float* bank() {
  static const Bank b;
  return b.data;
}

/** Cheap rational tanh - monotonic, bounded, shaped for hot loops. */
inline double saturate(double x) {
  const double x2 = x * x;
  return (x * (27.0 + x2)) / (27.0 + 9.0 * x2);
}

}  // namespace wavetable_detail

/** WAVETABLE_DESCRIPTOR.params, in wire order. Index IS the parameter address. */
constexpr int kWavetableParamCount = 14;

inline constexpr const char* kWavetableParamIds[kWavetableParamCount] = {
  "table-position", "position-env", "osc-detune", "osc-mix",
  "filter-cutoff", "filter-resonance", "filter-env", "drive",
  "amp-attack", "amp-decay", "amp-sustain", "amp-release",
  "filter-keytrack", "amp-velocity",
};

inline constexpr double kWavetableParamDefaults[kWavetableParamCount] = {
  0.35, 0.2, 0.07, 0.5,
  4500.0, 0.12, 0.3, 0.15,
  3.0, 500.0, 0.7, 350.0,
  0.35, 0.6,
};

class WavetableVoice {
public:
  explicit WavetableVoice(double sampleRate)
      : invSr_(1.0 / sampleRate),
        maxFreq_(sampleRate * 0.45),
        bank_(wavetable_detail::bank()),
        filter_(sampleRate),
        ampEnv_(sampleRate),
        filterEnv_(sampleRate / wavetable_detail::CONTROL_STEP),
        posEnv_(sampleRate / wavetable_detail::CONTROL_STEP),
        cutoffSmooth_(sampleRate / wavetable_detail::CONTROL_STEP, 8.0),
        posSmooth_(sampleRate / wavetable_detail::CONTROL_STEP, 15.0) {
    using namespace wavetable_detail;
    for (int i = 0; i < kWavetableParamCount; i++) {
      params_[i] = static_cast<float>(kWavetableParamDefaults[i]);
    }
    applyEnvelopes();
    cutoffSmooth_.snap(p(P_CUTOFF));
    posSmooth_.snap(p(P_POS));
  }

  void setParam(int index, double value) {
    using namespace wavetable_detail;
    if (index < 0 || index >= kWavetableParamCount) return;
    params_[index] = static_cast<float>(value);
    if (index >= P_ATTACK && index <= P_RELEASE) applyEnvelopes();
  }

  void noteOn(double freq, double velocity, double voiceIndex) {
    using namespace wavetable_detail;
    const double f = freq > 8.0 ? (freq < 12000.0 ? freq : 12000.0) : 8.0;
    logFreq_ = std::log2(f);
    velocity_ = velocity > 0.0 ? (velocity < 1.0 ? velocity : 1.0) : 0.0;
    // Staggered start phases: voices that begin identically sound like one
    // loud voice until they happen to drift apart.
    ph1_ = std::fmod(std::fmod(voiceIndex * 0.137, 1.0) + 1.0, 1.0);
    ph2_ = std::fmod(std::fmod(voiceIndex * 0.311, 1.0) + 1.0, 1.0);
    filter_.reset();
    applyEnvelopes();
    ampEnv_.trigger(); filterEnv_.trigger(); posEnv_.trigger();
    cutoffSmooth_.snap(p(P_CUTOFF));
    posSmooth_.snap(p(P_POS));
    ctrl_ = 0;
    active_ = true;
  }

  void noteOff() {
    ampEnv_.release();
    filterEnv_.release();
    posEnv_.release();
  }

  /** True once a note has been triggered and its amp envelope has run out. */
  bool isFinished() const { return active_ && ampEnv_.isFinished(); }

  void render(float* out, int offset, int count) {
    using namespace wavetable_detail;
    if (!active_) return;
    detuneMul_ = std::exp((LN2 * p(P_DETUNE)) / 12.0);
    posAmt_ = p(P_POS_ENV);
    cutoffSmooth_.setTarget(p(P_CUTOFF));
    posSmooth_.setTarget(p(P_POS));
    filter_.setResonance(p(P_RES));
    const double drive = 1.0 + p(P_DRIVE) * 6.0;
    const double driveComp = 1.0 / std::sqrt(drive);
    const double raw = p(P_MIX);
    const double bal = raw < 0.0 ? 0.0 : (raw > 1.0 ? 1.0 : raw);
    const double g1 = (1.0 - bal) * OSC_GAIN, g2 = bal * OSC_GAIN;
    const double velAmp = p(P_VEL_AMP);
    const double gain = (1.0 - velAmp + velAmp * velocity_ * velocity_) * VOICE_GAIN;

    int i = 0;
    while (i < count) {
      if (ctrl_ == 0) { updateControl(); ctrl_ = CONTROL_STEP; }
      const int m = ctrl_ < count - i ? ctrl_ : count - i;
      for (int j = 0; j < m; j++) {
        const double s1 = read(offA1_, offB1_, ph1_);
        const double s2 = read(offA2_, offB2_, ph2_);
        ph1_ += inc1_; if (ph1_ >= 1.0) ph1_ -= 1.0;
        ph2_ += inc2_; if (ph2_ >= 1.0) ph2_ -= 1.0;
        const double sig = saturate((s1 * g1 + s2 * g2) * drive) * driveComp;
        double y = filter_.process(sig) * ampEnv_.next() * gain;
        // Catches NaN and infinity alike: a failed comparison falls to zero.
        if (!(y > -4.0 && y < 4.0)) y = y > 0.0 ? 4.0 : (y < 0.0 ? -4.0 : 0.0);
        const int k = offset + i + j;
        out[k] = static_cast<float>(static_cast<double>(out[k]) + y);
      }
      i += m; ctrl_ -= m;
    }
  }

private:
  double p(int i) const { return static_cast<double>(params_[i]); }

  void applyEnvelopes() {
    using namespace wavetable_detail;
    const double a = p(P_ATTACK), d = p(P_DECAY);
    const double s = p(P_SUSTAIN), r = p(P_RELEASE);
    ampEnv_.set(a, d, s, r);
    // The filter closes ahead of the amplitude and settles lower.
    filterEnv_.set(a, d * 0.8, s * 0.5, r);
    // The position envelope settles even lower, so Motion sweeps the timbre a
    // long way at the start of a note and comes to rest.
    posEnv_.set(a, d * 1.2, s * 0.3, r);
  }

  /** Bank offset of table `t` at the band-limit level right for `freq`. */
  int levelBase(double freq) const {
    using namespace wavetable_detail;
    const double harm = maxFreq_ / (freq > 1.0 ? freq : 1.0);
    double level = std::floor(std::log2(harm > 1.0 ? harm : 1.0));
    if (level >= LEVELS) level = LEVELS - 1;
    return static_cast<int>(level) * TABLE_COUNT * STRIDE;
  }

  /** Everything that moves slower than audio, recomputed once per control step. */
  void updateControl() {
    using namespace wavetable_detail;
    const double base = std::exp(LN2 * logFreq_);
    const double max = maxFreq_;
    const double f1 = base > max ? max : base;
    const double f2raw = base * detuneMul_;
    const double f2 = f2raw > max ? max : f2raw;
    inc1_ = f1 * invSr_;
    inc2_ = f2 * invSr_;

    // Table position: the knob (smoothed) plus the envelope's push, clamped
    // to the row. The scan crossfades between the two neighbouring tables.
    double pos = posSmooth_.next() + posAmt_ * posEnv_.next();
    if (pos < 0.0) pos = 0.0; else if (pos > 1.0) pos = 1.0;
    const double scaled = pos * (TABLE_COUNT - 1);
    int tA = toInt32(scaled);
    if (tA > TABLE_COUNT - 2) tA = TABLE_COUNT - 2;
    xfade_ = scaled - tA;
    const int base1 = levelBase(f1);
    const int base2 = levelBase(f2);
    offA1_ = base1 + tA * STRIDE; offB1_ = offA1_ + STRIDE;
    offA2_ = base2 + tA * STRIDE; offB2_ = offA2_ + STRIDE;

    const double fenv = filterEnv_.next();
    const double oct = p(P_KEYTRACK) * (logFreq_ - LOG2_REF);
    double cut = cutoffSmooth_.next() * std::exp(LN2 * oct)
      * (1.0 + p(P_FILTER_ENV) * fenv * 6.0);
    if (!(cut > 10.0)) cut = 10.0;
    else if (cut > max) cut = max;
    filter_.setCutoff(cut);
  }

  /** Linear-interpolated read of one oscillator: two tables, one crossfade. */
  double read(int offA, int offB, double phase) const {
    using namespace wavetable_detail;
    const double idx = phase * TABLE_SIZE;
    const int i0 = toInt32(idx);
    const double fr = idx - i0;
    const double a = static_cast<double>(bank_[offA + i0])
      + (static_cast<double>(bank_[offA + i0 + 1])
         - static_cast<double>(bank_[offA + i0])) * fr;
    const double b = static_cast<double>(bank_[offB + i0])
      + (static_cast<double>(bank_[offB + i0 + 1])
         - static_cast<double>(bank_[offB + i0])) * fr;
    return a + (b - a) * xfade_;
  }

  float params_[kWavetableParamCount] = {0};

  double invSr_;
  double maxFreq_;
  const float* bank_;

  LadderFilter filter_;
  Envelope ampEnv_;
  Envelope filterEnv_;
  Envelope posEnv_;
  Smoother cutoffSmooth_;
  Smoother posSmooth_;

  double ph1_ = 0.0, ph2_ = 0.0;
  double inc1_ = 0.0, inc2_ = 0.0;
  int offA1_ = 0, offB1_ = 0;
  int offA2_ = 0, offB2_ = 0;
  double xfade_ = 0.0;
  double detuneMul_ = 1.0;
  double posAmt_ = 0.0;
  int ctrl_ = 0;
  double logFreq_ = wavetable_detail::LOG2_REF;
  double velocity_ = 1.0;
  bool active_ = false;
};

}  // namespace sigil
