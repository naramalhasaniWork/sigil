// Port of src/dsp/physical-voice.ts
//
// Modal resonator bank (20 two-pole sections) driven by a filtered exciter.
// Follows the porting rules at the top of dsp/util.h:
//
//   * Everything the TS holds in a plain field/local is `double`.
//   * a1/a2/b0/y1/y2 and `params` are Float32Array in the TS, so they are
//     `float` here. That rounding is state, not an implementation detail: the
//     resonator's poles are stored at float32 and its history is re-quantised
//     to float32 every sample, while the sum `acc` accumulates the unrounded
//     doubles. Storing the state as double changes the audio.
//   * The three-line xorshift is JS int32 arithmetic (`<<`, `>>>`, `^`), so it
//     runs on int32_t/uint32_t here, not on a double.
//   * The DENORMAL flush (1e-20, once per block over the active modes) and the
//     `acc !== acc` NaN guard are copied literally.
#pragma once

#include <cmath>
#include <cstdint>

#include "dsp/envelope.h"
#include "dsp/ladder.h"
#include "dsp/smoothing.h"
#include "dsp/util.h"

namespace sigil {

namespace physical_detail {

constexpr int kMaxModes = 20;
constexpr int kMaterials = 4;
constexpr int kNumParams = 12;

constexpr int P_MATERIAL = 0;
constexpr int P_STRUCTURE = 1;
constexpr int P_DECAY = 2;
constexpr int P_DAMPING = 3;
constexpr int P_POSITION = 4;
constexpr int P_AIR = 5;
constexpr int P_EXCITER = 6;
constexpr int P_GRIT = 7;
constexpr int P_HARDNESS = 8;
constexpr int P_TONE = 9;
constexpr int P_RELEASE = 10;
constexpr int P_LEVEL = 11;

constexpr int EX_MALLET = 0;
constexpr int EX_NOISE = 1;
constexpr int EX_BOW = 2;

constexpr double kDenormal = 1e-20;
/** Poles are always inside the unit circle, so the bank can never run away. */
constexpr double kRMax = 0.99997;
constexpr double kLn1000 = 6.907755278982137;
constexpr double kTwoPi = 6.283185307179586;
constexpr double kPi = 3.141592653589793;

/** Frequency ratios of the ringing modes, 20 per material. Float32Array in TS. */
inline const float* ratios() {
  static const float kRatios[kMaterials * kMaxModes] = {
      // membrane
      1.0f, 1.593f, 2.135f, 2.295f, 2.653f, 2.917f, 3.155f, 3.5f, 3.598f, 3.652f,
      3.965f, 4.06f, 4.23f, 4.372f, 4.601f, 4.831f, 4.903f, 5.084f, 5.242f, 5.412f,
      // wood
      1.0f, 2.9f, 5.8f, 8.9f, 12.4f, 15.9f, 19.8f, 23.6f, 27.9f, 32.1f,
      36.7f, 41.3f, 46.3f, 51.3f, 56.6f, 62.0f, 67.6f, 73.4f, 79.3f, 85.4f,
      // metal
      1.0f, 2.0f, 2.4f, 3.0f, 3.61f, 4.17f, 5.43f, 6.8f, 8.21f, 9.75f,
      11.4f, 13.2f, 15.1f, 17.2f, 19.4f, 21.7f, 24.2f, 26.8f, 29.5f, 32.4f,
      // glass
      1.0f, 2.01f, 3.03f, 4.06f, 5.11f, 6.17f, 7.25f, 8.35f, 9.47f, 10.6f,
      11.8f, 13.0f, 14.2f, 15.5f, 16.8f, 18.1f, 19.5f, 20.9f, 22.3f, 23.8f,
  };
  return kRatios;
}
inline const float* ampTilt() {
  static const float v[kMaterials] = {0.8f, 1.15f, 0.55f, 0.45f};
  return v;
}
inline const float* decayTilt() {
  static const float v[kMaterials] = {1.2f, 1.7f, 0.55f, 0.35f};
  return v;
}
inline const float* decayScale() {
  static const float v[kMaterials] = {0.55f, 0.28f, 1.25f, 1.5f};
  return v;
}

/** Descriptor defaults, in descriptor order. */
inline const double* defaults() {
  static const double v[kNumParams] = {0.62, 0.25, 900.0, 0.35, 0.28, 0.55,
                                       0.0,  0.4,  3.0,   4500.0, 120.0, 0.75};
  return v;
}

/** TS clamp(): NaN falls through to `lo`, matching `x === x ? x : lo`. */
inline double clamp(double x, double lo, double hi) {
  return x < lo ? lo : (x > hi ? hi : (x == x ? x : lo));
}

}  // namespace physical_detail

class PhysicalVoice {
public:
  explicit PhysicalVoice(double sampleRate)
      : sr_(sampleRate),
        excEnv_(sampleRate),
        excFilter_(sampleRate),
        driveSmooth_(sampleRate, 12.0) {
    namespace pd = physical_detail;
    for (int i = 0; i < pd::kMaxModes; ++i) {
      a1_[i] = a2_[i] = b0_[i] = y1_[i] = y2_[i] = 0.0f;
    }
    for (int i = 0; i < pd::kNumParams; ++i) {
      params_[i] = static_cast<float>(pd::defaults()[i]);
    }
    applyExciter();
  }

