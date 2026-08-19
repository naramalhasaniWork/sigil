// Port of src/dsp/sampler-voice.ts
//
// Follows the five porting rules at the top of src/dsp/util.h. The points that
// bite hardest in this module:
//
//   * `params` is a Float32Array in the TS, so it is `float` here. Every read
//     widens back to double. That rounding is audible state: the descriptor
//     default drive 0.1 is NOT 0.1 once it has been through a Float32Array, and
//     it multiplies straight into `drive` and therefore into the saturator.
//   * The sample buffer is a Float32Array. `readLin` widens two floats and does
//     all of the interpolation arithmetic in double, in the TS's order.
//   * The output buffer is a Float32Array and render() ADDS into it, so each
//     store rounds to f32 before the next block reads it back.
//   * `buildDefault()` tracks its peak from the DOUBLE `v`, not from the f32
//     value it just stored. Normalising against the f32-rounded peak gives a
//     different gain and a different buffer. Copied literally.
//
// MODULE-LEVEL STATE, DELIBERATELY NOT PORTED AS SUCH
// ---------------------------------------------------
// The TypeScript keeps `activeData`, `activeSr` and `activeRoot` at module
// scope: one browser page, one engine, one sample. In a plugin that is wrong -
// two instances of the VST3 in one Ableton set would share the buffer, and
// loading a sample into track 2 would silently change track 1. The state is
// therefore hoisted into an explicit `SampleStore` that the host owns and each
// voice holds a reference to. Read/write timing is unchanged: the store's root
// is read at noteOn, its data and sample rate at render, exactly as the TS
// reads the module globals at those same points.
#pragma once

#include <cmath>
#include <cstdint>
#include <vector>

#include "dsp/envelope.h"
#include "dsp/filters.h"
#include "dsp/util.h"

namespace sigil {
namespace sampler {

// Parameter indices, mirroring the P_* constants in the TS.
enum {
  kStart = 0, kEnd = 1, kLoopMode = 2, kLoopStart = 3, kLoopLength = 4,
  kXfade = 5, kReverse = 6, kTune = 7, kFine = 8,
  kCutoff = 9, kRes = 10, kModel = 11,
  kAttack = 12, kDecay = 13, kSustain = 14, kRelease = 15,
  kDrive = 16, kBits = 17, kVelAmp = 18, kWobble = 19, kWobbleRate = 20,
  kNumParams = 21,
};

/** SAMPLER_DESCRIPTOR defaults, in descriptor order. */
constexpr double kDefaults[kNumParams] = {
  0.0, 1.0, 0.0, 0.0, 1.0,
  15.0, 0.0, 0.0, 0.0,
  18000.0, 0.1, 0.0,
  2.0, 800.0, 1.0, 120.0,
  0.1, 16.0, 0.6, 0.0, 5.0,
};

constexpr double kTwoPi = 6.283185307179586;
/** Pitch wobble and cutoff move far slower than audio; once per 16 samples. */
constexpr int kControlStep = 16;
/** DEFAULT_ROOT is middle C, the pitch the built-in sample was written at. */
constexpr double kDefaultSr = 48000.0;
constexpr double kDefaultRoot = 261.6255653;
/** Fade at the edges of a one-shot, in source frames - about 2 ms at 48 k. */
constexpr double kEdgeFade = 96.0;
constexpr double kInvEdgeFade = 1.0 / kEdgeFade;
/** Below this a loop is shorter than the crossfade machinery can handle. */
constexpr double kMinLoop = 32.0;
/* Trimmed rather than raised: the sampler was the loudest engine at -7.2 dBFS,
 * and it is the one whose level also depends on the material loaded into it. */
constexpr double kVoiceGain = 0.7;

/**
 * A struck tone at middle C, so the engine sounds before anything is loaded.
 * Built once, on the first voice allocation - never inside render().
 */
inline std::vector<float> buildDefault() {
  const int len = static_cast<int>(kDefaultSr);
  std::vector<float> buf(static_cast<size_t>(len), 0.0f);
  double peak = 1e-9;
  for (int i = 0; i < len; ++i) {
    const double t = i / kDefaultSr;
    const double w = kDefaultRoot * kTwoPi * t;
    // Slightly stretched partials, each dying faster than the one below it:
    // that ratio is what the ear reads as "struck" rather than "held".
    double v = std::sin(w) * std::exp(-3.2 * t)
        + std::sin(w * 2.01) * 0.42 * std::exp(-5.5 * t)
        + std::sin(w * 3.02) * 0.22 * std::exp(-8.0 * t)
        + std::sin(w * 5.4) * 0.11 * std::exp(-15.0 * t);
    v *= 1.0 - std::exp(-t * 900.0);
    buf[static_cast<size_t>(i)] = static_cast<float>(v);
    // Peak is tracked from the double, NOT from the value just stored.
    const double a = v < 0.0 ? -v : v;
    if (a > peak) peak = a;
  }
  const double g = 0.9 / peak;
  for (int i = 0; i < len; ++i) {
    buf[static_cast<size_t>(i)] =
        static_cast<float>(static_cast<double>(buf[static_cast<size_t>(i)]) * g);
  }
  return buf;
}

/**
 * The sample every voice plays. Voices keep no copy and never make one:
 * swapping the buffer is a single pointer assignment, so the UI can drop in a
 * 30 MB recording between blocks without touching the pool.
 *
 * One store per plugin instance. Nothing here is global.
 */
class SampleStore {
public:
  /** Point every voice at new material. Ignores obviously broken input. */
  void setActiveSample(const float* data, int length, double sampleRate, double rootHz) {
    if (length >= 16) { data_ = data; len_ = length; }
    if (sampleRate > 1000.0 && sampleRate < 768000.0) sr_ = sampleRate;
    if (rootHz > 8.0 && rootHz < 12000.0) root_ = rootHz;
  }

