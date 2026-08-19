// Port of src/dsp/envelope.ts
#pragma once
#include <algorithm>
#include <cmath>

namespace sigil {

/** ADSR with exponential curvature. */
class Envelope {
public:
  enum Stage { kIdle = 0, kAttack = 1, kDecay = 2, kSustain = 3, kRelease = 4 };

  explicit Envelope(double sampleRate) : sr_(sampleRate) { set(5.0, 100.0, 0.7, 200.0); }

  void set(double attackMs, double decayMs, double sustain, double releaseMs) {
    attackCoeff_ = coeff(attackMs);
    decayCoeff_ = coeff(decayMs);
    releaseCoeff_ = coeff(releaseMs);
    sustainLevel_ = sustain < 0.0 ? 0.0 : (sustain > 1.0 ? 1.0 : sustain);
  }

  void trigger() { stage_ = kAttack; }
  void release() { if (stage_ != kIdle) stage_ = kRelease; }
  bool isFinished() const { return stage_ == kIdle; }

  double next() {
    if (stage_ == kAttack) {
      value_ += attackCoeff_ * (1.2 - value_);
      if (value_ >= 1.0) { value_ = 1.0; stage_ = kDecay; }
    } else if (stage_ == kDecay) {
      value_ += decayCoeff_ * (sustainLevel_ - value_);
      if (std::fabs(value_ - sustainLevel_) < 1e-4) {
        value_ = sustainLevel_;
        stage_ = kSustain;
      }
    } else if (stage_ == kRelease) {
      value_ += releaseCoeff_ * (0.0 - value_);
      if (value_ < 1e-5) { value_ = 0.0; stage_ = kIdle; }
    }
    return value_;
  }

private:
  double coeff(double ms) const {
    const double samples = std::max(1.0, (ms / 1000.0) * sr_);
    return 1.0 - std::exp(-1.0 / (samples / 4.0));
  }

  int stage_ = kIdle;
  double value_ = 0.0;
  double attackCoeff_ = 0.0, decayCoeff_ = 0.0, releaseCoeff_ = 0.0;
  double sustainLevel_ = 0.7;
  double sr_;
};

}  // namespace sigil
