// Port of src/dsp/fx-magic-descriptor.ts
//
// The magic chain's DSP primitives plus its parameter table. Rules from util.h
// apply throughout: JS `number` is `double`, Float32Array is `float` (and that
// rounding is state, not detail), same order and grouping, guards copied
// literally.
//
// Everything lives in `sigil::magic` so this port cannot collide with the
// separate ports of filters.ts / fx-core.ts, which define same-named things.
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

#include "util.h"

namespace sigil {
namespace magic {

constexpr double DENORMAL = 1e-20;
/** Math.PI, exactly. */
constexpr double PI = 3.141592653589793;
constexpr double TWO_PI = PI * 2.0;

/** Flush denormals. Every recursive path in the chain runs through this. */
inline double flush(double x) { return (x < DENORMAL && x > -DENORMAL) ? 0.0 : x; }

/** Cheap rational tanh - monotonic, shaped for hot loops. */
inline double saturate(double x) {
  const double x2 = x * x;
  return (x * (27.0 + x2)) / (27.0 + 9.0 * x2);
}

/** Linear below `knee`, then a knee to a hard ceiling of `knee + span / 2`. */
inline double softLimit(double x, double knee, double span) {
  const double a = x < 0.0 ? -x : x;
  if (a <= knee) return x;
  const double over = a - knee;
  const double lim = over >= span ? knee + span * 0.5
                                  : knee + over * (1.0 - over / (span + span));
  return x < 0.0 ? -lim : lim;
}

/** Crossfade dry toward wet. Every effect in the chain is mixed through this. */
inline double blend(double dry, double wet, double m) { return dry + (wet - dry) * m; }

/** Copy the `n` most recent samples out of a ring buffer, oldest first. */
inline void copyTail(const std::vector<float>& ring, int w, std::vector<float>& dst, int n) {
  const int max = static_cast<int>(ring.size());
  int r = w - n;
  while (r < 0) r += max;
  for (int i = 0; i < n; i++) {
    dst[static_cast<size_t>(i)] = ring[static_cast<size_t>(r)];
    r++;
    if (r >= max) r = 0;
  }
}

/** Fractional-delay ring buffer, power-of-two length so wrapping is one mask. */
class DelayLine {
public:
  explicit DelayLine(double maxSamples) {
    int size = 8;
    while (size < maxSamples + 4.0) size <<= 1;
    buf_.assign(static_cast<size_t>(size), 0.0f);
    mask_ = size - 1;
  }
  void reset() {
    std::fill(buf_.begin(), buf_.end(), 0.0f);
    w_ = 0;
  }
  void write(double x) {
    buf_[static_cast<size_t>(w_)] = static_cast<float>(x);
    w_ = maskIndex(w_ + 1, mask_);
  }
  /** `d` samples into the past, linearly interpolated. */
  double read(double d) const {
    const double pos = static_cast<double>(w_) - 1.0 - d;
    const double i0d = std::floor(pos);
    const double f = pos - i0d;
    const std::int32_t i0 = toInt32(i0d);
    const double a = buf_[static_cast<size_t>(maskIndex(i0, mask_))];
    const double b = buf_[static_cast<size_t>(maskIndex(i0 + 1, mask_))];
    return a + (b - a) * f;
  }

private:
  std::vector<float> buf_;
  int mask_ = 0;
  int w_ = 0;
};

/** Second-order allpass, H(z) = (a^2 - z^-2) / (1 - a^2 z^-2). */
class Allpass2 {
public:
  explicit Allpass2(double coeff) : a_(coeff * coeff) {}
  void reset() { x1_ = 0.0; x2_ = 0.0; y1_ = 0.0; y2_ = 0.0; }
  double process(double x) {
    const double y = a_ * (x + y2_) - x2_;
    x2_ = x1_; x1_ = x; y2_ = y1_; y1_ = flush(y);
    return y1_;
  }

private:
  double x1_ = 0.0, x2_ = 0.0, y1_ = 0.0, y2_ = 0.0;
  double a_;
};

// Niemitalo's allpass pair.
constexpr double HILBERT_I[4] = {0.6923877778065, 0.9360654322959, 0.988229522686, 0.9987488452737};
constexpr double HILBERT_Q[4] = {0.4021921162426, 0.856171088242, 0.9722909545651, 0.9952884791278};

/** Approximate Hilbert transformer; `i` and `q` are the quadrature branches. */
class HilbertPair {
public:
  HilbertPair()
      : ci_{Allpass2(HILBERT_I[0]), Allpass2(HILBERT_I[1]), Allpass2(HILBERT_I[2]), Allpass2(HILBERT_I[3])},
        cq_{Allpass2(HILBERT_Q[0]), Allpass2(HILBERT_Q[1]), Allpass2(HILBERT_Q[2]), Allpass2(HILBERT_Q[3])} {}
  void reset() {
    for (int k = 0; k < 4; k++) { ci_[k].reset(); cq_[k].reset(); }
    z_ = 0.0; i = 0.0; q = 0.0;
  }
  void process(double x) {
    double a = x, b = x;
    for (int k = 0; k < 4; k++) {
      a = ci_[k].process(a);
      b = cq_[k].process(b);
    }
    i = z_; z_ = a; q = b;
  }
  double i = 0.0, q = 0.0;

private:
  std::array<Allpass2, 4> ci_;
  std::array<Allpass2, 4> cq_;
  double z_ = 0.0;
};

/** Rotating-tap pitch shifter. Two read pointers half a window apart. */
class PitchShifter {
public:
  PitchShifter(double sampleRate, double windowMs)
      : win_(jsRound((windowMs / 1000.0) * sampleRate)), line_(win_ * 2.0 + 8.0) {}
  void reset() { line_.reset(); phase_ = 0.0; }
  double process(double x, double ratio) {
    line_.write(x);
    const double w = win_;
    double p = phase_ + (1.0 - ratio);
    if (p < 0.0) p += w; else if (p >= w) p -= w;
    phase_ = p;
    const double q = p < w * 0.5 ? p + w * 0.5 : p - w * 0.5;
    const double g = 0.5 - 0.5 * std::cos((TWO_PI * p) / w);
    return g * line_.read(p) + (1.0 - g) * line_.read(q);
  }

private:
  double win_;
  DelayLine line_;
  double phase_ = 0.0;
};

/** Schroeder allpass - unity gain, smears transients. */
class Diffuser {
public:
  Diffuser(double lengthSamples, double g)
      : len_(static_cast<int>(std::max(2.0, jsRound(lengthSamples)))), g_(g) {
    buf_.assign(static_cast<size_t>(len_), 0.0f);
  }
  void reset() {
    std::fill(buf_.begin(), buf_.end(), 0.0f);
    idx_ = 0;
  }
  double process(double x) {
    const double d = buf_[static_cast<size_t>(idx_)];
    const double y = d - g_ * x;
    buf_[static_cast<size_t>(idx_)] = static_cast<float>(flush(x + g_ * y));
    idx_++;
    if (idx_ >= len_) idx_ = 0;
    return y;
  }

private:
  std::vector<float> buf_;
  int len_;
  int idx_ = 0;
  double g_;
};

// A, E, I, O, U - three formant centres each, as natural logs. The TS holds
// these in a Float32Array, so the stored value is float, not double.
constexpr double FORMANT_HZ[15] = {730, 1090, 2440, 530, 1840, 2480, 270, 2290,
                                   3010, 570, 840, 2410, 300, 870, 2240};
inline std::array<float, 15> makeFormantLog() {
  std::array<float, 15> t{};
  for (int i = 0; i < 15; i++) t[static_cast<size_t>(i)] = static_cast<float>(std::log(FORMANT_HZ[i]));
  return t;
}
inline const std::array<float, 15> FORMANT_LOG = makeFormantLog();

/** Parameter indices - the chain indexes by these, never by a literal. */
enum MagicParam {
  kFreezeCapture = 0, kFreezeLength = 1, kFreezeMix = 2, kShimmerMix = 3, kShimmerPitch = 4,
  kShimmerFeedback = 5, kShimmerSize = 6, kShimmerDamp = 7, kShiftHz = 8, kShiftMix = 9,
  kShiftRing = 10, kVowelPos = 11, kVowelMix = 12, kVowelSharp = 13, kStutterMix = 14,
  kStutterChance = 15, kStutterSlice = 16, kStutterPitch = 17, kStutterSeed = 18,
  kTapeWear = 19, kTapeWow = 20, kTapeFlutter = 21, kMagicParamCount = 22,
};

struct MagicParamDesc { const char* id; double min; double max; double def; };

/** FX_MAGIC_DESCRIPTOR.params, in declaration order. */
inline const std::array<MagicParamDesc, kMagicParamCount> MAGIC_PARAMS = {{
    {"freeze-capture", 0, 1, 0},
    {"freeze-length", 40, 2000, 500},
    {"freeze-mix", 0, 1, 0},
    {"shimmer-mix", 0, 1, 0},
    {"shimmer-pitch", 0, 12, 12},
    {"shimmer-feedback", 0, 1, 0.6},
    {"shimmer-size", 20, 500, 180},
    {"shimmer-damp", 0, 1, 0.4},
    {"shift-hz", -1000, 1000, 0},
    {"shift-mix", 0, 1, 0},
    {"shift-ring", 0, 1, 0},
    {"vowel-pos", 0, 1, 0},
    {"vowel-mix", 0, 1, 0},
    {"vowel-sharp", 0, 1, 0.6},
    {"stutter-mix", 0, 1, 0},
    {"stutter-chance", 0, 1, 0.35},
    {"stutter-slice", 20, 500, 120},
    {"stutter-pitch", -12, 12, 0},
    {"stutter-seed", 1, 9999, 1337},
    {"tape-wear", 0, 1, 0},
    {"tape-wow", 0, 1, 0},
    {"tape-flutter", 0, 1, 0},
}};

/** TAPE. Wow and flutter as pitch modulation, plus saturation and HF loss. */
class Tape {
public:
  explicit Tape(double sr) : sr_(sr), base_(sr * 0.006), line_(jsRound(sr * 0.02)) {}
  void reset() { line_.reset(); wowPh_ = 0.0; fl1_ = 0.0; fl2_ = 0.0; lp_ = 0.0; }
  double process(double x, double wear, double wow, double flutter) {
    wowPh_ += (TWO_PI * 0.73) / sr_; if (wowPh_ > TWO_PI) wowPh_ -= TWO_PI;
    fl1_ += (TWO_PI * 7.3) / sr_; if (fl1_ > TWO_PI) fl1_ -= TWO_PI;
    fl2_ += (TWO_PI * 11.9) / sr_; if (fl2_ > TWO_PI) fl2_ -= TWO_PI;
    const double mod = sr_ * (wow * 0.0028 * std::sin(wowPh_)
        + flutter * 0.00035 * (std::sin(fl1_) * 0.7 + std::sin(fl2_) * 0.3));
    line_.write(x);
    const double d = line_.read(base_ + mod);
    const double hot = saturate(d * (1.0 + wear * 5.0)) / (1.0 + wear * 1.6);
    const double y = d + (hot - d) * wear;
    // One-pole tone control; approximating the coefficient saves a per-sample exp().
    double c = (TWO_PI * (18000.0 - 15200.0 * wear)) / sr_;
    if (c > 0.99) c = 0.99;
    lp_ = flush(lp_ + c * (y - lp_));
    return lp_;
  }

private:
  double sr_, base_;
  DelayLine line_;
  double wowPh_ = 0.0, fl1_ = 0.0, fl2_ = 0.0, lp_ = 0.0;
};

/** FREQUENCY SHIFTER. Single-sideband, morphing to ring modulation. */
class FreqShifter {
public:
  explicit FreqShifter(double sr) : sr_(sr) {}
  void reset() { hil_.reset(); phase_ = 0.0; }
  double process(double x, double hz, double ring) {
    hil_.process(x);
    double ph = phase_ + (TWO_PI * hz) / sr_;
    if (ph > PI) ph -= TWO_PI; else if (ph < -PI) ph += TWO_PI;
    phase_ = ph;
    const double c = std::cos(ph), s = std::sin(ph);
    // i lags q by 90 degrees, so summing the products keeps the upper sideband.
    return blend(hil_.i * c + hil_.q * s, x * c, ring);
  }

private:
  HilbertPair hil_;
  double sr_;
  double phase_ = 0.0;
};

}  // namespace magic
}  // namespace sigil
