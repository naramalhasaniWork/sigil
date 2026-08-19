// Port of src/dsp/fx-reverb.ts, as the FxChain's reverb dependency.
//
// Kept in its own namespace (sigil::fxchain) so it cannot collide at link time
// with a separately-owned port of the same TypeScript file.
//
// PORTING NOTE, and it is the whole game in this file: the TypeScript holds
// `len`, `gain`, `lp`, `v`, `ph`, `inc`, `side` and `apLen` in Float32Arrays.
// Every store into one of those rounds to single precision, and that rounding
// is fed straight back into the recursion. They are `float` here for that
// reason, while every plain `number` field (sum, diff, oL, oR) stays double.
#pragma once

#include <cmath>
#include <vector>

#include "dsp/fx_core.h"
#include "fx-chain-params.h"

namespace sigil {
namespace fxchain {

using sigil::fx::Line;
using sigil::fx::flush;
using sigil::fx::lfo;

constexpr int kFdnN = 8, kApN = 4;
/** Mutually prime at 48k, 23-63 ms. */
constexpr int kFdnLen[kFdnN] = {1123, 1367, 1621, 1889, 2179, 2467, 2789, 3037};
constexpr int kApLen[kApN] = {67, 131, 229, 367};
constexpr double kApG = 0.55;
constexpr double kHad = 0.3535533905932738;
constexpr double kRootHalf = 0.7071067811865476;
constexpr double kRvMaxG = 0.94, kRvMod = 1.6, kRvIn = 0.5;
constexpr double kRvSpread = 1.35;
constexpr double kFdnSide[kFdnN] = {1, -1, 1, -1, 1, -1, 1, -1};

/** In-place Hadamard on the Float32Array `v`: every intermediate rounds. */
inline void hadamard8(float* v) {
  for (int s = 1; s < kFdnN; s <<= 1) {
    for (int i = 0; i < kFdnN; i += s << 1) {
      for (int j = i; j < i + s; j++) {
        const double a = v[j], b = v[j + s];
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
  Reverb(double sr, double size, double decayMs)
      : sr_(sr), pre_(static_cast<int>(std::ceil(sr * 0.2))) {
    const double k = sr / 48000.0;
    for (int i = 0; i < kApN; i++) {
      const double l = kApLen[i] * k;
      apLen_[i] = static_cast<float>(l);
      ap_.emplace_back(static_cast<int>(std::ceil(l)) + 4);
    }
    for (int i = 0; i < kFdnN; i++) {
      const double l = kFdnLen[i] * k;
      len_[i] = static_cast<float>(l);
      inc_[i] = static_cast<float>((0.31 + i * 0.07) / sr);
      side_[i] = static_cast<float>(kFdnSide[i]);
      line_.emplace_back(static_cast<int>(std::ceil(l)) + 8);
    }
    setDecay(size, decayMs);
    reset();
  }

  /** Per-line gain for a -60 dB tail. Parameter rate; needs no smoothing. */
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
      ph_[i] = static_cast<float>(static_cast<double>(i) / kFdnN);
    }
    for (int i = 0; i < kFdnN; i++) { lp_[i] = 0.0f; v_[i] = 0.0f; }
    sum_ = 0.0; diff_ = 0.0; oL = 0.0; oR = 0.0;
  }

  double process(double x, const float* p) {
    tank(x, p);
    return x + static_cast<double>(p[P_RV_MIX]) * sum_ * kHad;
  }

  void processStereo(double l, double r, const float* p) {
    tank((l + r) * 0.5, p);
    const double m = static_cast<double>(p[P_RV_MIX]) * kHad * kRootHalf;
    const double s = sum_, d = diff_ * kRvSpread;
    oL = l + m * (s + d);
    oR = r + m * (s - d);
  }

  double oL = 0.0, oR = 0.0;

private:
  /** One pass of the whole network for one input sample. */
  void tank(double x, const float* p) {
    const double s = p[P_RV_SIZE], dp = p[P_RV_DAMP];
    double d = pre_.read(p[P_RV_PREDELAY]);
    pre_.write(x);
    for (int i = 0; i < kApN; i++) {
      Line& ln = ap_[static_cast<size_t>(i)];
      const double bo = ln.read(apLen_[i]);
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
      // frequencies - the difference between air and metal.
      const double r = line_[static_cast<size_t>(i)].read(static_cast<double>(len_[i]) * s + kRvMod * lfo(ph));
      sum += r;
      diff += r * static_cast<double>(side_[i]);
      const double l = flush(static_cast<double>(lp_[i]) + dp * (r - static_cast<double>(lp_[i])));
      lp_[i] = static_cast<float>(l);
      v_[i] = static_cast<float>(l * static_cast<double>(gain_[i]));
    }
    hadamard8(v_);
    const double inj = d * kRvIn;
    for (int i = 0; i < kFdnN; i++) {
      line_[static_cast<size_t>(i)].write(flush(inj + static_cast<double>(v_[i])));
    }
    sum_ = sum; diff_ = diff;
  }

  double sr_;
  Line pre_;
  std::vector<Line> ap_;
  std::vector<Line> line_;
  float apLen_[kApN] = {0, 0, 0, 0};
  float len_[kFdnN] = {0}, gain_[kFdnN] = {0}, lp_[kFdnN] = {0}, v_[kFdnN] = {0};
  float ph_[kFdnN] = {0}, inc_[kFdnN] = {0}, side_[kFdnN] = {0};
  double sum_ = 0.0, diff_ = 0.0;
};

}  // namespace fxchain
}  // namespace sigil
