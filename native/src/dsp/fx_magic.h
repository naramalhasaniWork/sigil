// Port of src/dsp/fx-magic.ts - the character chain.
//
// `val` and `tgt` are Float32Array in the TypeScript, so every smoothed value
// the chain reads has been rounded to float32 first. That rounding is state:
// it decides gate thresholds and it feeds every unit. Do not widen them.
#pragma once

#include <array>
#include <cmath>
#include <cstring>
#include <vector>

#include "fx_magic_descriptor.h"
#include "fx_magic_units.h"
#include "smoothing.h"

namespace sigil {
namespace magic {

/** Below this a mix is inaudible, so the unit is skipped outright. */
constexpr double SILENT = 1e-4;

class MagicChain {
public:
  explicit MagicChain(double sampleRate)
      : sr_(sampleRate), freezer_(sampleRate), shimmer_(sampleRate),
        shifter_(sampleRate), vowel_(sampleRate), stutter_(sampleRate), tape_(sampleRate) {
    sm_.reserve(kMagicParamCount);
    for (int i = 0; i < kMagicParamCount; i++) {
      const MagicParamDesc& d = MAGIC_PARAMS[static_cast<size_t>(i)];
      Smoother s(sampleRate, 20.0);
      s.snap(d.def);
      sm_.push_back(s);
      val_[static_cast<size_t>(i)] = static_cast<float>(d.def);
    }
    freezeLenMs_ = val_[kFreezeLength];
  }

  void setParam(int index, double value) {
    if (index < 0 || index >= kMagicParamCount) return;
    const MagicParamDesc& d = MAGIC_PARAMS[static_cast<size_t>(index)];
    const double v = value < d.min ? d.min : (value > d.max ? d.max : value);
    if (index == kFreezeCapture) {
      const bool on = v >= 0.5;
      if (on && !held_) wantCapture_ = true;
      else if (!on && held_) wantRelease_ = true;
      held_ = on;
      return;
    }
    if (index == kStutterSeed) { stutter_.setSeed(v); return; }
    if (index == kFreezeLength) freezeLenMs_ = v;
    sm_[static_cast<size_t>(index)].setTarget(v);
    tgt_[static_cast<size_t>(index)] = static_cast<float>(v);
  }

  void reset() {
    freezer_.reset(); shimmer_.reset(); shifter_.reset();
    vowel_.reset(); stutter_.reset(); tape_.reset();
    held_ = false; wantCapture_ = false; wantRelease_ = false;
  }

  void process(float* buffer, int count) {
    prepare();
    float* v = val_.data();
    const int np = kMagicParamCount;

    // Fully bypassed: the freezer still needs feeding so a later capture has
    // material, but the samples pass through untouched.
    if (!anyOn_) {
      for (int i = 0; i < count; i++) {
        for (int k = 0; k < np; k++) v[k] = static_cast<float>(sm_[static_cast<size_t>(k)].next());
        freezer_.process(static_cast<double>(buffer[i]));
      }
      return;
    }

    const bool onVowel = onVowel_, onShift = onShift_, onStutter = onStutter_;
    const bool onShimmer = onShimmer_, onFreeze = onFreeze_, onTape = onTape_;
    const double stutterSlice = stutterSlice_, shimmerSize = shimmerSize_;
    const double stutterRatio = stutterRatio_, shimmerRatio = shimmerRatio_;
    const double shimmerFb = shimmerFb_;

    for (int i = 0; i < count; i++) {
      for (int k = 0; k < np; k++) v[k] = static_cast<float>(sm_[static_cast<size_t>(k)].next());
      double x = static_cast<double>(buffer[i]);

      if (onVowel) {
        x = blend(x, vowel_.process(x, v[kVowelPos], v[kVowelSharp]), v[kVowelMix]);
      }
      if (onShift) {
        x = blend(x, shifter_.process(x, v[kShiftHz], v[kShiftRing]), v[kShiftMix]);
      }
      if (onStutter) {
        x = blend(x, stutter_.process(x, stutterSlice, v[kStutterChance], stutterRatio),
                  v[kStutterMix]);
      }
      if (onShimmer) {
        x = blend(x, shimmer_.process(x, shimmerSize, shimmerFb, shimmerRatio, v[kShimmerDamp]),
                  v[kShimmerMix]);
      }
      // The freezer ALWAYS runs, even at mix zero: it is a recorder as well as
      // a player. Only the blend is conditional.
      const double frozen = freezer_.process(x);
      if (onFreeze) {
        const double fm = v[kFreezeMix];
        x = x * (1.0 - 0.5 * fm) + frozen * fm;
      }
      if (onTape) {
        x = tape_.process(x, v[kTapeWear], v[kTapeWow], v[kTapeFlutter]);
      }

      if (!(x > -1e9 && x < 1e9)) { reset(); x = 0.0; }
      const double y = softLimit(x, 0.9, 0.6);
      buffer[i] = static_cast<float>(y > 1.2 ? 1.2 : (y < -1.2 ? -1.2 : y));
    }
  }