  /** `if (!activeData) activeData = buildDefault();` from the TS constructor. */
  void ensureDefault() {
    if (data_ != nullptr) return;
    builtin_ = buildDefault();
    data_ = builtin_.data();
    len_ = static_cast<int>(builtin_.size());
  }

  const float* data() const { return data_; }
  int length() const { return len_; }
  double sampleRate() const { return sr_; }
  double rootHz() const { return root_; }

private:
  std::vector<float> builtin_;
  const float* data_ = nullptr;
  int len_ = 0;
  double sr_ = kDefaultSr;
  double root_ = kDefaultRoot;
};

/**
 * Linear interpolation between the two samples either side of a fractional read
 * position. The treble cost is real, and deliberate: see the TS comment.
 */
inline double readLin(const float* d, double pos, int len) {
  int i0 = static_cast<int>(toInt32(pos));
  if (i0 < 0) i0 = 0; else if (i0 > len - 1) i0 = len - 1;
  int i1 = i0 + 1;
  if (i1 > len - 1) i1 = len - 1;
  const double a = static_cast<double>(d[i0]);
  const double b = static_cast<double>(d[i1]);
  return a + (b - a) * (pos - i0);
}

/** Cheap rational tanh - monotonic, bounded, shaped for hot loops. */
inline double saturate(double x) {
  const double x2 = x * x;
  return (x * (27.0 + x2)) / (27.0 + 9.0 * x2);
}

inline double clamp01(double v) {
  return v > 0.0 ? (v < 1.0 ? v : 1.0) : 0.0;
}

class SamplerVoice {
public:
  SamplerVoice(double sampleRate, SampleStore& store)
      : store_(store),
        ladder_(sampleRate), svf_(sampleRate), diode_(sampleRate),
        ampEnv_(sampleRate), invSr_(1.0 / sampleRate) {
    activeFilter_ = &ladder_;
    for (int i = 0; i < kNumParams; ++i) params_[i] = static_cast<float>(kDefaults[i]);
    store_.ensureDefault();
    applyEnvelope();
  }

  void setParam(int index, double value) {
    if (index < 0 || index >= kNumParams) return;
    params_[index] = static_cast<float>(value);
    if (index >= kAttack && index <= kRelease) applyEnvelope();
  }