  void setParam(int index, double value) {
    namespace pd = physical_detail;
    if (index < 0 || index >= pd::kNumParams) return;
    params_[index] = static_cast<float>(value);
    dirty_ = true;
    if (index == pd::P_EXCITER || index == pd::P_HARDNESS || index == pd::P_RELEASE) {
      applyExciter();
    }
  }

  void noteOn(double freq, double velocity, int voiceIndex) {
    namespace pd = physical_detail;
    baseFreq_ = pd::clamp(freq, 8.0, sr_ * 0.4);
    velocity_ = pd::clamp(velocity, 0.0, 1.0);
    active_ = true;
    dirty_ = true;
    needsSnap_ = true;
    quietBlocks_ = 0;
    rng_ = static_cast<std::int32_t>(22222 + voiceIndex * 7919);
    resetModes();
    excFilter_.reset();
    applyExciter();
    excEnv_.trigger();
  }

  void noteOff() { excEnv_.release(); }

  bool isFinished() const { return active_ && quietBlocks_ >= 3; }

  /** ADDS into `out`, exactly as the TS does. */
  void render(float* out, int offset, int count) {
    namespace pd = physical_detail;
    if (!active_) return;
    if (dirty_) updateModes();

    float* a1 = a1_;
    float* a2 = a2_;
    float* b0 = b0_;
    float* y1 = y1_;
    float* y2 = y2_;
    const int n = activeModes_;

    const int type = static_cast<int>(jsRound(pd::clamp(params_[pd::P_EXCITER], 0.0, 2.0)));
    const double grit = pd::clamp(params_[pd::P_GRIT], 0.0, 1.0);
    const double air = pd::clamp(params_[pd::P_AIR], 0.0, 1.0);
    const double tone = pd::clamp(params_[pd::P_TONE], 200.0, 16000.0);
    const double dc = type == pd::EX_MALLET ? 1.0 : (type == pd::EX_NOISE ? 0.2 : 0.0);
    const double noiseAmt = type == pd::EX_MALLET ? grit * 0.7 : 1.0;
    // A longer contact pumps proportionally more energy in, so hardness would
    // otherwise double as a volume knob.
    const double rootTau =
        std::sqrt((pd::clamp(params_[pd::P_HARDNESS], 0.2, 80.0) * sr_) / 4000.0);
    const double drive = type == pd::EX_BOW
                             ? bowScale_
                             : (type == pd::EX_NOISE ? 2.2 / (1.0 + 0.35 * rootTau)
                                                     : 1.6 / (1.0 + 0.9 * rootTau));
    const double level = pd::clamp(params_[pd::P_LEVEL], 0.0, 1.0) * velocity_ * 0.34;

    excFilter_.setCutoff(tone * (0.35 + 1.2 * grit) * (0.55 + air));
    excFilter_.setResonance(grit * 0.25);
    driveSmooth_.setTarget(drive);
    if (needsSnap_) {
      driveSmooth_.snap(drive);
      needsSnap_ = false;
    }

    std::int32_t rs = rng_;
    double peak = 0.0;
    double excPeak = 0.0;
    for (int i = 0; i < count; ++i) {
      // JS: rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;  (all int32)
      rs ^= static_cast<std::int32_t>(static_cast<std::uint32_t>(rs) << 13);
      rs ^= static_cast<std::int32_t>(static_cast<std::uint32_t>(rs) >> 17);
      rs ^= static_cast<std::int32_t>(static_cast<std::uint32_t>(rs) << 5);
      const double noise = static_cast<double>(rs) * 4.656612873077393e-10;

      const double e = excEnv_.next();
      if (e > excPeak) excPeak = e;
      // Sequenced by hand: the TS evaluates process() before next(), and both
      // advance state. C++ operand order for `a * b` is unspecified.
      const double filtered = excFilter_.process((dc + noiseAmt * noise) * e);
      const double x = filtered * driveSmooth_.next();

      double acc = 0.0;
      for (int m = 0; m < n; ++m) {
        const double y = static_cast<double>(b0[m]) * x +
                         static_cast<double>(a1[m]) * static_cast<double>(y1[m]) +
                         static_cast<double>(a2[m]) * static_cast<double>(y2[m]);
        y2[m] = y1[m];
        y1[m] = static_cast<float>(y);
        acc += y;
      }
      if (acc != acc) {
        resetModes();
        acc = 0.0;
      }
      const double mag = acc < 0.0 ? -acc : acc;
      if (mag > peak) peak = mag;

      const double v = std::tanh(acc * level) * 0.9;
      out[offset + i] = static_cast<float>(static_cast<double>(out[offset + i]) + v);
    }

    // Denormal state costs hundreds of cycles per sample on x86, so the whole
    // bank is flushed to true zero once a block rather than sample by sample.
    for (int m = 0; m < n; ++m) {
      if (y1[m] < pd::kDenormal && y1[m] > -pd::kDenormal) y1[m] = 0.0f;
      if (y2[m] < pd::kDenormal && y2[m] > -pd::kDenormal) y2[m] = 0.0f;
    }

    rng_ = rs;
    if (peak < 1e-4 && excPeak < 1e-4) quietBlocks_++;
    else quietBlocks_ = 0;
  }

private:
  void applyExciter() {
    namespace pd = physical_detail;
    const int type = static_cast<int>(jsRound(pd::clamp(params_[pd::P_EXCITER], 0.0, 2.0)));
    const double hard = pd::clamp(params_[pd::P_HARDNESS], 0.2, 80.0);
    const double rel = pd::clamp(params_[pd::P_RELEASE], 5.0, 2000.0);
    if (type == pd::EX_BOW) {
      excEnv_.set(8.0 + hard * 3.0, 60.0, 1.0, rel);
    } else if (type == pd::EX_NOISE) {
      excEnv_.set(0.5 + hard * 0.4, hard * 2.5, 0.0, hard);
    } else {
      excEnv_.set(0.2 + hard * 0.3, hard, 0.0, hard);
    }
  }