  void processStereo(float* left, float* right, int count) {
    prepare();
    float* v = val_.data();
    const int np = kMagicParamCount;

    if (!anyOn_) {
      for (int i = 0; i < count; i++) {
        for (int k = 0; k < np; k++) v[k] = static_cast<float>(sm_[static_cast<size_t>(k)].next());
        freezer_.process((static_cast<double>(left[i]) + static_cast<double>(right[i])) * 0.5);
      }
      return;
    }

    const bool onVowel = onVowel_, onShift = onShift_, onStutter = onStutter_;
    const bool onShimmer = onShimmer_, onFreeze = onFreeze_, onTape = onTape_;
    const double stutterSlice = stutterSlice_, shimmerSize = shimmerSize_;
    const double stutterRatio = stutterRatio_, shimmerRatio = shimmerRatio_;
    const double shimmerFb = shimmerFb_;

    for (int i = 0; i < count; i++) {
      for (int k = 0; k < np; k++) v[k] = static_cast<float>(sm_[static_cast<size_t>(k)].next());
      double l = static_cast<double>(left[i]), r = static_cast<double>(right[i]);

      if (onVowel) {
        const double m = (l + r) * 0.5, sd = (l - r) * 0.5, mix = v[kVowelMix];
        vowel_.processStereo(m, v[kVowelPos], v[kVowelSharp]);
        l = blend(l, vowel_.oL + sd, mix);
        r = blend(r, vowel_.oR - sd, mix);
      }
      if (onShift) {
        const double m = (l + r) * 0.5, sd = (l - r) * 0.5;
        const double y = blend(m, shifter_.process(m, v[kShiftHz], v[kShiftRing]), v[kShiftMix]);
        l = y + sd; r = y - sd;
      }
      if (onStutter) {
        const double m = (l + r) * 0.5, sd = (l - r) * 0.5;
        const double y = blend(m, stutter_.process(m, stutterSlice, v[kStutterChance], stutterRatio),
                               v[kStutterMix]);
        l = y + sd; r = y - sd;
      }
      if (onShimmer) {
        const double mix = v[kShimmerMix];
        shimmer_.processStereo(l, r, shimmerSize, shimmerFb, shimmerRatio, v[kShimmerDamp]);
        l = blend(l, shimmer_.oL, mix);
        r = blend(r, shimmer_.oR, mix);
      }
      const double mid = (l + r) * 0.5, side = (l - r) * 0.5;
      const double frozen = freezer_.process(mid);
      if (onFreeze) {
        const double fm = v[kFreezeMix];
        const double y = mid * (1.0 - 0.5 * fm) + frozen * fm;
        l = y + side; r = y - side;
      }
      if (onTape) {
        const double m = (l + r) * 0.5, sd = (l - r) * 0.5;
        const double y = tape_.process(m, v[kTapeWear], v[kTapeWow], v[kTapeFlutter]);
        l = y + sd; r = y - sd;
      }

      if (!(l > -1e9 && l < 1e9) || !(r > -1e9 && r < 1e9)) { reset(); l = 0.0; r = 0.0; }
      const double yl = softLimit(l, 0.9, 0.6), yr = softLimit(r, 0.9, 0.6);
      left[i] = static_cast<float>(yl > 1.2 ? 1.2 : (yl < -1.2 ? -1.2 : yl));
      right[i] = static_cast<float>(yr > 1.2 ? 1.2 : (yr < -1.2 ? -1.2 : yr));
    }
  }

private:
  /** Gate on the TARGET as well as the current value, and reset a unit when it
   *  comes back on: its delay lines hold audio from before the bypass. */
  void prepare() {
    if (wantCapture_) {
      freezer_.capture((freezeLenMs_ / 1000.0) * sr_);
      wantCapture_ = false;
    }
    if (wantRelease_) { freezer_.release(); wantRelease_ = false; }

    const float* v = val_.data();
    const float* t = tgt_.data();
    auto live = [v, t](int idx) {
      return static_cast<double>(v[idx]) > SILENT || static_cast<double>(t[idx]) > SILENT;
    };

    onVowel_ = live(kVowelMix);
    onShift_ = live(kShiftMix);
    onStutter_ = live(kStutterMix);
    onShimmer_ = live(kShimmerMix);
    onFreeze_ = live(kFreezeMix);
    onTape_ = live(kTapeWear) || live(kTapeWow) || live(kTapeFlutter);

    if (onVowel_ && !wasVowel_) vowel_.reset();
    if (onShift_ && !wasShift_) shifter_.reset();
    if (onStutter_ && !wasStutter_) stutter_.reset();
    if (onShimmer_ && !wasShimmer_) shimmer_.reset();
    if (onTape_ && !wasTape_) tape_.reset();
    wasVowel_ = onVowel_; wasShift_ = onShift_;
    wasStutter_ = onStutter_; wasShimmer_ = onShimmer_;
    wasTape_ = onTape_;

    anyOn_ = onVowel_ || onShift_ || onStutter_ || onShimmer_ || onFreeze_ || onTape_;
    if (!anyOn_) return;

    // Transcendentals hoisted to block rate, exactly as the TS does.
    stutterRatio_ = std::pow(2.0, static_cast<double>(t[kStutterPitch]) / 12.0);
    shimmerRatio_ = std::pow(2.0, static_cast<double>(t[kShimmerPitch]) / 12.0);
    stutterSlice_ = (static_cast<double>(t[kStutterSlice]) / 1000.0) * sr_;
    shimmerSize_ = (static_cast<double>(t[kShimmerSize]) / 1000.0) * sr_;
    shimmerFb_ = static_cast<double>(t[kShimmerFeedback]) * 0.85;
  }

  double sr_;
  std::array<float, kMagicParamCount> val_{};
  std::array<float, kMagicParamCount> tgt_{};
  std::vector<Smoother> sm_;

  Freezer freezer_;
  Shimmer shimmer_;
  FreqShifter shifter_;
  VowelFilter vowel_;
  Stutter stutter_;
  Tape tape_;

  bool wasVowel_ = false, wasShift_ = false, wasStutter_ = false;
  bool wasShimmer_ = false, wasTape_ = false;
  bool onVowel_ = false, onShift_ = false, onStutter_ = false;
  bool onShimmer_ = false, onFreeze_ = false, onTape_ = false;
  bool anyOn_ = false;
  double stutterRatio_ = 1.0, shimmerRatio_ = 1.0;
  double stutterSlice_ = 0.0, shimmerSize_ = 0.0, shimmerFb_ = 0.0;
  bool held_ = false, wantCapture_ = false, wantRelease_ = false;
  double freezeLenMs_ = 0.0;
};

}  // namespace magic
}  // namespace sigil