  void noteOn(double freq, double velocity, int voiceIndex) {
    const double f = freq > 8.0 ? (freq < 12000.0 ? freq : 12000.0) : 8.0;
    noteRatio_ = f / store_.rootHz();
    velocity_ = velocity > 0.0 ? (velocity < 1.0 ? velocity : 1.0) : 0.0;
    ladder_.reset(); svf_.reset(); diode_.reset();
    applyEnvelope();
    ampEnv_.trigger();
    // Staggered wobble phase: identical phase across a chord makes every note
    // bend the same way at the same moment, which sounds like a fault.
    wobPhase_ = std::fmod(std::fmod(voiceIndex * 0.317, 1.0) + 1.0, 1.0);
    ctrl_ = 0;
    ended_ = false;
    restart_ = true;
    active_ = true;
  }

  void noteOff() { ampEnv_.release(); }

  bool isFinished() const { return active_ && (ended_ || ampEnv_.isFinished()); }

  void render(float* out, int offset, int count) {
    if (!active_ || ended_) return;
    const float* data = store_.data();
    if (data == nullptr) return;
    const int len = store_.length();
    if (len < 16) return;
    const float* p = params_;
    const double activeSr = store_.sampleRate();

    // Trim window, in source frames. Every bound below is derived from these,
    // so one clamp here keeps the whole render inside the buffer.
    double s0 = std::floor(clamp01(static_cast<double>(p[kStart])) * len);
    double s1 = std::floor(clamp01(static_cast<double>(p[kEnd])) * len);
    if (s0 > len - 8) s0 = len - 8;
    if (s1 < s0 + 4) s1 = s0 + 4;

    double mode = jsRound(static_cast<double>(p[kLoopMode]));
    if (!(mode > 0.0)) mode = 0.0; else if (mode > 2.0) mode = 2.0;
    const double span = s1 - s0;
    if (span < kMinLoop * 2.0) mode = 0.0;
    double lStart = s0 + clamp01(static_cast<double>(p[kLoopStart])) * span;
    double lLen = clamp01(static_cast<double>(p[kLoopLength])) * (s1 - lStart);
    if (lLen < kMinLoop) lLen = kMinLoop;
    double lEnd = lStart + lLen;
    if (lEnd > s1) { lEnd = s1; lStart = lEnd - lLen; }
    if (lStart < s0) { lStart = s0; lLen = lEnd - lStart; }

    // The crossfade reads one loop length behind the play head, so it can only
    // be as long as the material sitting before the loop start.
    double xf = static_cast<double>(p[kXfade]) * 0.001 * activeSr;
    if (!(xf > 0.0)) xf = 0.0;
    const double room = lStart - s0;
    if (xf > room) xf = room;
    if (xf > lLen * 0.5) xf = lLen * 0.5;
    const bool fading = mode == 1.0 && xf >= 1.0;
    const double invXf = fading ? 1.0 / xf : 0.0;
    const double xfStart = lEnd - xf;

    const bool rev = static_cast<double>(p[kReverse]) >= 0.5;
    if (restart_) {
      dir_ = rev ? -1.0 : 1.0;
      pos_ = rev ? s1 - 1.0 : s0;
      restart_ = false;
    } else if (pos_ < s0) pos_ = s0;
    else if (pos_ > s1) pos_ = s1 - 1.0;

    const double model = jsRound(static_cast<double>(p[kModel]));
    Filter* filter = model == 1.0 ? static_cast<Filter*>(&svf_)
                   : model == 2.0 ? static_cast<Filter*>(&diode_)
                                  : static_cast<Filter*>(&ladder_);
    activeFilter_ = filter;
    filter->setResonance(static_cast<double>(p[kRes]));

    const double semis = static_cast<double>(p[kTune]) + static_cast<double>(p[kFine]);
    double base = noteRatio_ * activeSr * invSr_ * std::pow(2.0, semis / 12.0);
    if (!(base > 0.0)) base = 1.0;
    baseInc_ = base;
    wobInc_ = static_cast<double>(p[kWobbleRate]) * invSr_ * kControlStep;

    const double drive = 1.0 + static_cast<double>(p[kDrive]) * 8.0;
    const double driveComp = 1.0 / std::sqrt(drive);
    double bits = jsRound(static_cast<double>(p[kBits]));
    if (!(bits > 2.0)) bits = 2.0; else if (bits > 16.0) bits = 16.0;
    const double q = bits < 16.0 ? std::pow(2.0, bits - 1.0) : 0.0;
    const double invQ = q > 0.0 ? 1.0 / q : 0.0;
    const double velAmp = clamp01(static_cast<double>(p[kVelAmp]));
    const double gain = (1.0 - velAmp + velAmp * velocity_ * velocity_) * kVoiceGain;

    int i = 0;
    while (i < count) {
      if (ctrl_ == 0) { updateControl(); ctrl_ = kControlStep; }
      const int m = ctrl_ < count - i ? ctrl_ : count - i;
      const double step = inc_;
      int j = 0;
      for (; j < m; ++j) {
        double pos = pos_;
        double s = readLin(data, pos, len);
        if (fading && pos > xfStart) {
          // Blend in the material one loop length back - the same phase of the
          // loop, approached from before its start - so the seam has no step.
          const double t = (pos - xfStart) * invXf;
          s += (readLin(data, pos - lLen, len) - s) * t;
        } else if (mode == 0.0) {
          double d = pos - s0;
          const double d2 = s1 - pos;
          if (d2 < d) d = d2;
          if (d < kEdgeFade) s *= d * kInvEdgeFade;
        }
        if (q > 0.0) s = jsRound(s * q) * invQ;
        s = saturate(s * drive) * driveComp;
        double y = filter->process(s) * ampEnv_.next() * gain;
        // Catches NaN and infinity alike: a failed comparison falls to zero.
        if (!(y > -4.0 && y < 4.0)) y = y > 0.0 ? 4.0 : (y < 0.0 ? -4.0 : 0.0);
        const size_t k = static_cast<size_t>(offset + i + j);
        out[k] = static_cast<float>(static_cast<double>(out[k]) + y);

        pos += step * dir_;
        if (mode == 1.0) {
          while (pos >= lEnd) pos -= lLen;
          while (pos < lStart) pos += lLen;
        } else if (mode == 2.0) {
          if (pos >= lEnd) { pos = lEnd + lEnd - pos; dir_ = -1.0; }
          else if (pos <= lStart) { pos = lStart + lStart - pos; dir_ = 1.0; }
          if (pos > lEnd) pos = lEnd; else if (pos < lStart) pos = lStart;
        } else if (pos >= s1 || pos < s0) {
          pos_ = pos;
          ended_ = true;
          return;
        }
        pos_ = pos;
      }
      i += j;
      ctrl_ -= j;
    }
  }

private:
  void applyEnvelope() {
    ampEnv_.set(static_cast<double>(params_[kAttack]), static_cast<double>(params_[kDecay]),
                static_cast<double>(params_[kSustain]), static_cast<double>(params_[kRelease]));
  }

