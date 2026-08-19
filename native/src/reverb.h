// Port of src/dsp/fx-reverb.ts
//
// Eight-line FDN with mutually prime delay lengths, Hadamard mixing and four
// Schroeder allpass diffusers in front. See the TypeScript for why each of the
// magic numbers is the number it is - the reasoning there is measured, not
// decorative, and none of it is re-derived here.
//
// The one thing this file has to be pedantic about is WIDTH. The TypeScript
// keeps `len`, `gain`, `lp`, `v`, `ph`, `inc`, `side` and `apLen` in
// Float32Arrays and everything else in plain fields. Every store into one of
// those arrays rounds to single precision, and in a feedback network that
// rounding is state: it is fed back into the next sample and never washes out.
// So each of those is `float` here and every read of one is explicitly widened
// to double before it is used. Two places are easy to get subtly wrong and are
// called out at the site:
//   * the LFO phase is READ BACK as the un-rounded double local, not the float
//     that was just stored;
//   * the damping one-pole likewise multiplies the double local by the gain.
#pragma once

#include <cmath>
#include <vector>

#include "primitives.h"

namespace sigil {
namespace fx {

constexpr int kFdnN = 8;
constexpr int kApN = 4;

/** Mutually prime at 48k, 23-63 ms. */
constexpr int kFdnLen[kFdnN] = {1123, 1367, 1621, 1889, 2179, 2467, 2789, 3037};
/** Schroeder allpass diffusers ahead of the network. */
constexpr int kApLen[kApN] = {67, 131, 229, 367};

constexpr double kApG = 0.55;
constexpr double kHad = 0.3535533905932738;
constexpr double kRootHalf = 0.7071067811865476;
constexpr double kRvMaxG = 0.94;
constexpr double kRvMod = 1.6;
constexpr double kRvIn = 0.5;
/** How far the difference vector is pushed past a strict partition. */
constexpr double kRvSpread = 1.35;
/** Alternating, not a block split: a block split puts all four short lines on
 *  one side and pulls the early reflections off centre. */
constexpr double kFdnSide[kFdnN] = {1, -1, 1, -1, 1, -1, 1, -1};

/**
 * In-place Hadamard on the eight-element mixing vector.
 *
 * `v` is a Float32Array in the TypeScript, so each butterfly output rounds to
 * float before the next stage reads it. Widening a and b to double and storing
 * back through float reproduces that exactly.
 */
inline void hadamard8(float* v) {
  for (int s = 1; s < kFdnN; s <<= 1) {
    for (int i = 0; i < kFdnN; i += s << 1) {
      for (int j = i; j < i + s; j++) {
        const double a = static_cast<double>(v[j]);
        const double b = static_cast<double>(v[j + s]);
        v[j] = static_cast<float>(a + b);
        v[j + s] = static_cast<float>(a - b);
      }
    }
  }
  for (int i = 0; i < kFdnN; i++) v[i] = static_cast<float>(static_cast<double>(v[i]) * kHad);
}

/** Pre-delay, four allpass diffusers, then eight damped delay lines mixed by an
 *  orthonormal Hadamard matrix. */
class Reverb {
public:
  /** `size` and `decayMs` here are plain JS numbers in the reference - NOT the
   *  float32 values that later arrive in the parameter vector. Feeding the
   *  float32 size in here instead changes every line gain. */
  Reverb(double sr, double size, double decayMs)
      : sr_(sr), pre_(static_cast<int>(std::ceil(sr * 0.2))) {
    const double k = sr / 48000.0;
    ap_.reserve(kApN);
    for (int i = 0; i < kApN; i++) {
      const double l = static_cast<double>(kApLen[i]) * k;
      apLen_[i] = static_cast<float>(l);
      ap_.emplace_back(static_cast<int>(std::ceil(l)) + 4);
    }
    line_.reserve(kFdnN);
    for (int i = 0; i < kFdnN; i++) {
      const double l = static_cast<double>(kFdnLen[i]) * k;
      len_[i] = static_cast<float>(l);
      inc_[i] = static_cast<float>((0.31 + static_cast<double>(i) * 0.07) / sr);
      side_[i] = static_cast<float>(kFdnSide[i]);
      line_.emplace_back(static_cast<int>(std::ceil(l)) + 8);
    }
    setDecay(size, decayMs);
    reset();
  }

