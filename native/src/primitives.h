// SIGIL primitives - port of src/dsp/smoothing.ts, src/dsp/blep.ts and the
// primitives half of src/dsp/fx-core.ts.
//
// This is the foundation every other module includes. It obeys the five
// porting rules stated at the top of src/dsp/util.h; the two that bite here:
//
//   * A JS `number` is a double. Every field and local below is `double`. The
//     ONE exception is Line's backing store, which the TypeScript declares as
//     a Float32Array - every write rounds to single precision and that
//     rounding is state the sound depends on, not an implementation detail.
//   * Same order, same grouping, no reassociation. `x + x - x * x - 1` is
//     ((x+x) - (x*x)) - 1 and stays that way; the build passes
//     -ffp-contract=off so the compiler cannot fuse it either.
//
// Header-only and allocation-free: the only allocation in the file is Line's
// constructor, which is never called from a render loop.
#pragma once

#include <algorithm>
#include <cmath>
#include <vector>

#include "dsp/util.h"

namespace sigil {

// ---------------------------------------------------------------------------
// smoothing.ts
// ---------------------------------------------------------------------------

/**
 * One-pole parameter smoother. Every parameter passes through one of these:
 * un-smoothed parameter changes produce zipper noise.
 *
 * The 1e-20 flush is load-bearing, not defensive noise. Without it `current`
 * decays toward the target forever and spends the tail of every gesture in
 * denormal territory; with it the smoother reaches an exact zero at a
 * determinate sample index. The golden `smoothing_denormal_flush` exists
 * specifically to pin that index.
 */
class Smoother {
public:
  Smoother(double sampleRate, double timeMs)
      : coeff_(1.0 - std::exp(-1.0 / ((timeMs / 1000.0) * sampleRate))) {}

  void setTarget(double v) { target_ = v; }
  void snap(double v) { current_ = v; target_ = v; }

  double next() {
    current_ += coeff_ * (target_ - current_);
    // Copied literally, including the constant and both comparison directions.
    if (current_ < 1e-20 && current_ > -1e-20) current_ = 0.0;
    return current_;
  }

private:
  double current_ = 0.0;
  double target_ = 0.0;
  double coeff_;
};

// ---------------------------------------------------------------------------
// blep.ts
// ---------------------------------------------------------------------------

/** polyBLEP residual for a step discontinuity at phase `t` with increment `dt`. */
inline double blep(double t, double dt) {
  if (t < dt) {
    const double x = t / dt;
    return x + x - x * x - 1.0;
  }
  if (t > 1.0 - dt) {
    const double x = (t - 1.0) / dt;
    return x * x + x + x + 1.0;
  }
  return 0.0;
}

/**
 * Antialiased sawtooth. A naive saw aliases badly above a few kHz, which is
 * the difference between "digital" and "harsh".
 */
class SawOscillator {
public:
  explicit SawOscillator(double sampleRate) : sr_(sampleRate) {}

  void setFrequency(double hz) { inc_ = hz / sr_; }
  void reset() { phase_ = 0.0; }

