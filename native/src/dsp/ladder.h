// Port of src/dsp/ladder.ts
#pragma once
#include <cmath>

namespace sigil {
namespace ladder_detail {
constexpr double kDenormal = 1e-20;
/** Cheap rational tanh - monotonic, bounded, shaped for hot loops. */
inline double saturate(double x) {
  const double x2 = x * x;
  return (x * (27.0 + x2)) / (27.0 + 9.0 * x2);
}
}  // namespace ladder_detail

/** 4-pole transistor-ladder-style lowpass with saturating feedback. */
class LadderFilter {
public:
  explicit LadderFilter(double sampleRate)
      : sr_(sampleRate), maxCutoff_(sampleRate * 0.45) {
    setCutoff(1000.0);
    setResonance(0.0);
  }

  void setCutoff(double hz) {
    const double c = hz < 10.0 ? 10.0 : (hz > maxCutoff_ ? maxCutoff_ : hz);
    // 3.141592653589793 is Math.PI; spelled out so the constant cannot drift.
    g_ = 1.0 - std::exp((-2.0 * 3.141592653589793 * c) / sr_);
  }

  void setResonance(double r) {
    const double clamped = r < 0.0 ? 0.0 : (r > 1.0 ? 1.0 : r);
    feedback_ = clamped * 4.0;
  }

  void reset() { s1_ = s2_ = s3_ = s4_ = 0.0; }

  double process(double x) {
    const double fb = feedback_ * (s4_ - 0.5 * s3_);
    const double input = ladder_detail::saturate(x - fb);

    s1_ += g_ * (input - s1_);
    s2_ += g_ * (s1_ - s2_);
    s3_ += g_ * (s2_ - s3_);
    s4_ += g_ * (s3_ - s4_);

    constexpr double D = ladder_detail::kDenormal;
    if (s1_ < D && s1_ > -D) s1_ = 0.0;
    if (s2_ < D && s2_ > -D) s2_ = 0.0;
    if (s3_ < D && s3_ > -D) s3_ = 0.0;
    if (s4_ < D && s4_ > -D) s4_ = 0.0;

    return s4_;
  }

private:
  double s1_ = 0.0, s2_ = 0.0, s3_ = 0.0, s4_ = 0.0;
  double g_ = 0.0, feedback_ = 0.0;
  double sr_, maxCutoff_;
};

}  // namespace sigil
