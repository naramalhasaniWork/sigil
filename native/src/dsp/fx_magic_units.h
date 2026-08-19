// Port of src/dsp/fx-magic-units.ts - freeze, shimmer, vowel, stutter.
//
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

#include "fx_magic_descriptor.h"
#include "fx_magic_svf.h"
#include "smoothing.h"
#include "util.h"

namespace sigil {
namespace magic {

// ---------------------------------------------------------------------------
// FREEZE. Mono only: a frozen loop is one recording of one moment.
// ---------------------------------------------------------------------------
class Freezer {
public:
  explicit Freezer(double sr)
      : max_(static_cast<int>(jsRound(sr * 2.0))), gain_(sr, 15.0) {
    ring_.assign(static_cast<size_t>(max_), 0.0f);
    loop_.assign(static_cast<size_t>(max_), 0.0f);
  }
  void release() { held_ = false; }
  void reset() {
    std::fill(ring_.begin(), ring_.end(), 0.0f);
    std::fill(loop_.begin(), loop_.end(), 0.0f);
    gain_.snap(0.0);
    w_ = 0; len_ = 0; p_ = 0; held_ = false;
  }
  void capture(double lenSamples) {
    const int L = static_cast<int>(std::max(128.0, std::min(static_cast<double>(max_), jsRound(lenSamples))));
    copyTail(ring_, w_, loop_, L);
    // Crossfade scales with the capture.
    xf_ = static_cast<int>(std::max(1.0, std::floor(L * 0.25)));
    len_ = L - xf_;
    p_ = 0;
    held_ = true;
  }
  double process(double x) {
    ring_[static_cast<size_t>(w_)] = static_cast<float>(x);
    w_++; if (w_ >= max_) w_ = 0;
    gain_.setTarget(held_ ? 1.0 : 0.0);
    const double g = gain_.next();
    if (g == 0.0 || len_ <= 0) return 0.0;
    const int p = p_;
    double y = loop_[static_cast<size_t>(p)];
    if (p < xf_) {
      const double t = 0.5 - 0.5 * std::cos((PI * p) / xf_);
      y = y * t + static_cast<double>(loop_[static_cast<size_t>(p + len_)]) * (1.0 - t);
    }
    p_ = p + 1 >= len_ ? 0 : p + 1;
    return y * g;
  }

private:
  std::vector<float> ring_, loop_;
  int max_;
  Smoother gain_;
  int w_ = 0, len_ = 0, xf_ = 1, p_ = 0;
  bool held_ = false;
};

/** How far the right-hand tail tap sits from the left one. */
constexpr double SHIM_TAP_R = 0.79;

// ---------------------------------------------------------------------------
// SHIMMER. Diffused delay tank with a pitch shifter in the feedback path.
// ---------------------------------------------------------------------------
class Shimmer {
public:
  explicit Shimmer(double sr)
      : line_(jsRound(sr * 0.55)), shifter_(sr, 60.0),
        d1_(sr * 0.00723, 0.62), d2_(sr * 0.01043, 0.55) {}
  void reset() {
    line_.reset(); shifter_.reset(); d1_.reset(); d2_.reset(); z_ = 0.0;
    oL = 0.0; oR = 0.0;
  }
  double process(double x, double delay, double fb, double ratio, double damp) {
    return tank(x, delay, fb, ratio, damp);
  }
  void processStereo(double l, double r, double delay, double fb, double ratio, double damp) {
    oR = line_.read(delay * SHIM_TAP_R);
    oL = tank((l + r) * 0.5, delay, fb, ratio, damp);
  }
  double oL = 0.0, oR = 0.0;

private:
  /** Advances the tank by one sample and returns the left tail. */
  double tank(double x, double delay, double fb, double ratio, double damp) {
    const double tail = line_.read(delay);
    z_ = flush(z_ + (1.0 - damp * 0.92) * (tail - z_));
    double w = d2_.process(d1_.process(x + saturate(shifter_.process(z_, ratio) * fb)));
    if (w > 4.0) w = 4.0; else if (w < -4.0) w = -4.0;
    line_.write(flush(w));
    return tail;
  }
  DelayLine line_;
  PitchShifter shifter_;
  Diffuser d1_, d2_;
  double z_ = 0.0;
};

/** How far the two channels pull the formant balance apart. */
constexpr double VOWEL_SPREAD = 0.75;

// ---------------------------------------------------------------------------
// VOWEL. Three resonant bandpasses on real formant centres.
// ---------------------------------------------------------------------------
class VowelFilter {
public:
  explicit VowelFilter(double sr)
      : f_{StateVariableFilter(sr), StateVariableFilter(sr), StateVariableFilter(sr)} {
    for (int k = 0; k < 3; k++) f_[static_cast<size_t>(k)].setModeBandpass();
  }
  void reset() {
    for (int k = 0; k < 3; k++) f_[static_cast<size_t>(k)].reset();
    lastPos_ = -1.0; lastSharp_ = -1.0;
    b0_ = 0.0; b1_ = 0.0; b2_ = 0.0; oL = 0.0; oR = 0.0;
  }
  double process(double x, double pos, double sharp) {
    bands(x, pos, sharp);
    return (b0_ + b1_ * 0.55 + b2_ * 0.3) * 0.45;
  }
  void processStereo(double x, double pos, double sharp) {
    bands(x, pos, sharp);
    const double lo = b0_, mid = b1_ * 0.55, hi = b2_ * 0.3;
    oL = (lo * (1.0 + VOWEL_SPREAD) + mid + hi * (1.0 - VOWEL_SPREAD)) * 0.45;
    oR = (lo * (1.0 - VOWEL_SPREAD) + mid + hi * (1.0 + VOWEL_SPREAD)) * 0.45;
  }
  double oL = 0.0, oR = 0.0;

private:
  void bands(double x, double pos, double sharp) {
    if (std::fabs(pos - lastPos_) > 0.002 || std::fabs(sharp - lastSharp_) > 0.005) {
      lastPos_ = pos; lastSharp_ = sharp;
      const double t = (pos < 0.0 ? 0.0 : (pos > 1.0 ? 1.0 : pos)) * 4.0;
      double i = std::floor(t); if (i > 3.0) i = 3.0;
      const double frac = t - i;
      const int a = static_cast<int>(i) * 3;
      for (int k = 0; k < 3; k++) {
        const double lo = FORMANT_LOG[static_cast<size_t>(a + k)];
        const double hi = FORMANT_LOG[static_cast<size_t>(a + 3 + k)];
        StateVariableFilter& flt = f_[static_cast<size_t>(k)];
        flt.setCutoff(std::exp(lo + (hi - lo) * frac));
        flt.setResonance(0.55 + 0.42 * sharp);
      }
    }
    b0_ = f_[0].process(x);
    b1_ = f_[1].process(x);
    b2_ = f_[2].process(x);
  }
  std::array<StateVariableFilter, 3> f_;
  double lastPos_ = -1.0, lastSharp_ = -1.0;
  double b0_ = 0.0, b1_ = 0.0, b2_ = 0.0;
};

// ---------------------------------------------------------------------------
// STUTTER. Seeded mulberry32 latching - mono only.
// ---------------------------------------------------------------------------
class Stutter {
public:
  explicit Stutter(double sr)
      : max_(static_cast<int>(jsRound(sr * 0.5))),
        fade_(std::max(4.0, jsRound(sr * 0.002))) {
    ring_.assign(static_cast<size_t>(max_), 0.0f);
    slice_.assign(static_cast<size_t>(max_), 0.0f);
  }
  void setSeed(double seed) {
    const std::uint32_t s = static_cast<std::uint32_t>(toInt32(jsRound(seed)));
    s_ = s ? s : 1u;  // JS `(x >>> 0) || 1`
    active_ = false; counter_ = 0.0;
  }
  void reset() {
    std::fill(ring_.begin(), ring_.end(), 0.0f);
    std::fill(slice_.begin(), slice_.end(), 0.0f);
    w_ = 0; counter_ = 0.0; active_ = false; phase_ = 0.0; rate_ = 1.0;
  }
  double process(double x, double sliceSamples, double chance, double pitchRatio) {
    ring_[static_cast<size_t>(w_)] = static_cast<float>(x);
    w_++; if (w_ >= max_) w_ = 0;
    if (!active_) {
      counter_++;
      if (counter_ >= sliceSamples) {
        counter_ = 0.0;
        if (rand() < chance) latch(sliceSamples);
      }
      if (!active_) return x;
    }
    const int n = len_;
    double ph = phase_;
    const double i0d = std::floor(ph);
    const int i0 = static_cast<int>(i0d);
    const double a = slice_[static_cast<size_t>(i0 % n)];
    const double b = slice_[static_cast<size_t>((i0 + 1) % n)];
    double y = a + (b - a) * (ph - i0d);
    const double fd = fade_;
    if (ph < fd) y *= ph / fd; else if (ph > n - fd) y *= (n - ph) / fd;
    ph += rate_;
    if (ph >= n) {
      ph -= n;
      repeats_--;
      rate_ *= pitchRatio;
      if (rate_ < 0.25) rate_ = 0.25; else if (rate_ > 4.0) rate_ = 4.0;
      if (repeats_ <= 0) { active_ = false; counter_ = 0.0; }
    }
    phase_ = ph;
    return y;
  }

private:
  /** mulberry32: small, fast, seeded, identical every run. */
  double rand() {
    s_ = s_ + 0x6d2b79f5u;
    std::uint32_t t = s_;
    t = static_cast<std::uint32_t>(t ^ (t >> 15)) * (t | 1u);   // Math.imul
    t ^= t + static_cast<std::uint32_t>(t ^ (t >> 7)) * (t | 61u);
    return static_cast<double>((t ^ (t >> 14))) / 4294967296.0;
  }
  void latch(double n) {
    const int L = static_cast<int>(std::max(32.0, std::min(static_cast<double>(max_), jsRound(n))));
    copyTail(ring_, w_, slice_, L);
    len_ = L; phase_ = 0.0; rate_ = 1.0;
    repeats_ = 2.0 + std::floor(rand() * 4.0);
    active_ = true;
  }
  std::vector<float> ring_, slice_;
  int max_;
  double fade_;
  int w_ = 0;
  double counter_ = 0.0;
  bool active_ = false;
  double phase_ = 0.0, rate_ = 1.0, repeats_ = 0.0;
  int len_ = 0;
  std::uint32_t s_ = 1337u;
};

}  // namespace magic
}  // namespace sigil