  void updateControl() {
    const float* p = params_;
    const double depth = clamp01(static_cast<double>(p[kWobble]));
    double mul = 1.0;
    if (depth > 0.0) {
      double ph = wobPhase_ + wobInc_;
      if (ph >= 1.0) ph -= static_cast<double>(toInt32(ph));
      wobPhase_ = ph;
      mul = 1.0 + depth * 0.06 * std::sin(ph * kTwoPi);
    }
    double inc = baseInc_ * mul;
    if (!(inc > 1e-4)) inc = 1e-4; else if (inc > 64.0) inc = 64.0;
    inc_ = inc;
    double cut = static_cast<double>(p[kCutoff]);
    if (!(cut > 10.0)) cut = 10.0;
    activeFilter_->setCutoff(cut);
  }

  SampleStore& store_;
  float params_[kNumParams] = {0};
  LadderModel ladder_;
  StateVariableFilter svf_;
  DiodeFilter diode_;
  Filter* activeFilter_ = nullptr;
  Envelope ampEnv_;
  double invSr_;

  double pos_ = 0.0;
  double dir_ = 1.0;
  double baseInc_ = 1.0;
  double inc_ = 1.0;
  double wobPhase_ = 0.0;
  double wobInc_ = 0.0;
  int ctrl_ = 0;
  double velocity_ = 1.0;
  double noteRatio_ = 1.0;
  bool active_ = false;
  bool ended_ = false;
  bool restart_ = false;
};

}  // namespace sampler
}  // namespace sigil