  /** Recomputes the whole modal bank. Never runs inside the sample loop. */
  void updateModes() {
    namespace pd = physical_detail;
    dirty_ = false;
    const double morph = pd::clamp(params_[pd::P_MATERIAL], 0.0, 1.0) * (pd::kMaterials - 1);
    int i0 = static_cast<int>(std::floor(morph));
    if (i0 > pd::kMaterials - 2) i0 = pd::kMaterials - 2;
    if (i0 < 0) i0 = 0;
    const double f = morph - i0;
    const int o0 = i0 * pd::kMaxModes;
    const int o1 = o0 + pd::kMaxModes;
    const float* RAT = pd::ratios();
    // Every Float32Array read is a double in JS, so each difference below is a
    // DOUBLE subtraction. Written as float-float it would round to float first.
    const double at0 = pd::ampTilt()[i0], at1 = pd::ampTilt()[i0 + 1];
    const double dt0 = pd::decayTilt()[i0], dt1 = pd::decayTilt()[i0 + 1];
    const double ds0 = pd::decayScale()[i0], ds1 = pd::decayScale()[i0 + 1];
    const double ampTilt = at0 + (at1 - at0) * f;
    const double decTilt = dt0 + (dt1 - dt0) * f;
    const double decScale = ds0 + (ds1 - ds0) * f;

    const double stretch = pd::clamp(params_[pd::P_STRUCTURE], 0.0, 1.0);
    const double damping = pd::clamp(params_[pd::P_DAMPING], 0.0, 1.0);
    const double air = pd::clamp(params_[pd::P_AIR], 0.0, 1.0);
    const double pos = pd::clamp(params_[pd::P_POSITION], 0.02, 0.98);
    const double t60 = (pd::clamp(params_[pd::P_DECAY], 20.0, 3000.0) / 1000.0) *
                       (1.0 - 0.55 * damping);
    const double decayExp = decTilt + damping * 1.6;
    const double ampExp = (air - 0.5) * 1.4;
    const double nyquist = sr_ * 0.47;
    const double wScale = pd::kTwoPi / sr_;
    int want = static_cast<int>(3.0 + jsRound(air * (pd::kMaxModes - 3)));
    if (want > pd::kMaxModes) want = pd::kMaxModes;

    int count = 0;
    double gainSum = 0.0;
    double noisePower = 0.0;
    for (int k = 0; k < want; ++k) {
      const double base = static_cast<double>(RAT[o0 + k]) +
                          (static_cast<double>(RAT[o1 + k]) - static_cast<double>(RAT[o0 + k])) * f;
      const double ratio = base * (1.0 + stretch * 0.05 * (base - 1.0));
      const double freq = baseFreq_ * ratio;
      if (freq >= nyquist || freq < 5.0) break;
      const double w = freq * wScale;
      const double t60k = pd::clamp(t60 * decScale * std::pow(ratio, -decayExp), 0.002, 8.0);
      double r = std::exp(-pd::kLn1000 / (t60k * sr_));
      if (!(r > 0.0)) r = 0.0;
      if (r > pd::kRMax) r = pd::kRMax;
      const double gain = std::pow(static_cast<double>(k) + 1.0, -ampTilt) *
                          std::pow(ratio, ampExp) *
                          (0.12 + 0.88 * std::fabs(std::sin(pd::kPi * pos * ratio)));
      a1_[k] = static_cast<float>(2.0 * r * std::cos(w));
      a2_[k] = static_cast<float>(-r * r);
      b0_[k] = static_cast<float>(gain * std::sin(w));
      gainSum += gain;
      noisePower += (gain * gain) / (4.0 * (1.0 - r));
      count = k + 1;
    }

    // More modes share the same total drive, so the sum of their peaks stays
    // roughly level as Air opens the bank up.
    const double norm = (1.2 * std::sqrt((static_cast<double>(count) + 1.0) / 8.0)) /
                        (0.001 + gainSum);
    for (int k = 0; k < count; ++k) b0_[k] = static_cast<float>(static_cast<double>(b0_[k]) * norm);
    for (int k = count; k < pd::kMaxModes; ++k) {
      b0_[k] = 0.0f;
      y1_[k] = 0.0f;
      y2_[k] = 0.0f;
    }
    activeModes_ = count;
    // Bounds continuous (bowed) excitation: predicted steady output stays < 1
    // however lightly damped the bank is, so it can never build up forever.
    bowScale_ = 1.8 / (0.05 + norm * std::sqrt(noisePower));
  }

  void resetModes() {
    for (int k = 0; k < physical_detail::kMaxModes; ++k) {
      y1_[k] = 0.0f;
      y2_[k] = 0.0f;
    }
  }

  float a1_[physical_detail::kMaxModes];
  float a2_[physical_detail::kMaxModes];
  float b0_[physical_detail::kMaxModes];
  float y1_[physical_detail::kMaxModes];
  float y2_[physical_detail::kMaxModes];
  float params_[physical_detail::kNumParams];

  double sr_;
  Envelope excEnv_;
  LadderFilter excFilter_;
  Smoother driveSmooth_;

  int activeModes_ = 0;
  double bowScale_ = 1.0;
  double baseFreq_ = 220.0;
  double velocity_ = 1.0;
  bool active_ = false;
  bool dirty_ = true;
  bool needsSnap_ = true;
  int quietBlocks_ = 0;
  std::int32_t rng_ = 22222;
};

}  // namespace sigil