  /** Per-line gain for a -60 dB tail. Parameter rate only; a step in feedback
   *  gain changes the decay rate, not the waveform, so it needs no smoothing. */
  void setDecay(double size, double decayMs) {
    const double dec = (decayMs / 1000.0) * sr_;
    for (int i = 0; i < kFdnN; i++) {
      const double g = std::pow(10.0, (-3.0 * static_cast<double>(len_[i]) * size) / dec);
      gain_[i] = static_cast<float>(g > kRvMaxG ? kRvMaxG : g);
    }
  }

  void reset() {
    pre_.clear();
    for (int i = 0; i < kApN; i++) ap_[static_cast<size_t>(i)].clear();
    for (int i = 0; i < kFdnN; i++) {
      line_[static_cast<size_t>(i)].clear();
      ph_[i] = static_cast<float>(static_cast<double>(i) / static_cast<double>(kFdnN));
    }
    for (int i = 0; i < kFdnN; i++) { lp_[i] = 0.0f; v_[i] = 0.0f; }
    sum_ = 0.0; diff_ = 0.0; oL = 0.0; oR = 0.0;
  }

  double process(double x, const float* p) {
    tank(x, p);
    return x + static_cast<double>(p[P_RV_MIX]) * sum_ * kHad;
  }

  /** One mono tank, two decorrelated taps off it. left + right is 2*(sum of
   *  taps) whatever the spread, so a mono fold cannot cancel. */
  void processStereo(double l, double r, const float* p) {
    tank((l + r) * 0.5, p);
    const double m = static_cast<double>(p[P_RV_MIX]) * kHad * kRootHalf;
    const double s = sum_;
    const double d = diff_ * kRvSpread;
    oL = l + m * (s + d);
    oR = r + m * (s - d);
  }

  /** Stereo results of processStereo. Plain fields so nothing is allocated to
   *  return two numbers. */
  double oL = 0.0;
  double oR = 0.0;

private:
  /** One pass of the whole network for one input sample. Leaves the two output
   *  vectors in sum_ and diff_, so mono and stereo run identical arithmetic. */
  void tank(double x, const float* p) {
    const double s = static_cast<double>(p[P_RV_SIZE]);
    const double dp = static_cast<double>(p[P_RV_DAMP]);
    double d = pre_.read(static_cast<double>(p[P_RV_PREDELAY]));
    pre_.write(x);
    for (int i = 0; i < kApN; i++) {
      Line& ln = ap_[static_cast<size_t>(i)];
      const double bo = ln.read(static_cast<double>(apLen_[i]));
      const double vv = flush(d + kApG * bo);
      ln.write(vv);
      d = bo - kApG * vv;
    }
    double sum = 0.0, diff = 0.0;
    for (int i = 0; i < kFdnN; i++) {
      double ph = static_cast<double>(ph_[i]) + static_cast<double>(inc_[i]);
      if (ph >= 1.0) ph -= 1.0;
      ph_[i] = static_cast<float>(ph);
      // A sliver of movement on every read stops the modes parking on fixed
      // frequencies. NOTE: lfo() gets the double `ph`, not the float just
      // stored - the reference reads its local, and the two differ.
      const double r =
          line_[static_cast<size_t>(i)].read(static_cast<double>(len_[i]) * s + kRvMod * lfo(ph));
      sum += r;
      diff += r * static_cast<double>(side_[i]);
      const double l =
          flush(static_cast<double>(lp_[i]) + dp * (r - static_cast<double>(lp_[i])));
      lp_[i] = static_cast<float>(l);
      // Again the double local, not lp_[i].
      v_[i] = static_cast<float>(l * static_cast<double>(gain_[i]));
    }
    hadamard8(v_);
    const double inj = d * kRvIn;
    for (int i = 0; i < kFdnN; i++) {
      line_[static_cast<size_t>(i)].write(flush(inj + static_cast<double>(v_[i])));
    }
    sum_ = sum;
    diff_ = diff;
  }

  double sr_;
  Line pre_;
  std::vector<Line> ap_;
  std::vector<Line> line_;
  float apLen_[kApN] = {0};
  float len_[kFdnN] = {0};
  float gain_[kFdnN] = {0};
  float lp_[kFdnN] = {0};
  float v_[kFdnN] = {0};
  float ph_[kFdnN] = {0};
  float inc_[kFdnN] = {0};
  float side_[kFdnN] = {0};
  /** Tank outputs, written by tank(). */
  double sum_ = 0.0;
  double diff_ = 0.0;
};

}  // namespace fx
}  // namespace sigil
