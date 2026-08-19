// The one class the fx-magic port borrows from src/dsp/filters.ts: the TPT
// state-variable filter, which the vowel filter uses three of in bandpass mode.
//
// It is ported into `sigil::magic` rather than reused from dsp/filters.h so the
// fx-magic port owns its whole dependency tree and cannot be broken by work in
// progress on another module. The arithmetic is line-for-line the same as the
// filters.ts port; if the two are ever merged, THIS copy is the one to delete -
// filters.ts is the authority.
#pragma once

#include <cmath>

#include "fx_magic_descriptor.h"

namespace sigil {
namespace magic {

// ---------------------------------------------------------------------------
// filters.ts: StateVariableFilter (bandpass mode is all the vowel filter uses,
// but the class is ported whole so its behaviour cannot silently diverge).
// ---------------------------------------------------------------------------
constexpr double MIN_CUTOFF = 10.0;
constexpr double MAX_CUTOFF_RATIO = 0.49;

class StateVariableFilter {
public:
  explicit StateVariableFilter(double sampleRate)
      : sr_(sampleRate), maxCutoff_(sampleRate * MAX_CUTOFF_RATIO) {
    setCutoff(1000.0);
    setResonance(0.0);
  }
  void setCutoff(double hz) {
    const double c = hz < MIN_CUTOFF ? MIN_CUTOFF : (hz > maxCutoff_ ? maxCutoff_ : hz);
    g_ = std::tan((PI * c) / sr_);
    updateCoeffs();
  }
  void setResonance(double r) {
    const double clamped = r < 0.0 ? 0.0 : (r > 1.0 ? 1.0 : r);
    k_ = 2.0 - 1.97 * clamped;
    updateCoeffs();
  }
  void setModeBandpass() { cLp_ = 0.0; cBp_ = 1.0; cHp_ = 0.0; }
  void reset() { ic1_ = 0.0; ic2_ = 0.0; }

  double process(double x) {
    const double v3 = x - ic2_;
    const double v1 = a1_ * ic1_ + a2_ * v3;
    const double v2 = ic2_ + a2_ * ic1_ + a3_ * v3;

    double s1 = v1 + v1 - ic1_;
    double s2 = v2 + v2 - ic2_;
    s1 = softLimit(s1, 3.0, 6.0);
    s2 = softLimit(s2, 3.0, 6.0);
    if (s1 < DENORMAL && s1 > -DENORMAL) s1 = 0.0;
    if (s2 < DENORMAL && s2 > -DENORMAL) s2 = 0.0;
    ic1_ = s1;
    ic2_ = s2;

    const double out = cLp_ * v2 + cBp_ * v1 + cHp_ * (x - k_ * v1 - v2);
    if (!(out > -1e12 && out < 1e12)) {
      reset();
      return 0.0;
    }
    return out;
  }

private:
  void updateCoeffs() {
    a1_ = 1.0 / (1.0 + g_ * (g_ + k_));
    a2_ = g_ * a1_;
    a3_ = g_ * a2_;
  }
  double ic1_ = 0.0, ic2_ = 0.0;
  double a1_ = 0.0, a2_ = 0.0, a3_ = 0.0;
  double g_ = 0.0, k_ = 2.0;
  double cLp_ = 1.0, cBp_ = 0.0, cHp_ = 0.0;
  double sr_, maxCutoff_;
};

}  // namespace magic
}  // namespace sigil