  double next() {
    phase_ += inc_;
    // Single subtraction, not fmod: at inc_ > 1 the TS wraps only once per
    // sample and the port must go wrong in exactly the same way.
    if (phase_ >= 1.0) phase_ -= 1.0;
    return 2.0 * phase_ - 1.0 - blep(phase_, inc_);
  }

private:
  double phase_ = 0.0;
  double inc_ = 0.0;
  double sr_;
};

// ---------------------------------------------------------------------------
// fx-core.ts primitives
// ---------------------------------------------------------------------------
namespace fx {

constexpr double kDenormal = 1e-20;

inline double flush(double x) { return (x > -kDenormal && x < kDenormal) ? 0.0 : x; }

/** The ladder's rational tanh, input-clamped so it is genuinely bounded to
 *  +/-1 (the bare rational form starts climbing again past |x| = 3). */
inline double sat(double x) {
  const double c = x > 3.0 ? 3.0 : (x < -3.0 ? -3.0 : x);
  const double c2 = c * c;
  return (c * (27.0 + c2)) / (27.0 + 9.0 * c2);
}

constexpr double kLimitKnee = 1.0;
constexpr double kLimitCeil = 1.5;

/**
 * Safety limiter with a genuinely linear region.
 *
 * Below the knee this returns x UNCHANGED - bit-exact, not "nearly". The
 * predecessor (`sat(x / 1.5) * 1.5`) had no linear region at all and put a
 * third-harmonic term on every sample; that is why the branch is written this
 * way and why it must not be smoothed over here. Above the knee, u/(1+u) bends
 * toward the ceiling with slope exactly 1 at the knee, so the transition is C1
 * continuous and cannot click.
 */
inline double limitOut(double x) {
  const double a = x < 0.0 ? -x : x;
  if (a <= kLimitKnee) return x;
  const double span = kLimitCeil - kLimitKnee;
  const double u = (a - kLimitKnee) / span;
  const double bent = kLimitKnee + span * (u / (1.0 + u));
  return x < 0.0 ? -bent : bent;
}

/**
 * The optional bus-saturation curve behind the Glue parameter (fx-core.ts
 * glueOut). This is the stage that used to be soldered across the output as
 * `sat(x / 1.5) * 1.5`: at amount 0 it returns x itself, at amount 1 it is that
 * old curve exactly, and in between it is a straight crossfade.
 */
inline double glueOut(double x, double amount) {
  const double shaped = sat(x / kLimitCeil) * kLimitCeil;
  return x + (shaped - x) * amount;
}

/** Parabolic sine over phase 0..1 - no transcendentals in the sample loop. */
inline double lfo(double p) {
  const double t = p * 2.0 - 1.0;
  return 4.0 * t * (t < 0.0 ? 1.0 + t : 1.0 - t);
}

/** Math.PI. Spelled out because M_PI is not in C++17's standard headers. */
constexpr double kPi = 3.141592653589793;

/** One-pole coefficient for a cutoff in Hz. Only ever called at param rate. */
inline double onePole(double hz, double sr) {
  const double c = 1.0 - std::exp((-2.0 * kPi * hz) / sr);
  return c > 0.999 ? 0.999 : (c < 1e-4 ? 1e-4 : c);
}

/**
 * Power-of-two circular buffer, linear-interpolated fractional reads. The
 * interpolation buys a read pointer that can move without clicking.
 *
 * `maxSamples` is a double because every TypeScript caller passes the result
 * of Math.ceil(...) and the sizing loop compares in double: taking an int here
 * would silently truncate a caller that ever passes a fraction.
 */
class Line {
public:
  explicit Line(double maxSamples) {
    int n = 4;
    while (static_cast<double>(n) < maxSamples + 4.0) n <<= 1;
    buf_.assign(static_cast<size_t>(n), 0.0f);
    mask_ = n - 1;
  }

  void write(double x) {
    // Float32Array store: the narrowing is deliberate and audible.
    buf_[static_cast<size_t>(w_)] = static_cast<float>(x);
    w_ = maskIndex(w_ + 1, mask_);
  }

  double read(double d) const {
    const double lim = static_cast<double>(mask_ - 2);
    const double c = d < 1.0 ? 1.0 : (d > lim ? lim : d);
    // JS `c | 0`. c is in [1, lim] whenever d is a number, so plain truncation
    // matches ToInt32 exactly; the guard is for d == NaN, where BOTH clamp
    // comparisons are false, c stays NaN, and JS's `NaN | 0` is 0. A bare
    // static_cast<int>(NaN) would be undefined behaviour instead.
    const int k = (c == c) ? static_cast<int>(c) : 0;
    const double a = buf_[static_cast<size_t>(maskIndex(w_ - k, mask_))];
    const double b = buf_[static_cast<size_t>(maskIndex(w_ - k - 1, mask_))];
    return a + (b - a) * (c - static_cast<double>(k));
  }

  void clear() {
    std::fill(buf_.begin(), buf_.end(), 0.0f);
    w_ = 0;
  }

private:
  std::vector<float> buf_;
  int mask_ = 0;
  int w_ = 0;
};

// FX parameter indices, straight from fx-core.ts. Literals, so they are safe
// to carry here. N_PARAMS and def() are NOT ported: they read FX_DESCRIPTOR
// out of fx-descriptor.ts, which belongs to the fx module's port. Guessing
// their values here would be exactly the kind of unmeasured assertion this
// project bans.
constexpr int P_DRIVE = 0, P_DRIVE_TONE = 1, P_CRUSH_RATE = 2, P_CRUSH_BITS = 3;
constexpr int P_CH_RATE = 4, P_CH_DEPTH = 5, P_CH_WIDTH = 6, P_CH_MIX = 7;
constexpr int P_DL_TIME = 8, P_DL_FB = 9, P_DL_TONE = 10, P_DL_WIDTH = 11, P_DL_MIX = 12;
constexpr int P_RV_PREDELAY = 13, P_RV_SIZE = 14, P_RV_DECAY = 15;
constexpr int P_RV_DAMP = 16, P_RV_MIX = 17, P_TRIM = 18;

}  // namespace fx
}  // namespace sigil
