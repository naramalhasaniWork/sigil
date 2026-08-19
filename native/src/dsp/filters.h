// Port of src/dsp/filters.ts
//
// The three filter models behind one interface. `LadderFilter` itself lives in
// dsp/ladder.h and is wrapped here so all three models share a call signature;
// the wrapper adds no arithmetic.
//
// Rules from dsp/util.h apply: every value is a double, evaluation order and
// grouping follow the TypeScript exactly, and the denormal / range guards are
// copied literally.
#pragma once

#include "dsp/ladder.h"

namespace sigil {
namespace filters_detail {

constexpr double kDenormal = 1e-20;
constexpr double kMinCutoff = 10.0;
/** Anything past ~0.49 * sr makes tan() explode. */
constexpr double kMaxCutoffRatio = 0.49;
/** Math.PI, spelled out so the constant cannot drift. */
constexpr double kPi = 3.141592653589793;

/**
 * Exactly linear below `knee`, then a quadratic knee to a hard ceiling of
 * `knee + span / 2`.
 */
inline double softLimit(double x, double knee, double span) {
  const double a = x < 0.0 ? -x : x;
  if (a <= knee) return x;
  const double over = a - knee;
  const double lim = over >= span ? knee + span * 0.5
                                  : knee + over * (1.0 - over / (span + span));
  return x < 0.0 ? -lim : lim;
}

/** Diode pairs conduct unevenly: the positive half folds over twice as early. */
inline double asymSat(double x) {
  return x >= 0.0 ? softLimit(x, 0.7, 1.4) : softLimit(x, 1.4, 2.8);
}

}  // namespace filters_detail

class Filter {
public:
  virtual ~Filter() = default;
  virtual void setCutoff(double hz) = 0;
  virtual void setResonance(double r) = 0;
  virtual void reset() = 0;
  virtual double process(double x) = 0;
};

/** 12 dB/oct state-variable filter, TPT form. */
class StateVariableFilter final : public Filter {
public:
  explicit StateVariableFilter(double sampleRate)
      : sr_(sampleRate), maxCutoff_(sampleRate * filters_detail::kMaxCutoffRatio) {
    setCutoff(1000.0);
    setResonance(0.0);
  }

  void setCutoff(double hz) override {
    const double c = hz < filters_detail::kMinCutoff
                         ? filters_detail::kMinCutoff
                         : (hz > maxCutoff_ ? maxCutoff_ : hz);
    g_ = std::tan((filters_detail::kPi * c) / sr_);
    updateCoeffs();
  }

  /** 0 = flat, 1 = a ~30 dB peak that rings for a long time. */
  void setResonance(double r) override {
    const double clamped = r < 0.0 ? 0.0 : (r > 1.0 ? 1.0 : r);
    k_ = 2.0 - 1.97 * clamped;
    updateCoeffs();
  }

  void setMode(int mode) {  // 0 = lp, 1 = bp, 2 = hp
    cLp_ = mode == 0 ? 1.0 : 0.0;
    cBp_ = mode == 1 ? 1.0 : 0.0;
    cHp_ = mode == 2 ? 1.0 : 0.0;
  }

  void reset() override { ic1_ = 0.0; ic2_ = 0.0; }

  double process(double x) override {
    const double v3 = x - ic2_;
    const double v1 = a1_ * ic1_ + a2_ * v3;
    const double v2 = ic2_ + a2_ * ic1_ + a3_ * v3;

    double s1 = v1 + v1 - ic1_;
    double s2 = v2 + v2 - ic2_;
    // Limiting the integrator states (not the feedback) is what bounds
    // self-oscillation: less energy in, never less damping.
    s1 = filters_detail::softLimit(s1, 3.0, 6.0);
    s2 = filters_detail::softLimit(s2, 3.0, 6.0);
    constexpr double D = filters_detail::kDenormal;
    if (s1 < D && s1 > -D) s1 = 0.0;
    if (s2 < D && s2 > -D) s2 = 0.0;
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

/** 24 dB/oct diode-ladder lowpass with an asymmetrically clipping feedback. */
class DiodeFilter final : public Filter {
public:
  explicit DiodeFilter(double sampleRate)
      : sr_(sampleRate), maxCutoff_(sampleRate * filters_detail::kMaxCutoffRatio) {
    setCutoff(1000.0);
    setResonance(0.0);
  }

  void setCutoff(double hz) override {
    const double c = hz < filters_detail::kMinCutoff
                         ? filters_detail::kMinCutoff
                         : (hz > maxCutoff_ ? maxCutoff_ : hz);
    const double g = std::tan((filters_detail::kPi * c) / sr_);
    const double gg = g / (1.0 + g);
    g1_ = gg;
    g2_ = gg * gg;
    g3_ = g2_ * gg;
    g4_ = g3_ * gg;
    oneMinusG_ = 1.0 - gg;
    updateDen();
  }

  /** Past ~0.9 the loop gain passes unity and the filter sings on its own. */
  void setResonance(double r) override {
    const double clamped = r < 0.0 ? 0.0 : (r > 1.0 ? 1.0 : r);
    k_ = 4.5 * clamped;
    updateDen();
  }

  void reset() override { z1_ = z2_ = z3_ = z4_ = 0.0; }

  double process(double x) override {
    const double s1 = oneMinusG_ * z1_;
    const double s2 = oneMinusG_ * z2_;
    const double s3 = oneMinusG_ * z3_;
    const double s4 = oneMinusG_ * z4_;

    // Closed-form solution of the four-pole loop one sample ahead of itself.
    const double sfb = g3_ * s1 + g2_ * s2 + g1_ * s3 + s4;
    const double yLin = (g4_ * x + sfb) * invDen_;
    const double u = x - k_ * filters_detail::asymSat(yLin);

    const double y1 = g1_ * u + s1;
    z1_ = y1 + y1 - z1_;
    const double y2 = g1_ * y1 + s2;
    z2_ = y2 + y2 - z2_;
    const double y3 = g1_ * y2 + s3;
    z3_ = y3 + y3 - z3_;
    const double y4 = g1_ * y3 + s4;
    z4_ = y4 + y4 - z4_;

    constexpr double D = filters_detail::kDenormal;
    if (z1_ < D && z1_ > -D) z1_ = 0.0;
    if (z2_ < D && z2_ > -D) z2_ = 0.0;
    if (z3_ < D && z3_ > -D) z3_ = 0.0;
    if (z4_ < D && z4_ > -D) z4_ = 0.0;

    if (!(y4 > -1e12 && y4 < 1e12)) {
      reset();
      return 0.0;
    }
    return y4;
  }

private:
  void updateDen() { invDen_ = 1.0 / (1.0 + k_ * g4_); }

  double z1_ = 0.0, z2_ = 0.0, z3_ = 0.0, z4_ = 0.0;
  double g1_ = 0.0, g2_ = 0.0, g3_ = 0.0, g4_ = 0.0;
  double oneMinusG_ = 0.0, invDen_ = 1.0, k_ = 0.0;
  double sr_, maxCutoff_;
};

/** `LadderFilter` behind the `Filter` interface. Adds no arithmetic. */
class LadderModel final : public Filter {
public:
  explicit LadderModel(double sampleRate) : f_(sampleRate) {}
  void setCutoff(double hz) override { f_.setCutoff(hz); }
  void setResonance(double r) override { f_.setResonance(r); }
  void reset() override { f_.reset(); }
  double process(double x) override { return f_.process(x); }

private:
  LadderFilter f_;
};

}  // namespace sigil
