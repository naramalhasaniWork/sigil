// Port of src/dsp/fm-voice.ts  (four-operator FM, DX7 lineage).
//
// Follows the five rules at the top of dsp/util.h. The two that shape this
// file:
//
//   * A JS `number` is a double. The TypeScript keeps `params`, `inc`, `level`
//     and `carrierGain` in Float32Array, so those four - and only those four -
//     are `float` here. That rounding is audible state: `balance` default 0.45
//     is 0.44999998807907104 once it has been through a Float32Array, and the
//     carrier gains are computed from it.
//   * Same order, same grouping. No reassociation anywhere, in particular in
//     the algorithm branches and in `carrierGain`.
//
// The denormal flush on the feedback pair and the `s === s` NaN guard on the
// output store are copied literally, including the comparison directions.
#pragma once

#include <cmath>
#include <cstdint>

#include "dsp/envelope.h"
#include "dsp/smoothing.h"
#include "dsp/util.h"

namespace sigil {

namespace fm {

constexpr int kPAlgo = 0;
constexpr int kPOpBase = 1;
constexpr int kPOpStride = 3;
constexpr int kPIndex = 13;
constexpr int kPKeyScale = 14;
constexpr int kPFeedback = 15;
constexpr int kPSpread = 16;
constexpr int kPBalance = 17;
constexpr int kPAmpA = 18;
constexpr int kPModA = 22;
constexpr int kPEnvLast = 25;
constexpr int kPVelIndex = 26;

constexpr int kNumOps = 4;
constexpr int kMaxAlgo = 4;
constexpr int kNumParams = 27;

/** Bit k set = operator k+1 is a carrier, per algorithm. (Uint8Array) */
constexpr std::uint8_t kCarrierMask[5] = {0x1, 0x1, 0x5, 0xF, 0x3};

/** Fixed detune pattern in semitones, scaled by Spread. (Float32Array) */
constexpr float kSpreadSemis[kNumOps] = {0.0f, 0.035f, -0.026f, 0.061f};

/** FM_DESCRIPTOR defaults, by index. Order is load-bearing - fm-voice.ts
 *  indexes the descriptor table by position. */
constexpr float kDefaults[kNumParams] = {
    2.0f,                     // algorithm
    1.0f, 0.0f, 1.0f,         // op1 ratio/fine/level
    2.0f, 0.0f, 0.75f,        // op2
    1.0f, 0.0f, 0.9f,         // op3
    3.0f, 0.0f, 0.7f,         // op4
    3.0f,                     // index
    0.6f,                     // key-scale
    0.15f,                    // feedback
    0.2f,                     // spread
    0.45f,                    // balance
    3.0f, 700.0f, 0.55f, 400.0f,   // carrier envelope A/D/S/R
    1.0f, 400.0f, 0.3f, 300.0f,    // modulator envelope A/D/S/R
    0.0f,                     // vel-index (Touch) - appended, stays last
};

/** Hard-bounded soft clipper; cannot exceed 1, which is what keeps the
 *  feedback operator from running away. */
inline double softClip(double x) { return x / (1.0 + (x < 0.0 ? -x : x)); }

/** DX7-style coarse ratios: a half-speed setting plus the whole numbers. */
inline double quantizeRatio(double v) {
  if (v < 0.75) return 0.5;
  const double r = jsRound(v);
  return r < 1.0 ? 1.0 : (r > 16.0 ? 16.0 : r);
}

}  // namespace fm

class FmVoice {
public:
  static constexpr double kTau = 3.14159265358979311599796346854 * 2.0;  // Math.PI * 2
  static constexpr double kDenorm = 1e-20;
  static constexpr double kRefHz = 261.6256;

  explicit FmVoice(double sampleRate)
      : envA_(sampleRate), envB_(sampleRate), envC_(sampleRate), envD_(sampleRate),
        indexSmooth_(sampleRate, 12.0), fbSmooth_(sampleRate, 12.0),
        levelSmooth_{Smoother(sampleRate, 8.0), Smoother(sampleRate, 8.0),
                     Smoother(sampleRate, 8.0), Smoother(sampleRate, 8.0)},
        gainSmooth_{Smoother(sampleRate, 8.0), Smoother(sampleRate, 8.0),
                    Smoother(sampleRate, 8.0), Smoother(sampleRate, 8.0)},
        sr_(sampleRate) {
    for (int i = 0; i < fm::kNumParams; ++i) params_[i] = fm::kDefaults[i];
    applyRouting();
    indexSmooth_.snap(static_cast<double>(params_[fm::kPIndex]));
    fbSmooth_.snap(static_cast<double>(params_[fm::kPFeedback]));
    snapGains();
  }

  void setParam(int index, double value) {
    if (index < 0 || index >= fm::kNumParams) return;
    params_[index] = static_cast<float>(value);
    if (index == fm::kPAlgo) applyRouting();
    else if (index >= fm::kPAmpA && index <= fm::kPEnvLast) applyEnvelopes();
  }

  void noteOn(double freq, double velocity, int voiceIndex) {
    baseFreq_ = freq > 1.0 ? freq : 1.0;
    velocity_ = velocity;
    active_ = true;
    const double off = std::fmod(static_cast<double>(voiceIndex) * 0.113, 1.0);
    ph0_ = off;
    ph1_ = std::fmod(off + 0.017, 1.0);
    ph2_ = std::fmod(off + 0.041, 1.0);
    ph3_ = std::fmod(off + 0.073, 1.0);
    fbZ1_ = 0.0;
    fbZ2_ = 0.0;
    applyRouting();
    envA_.trigger();
    envB_.trigger();
    envC_.trigger();
    envD_.trigger();
    indexSmooth_.snap(static_cast<double>(params_[fm::kPIndex]));
    fbSmooth_.snap(static_cast<double>(params_[fm::kPFeedback]));
    snapGains();
  }

  void noteOff() {
    envA_.release();
    envB_.release();
    envC_.release();
    envD_.release();
  }

  /** Finished once every CARRIER envelope has run out; modulators make no
   *  sound of their own and so do not hold the voice open. */
  bool isFinished() const {
    if (!active_) return false;
    const int m = carrierMask_;
    if ((m & 1) != 0 && !envA_.isFinished()) return false;
    if ((m & 2) != 0 && !envB_.isFinished()) return false;
    if ((m & 4) != 0 && !envC_.isFinished()) return false;
    if ((m & 8) != 0 && !envD_.isFinished()) return false;
    return true;
  }

  /** ADDS into out, exactly as the TypeScript does. No allocation. */
  void render(float* out, int offset, int count) {
    if (!active_) return;
    updateBlock();

    const double i0 = static_cast<double>(inc_[0]);
    const double i1 = static_cast<double>(inc_[1]);
    const double i2 = static_cast<double>(inc_[2]);
    const double i3 = static_cast<double>(inc_[3]);
    Smoother* ls = levelSmooth_;
    Smoother* gs = gainSmooth_;
    const int algo = algo_;
    const double ks = keyScale_ * velIndexScale_;
    const double amp = velocity_ * 0.32;

    indexSmooth_.setTarget(static_cast<double>(params_[fm::kPIndex]));
    fbSmooth_.setTarget(static_cast<double>(params_[fm::kPFeedback]));
    ls[0].setTarget(static_cast<double>(level_[0])); gs[0].setTarget(static_cast<double>(carrierGain_[0]));
    ls[1].setTarget(static_cast<double>(level_[1])); gs[1].setTarget(static_cast<double>(carrierGain_[1]));
    ls[2].setTarget(static_cast<double>(level_[2])); gs[2].setTarget(static_cast<double>(carrierGain_[2]));
    ls[3].setTarget(static_cast<double>(level_[3])); gs[3].setTarget(static_cast<double>(carrierGain_[3]));

    for (int n = 0; n < count; ++n) {
      const double e0 = envA_.next();
      const double e1 = envB_.next();
      const double e2 = envC_.next();
      const double e3 = envD_.next();
      const double index = indexSmooth_.next() * ks;
      const double l0 = ls[0].next(); const double l1 = ls[1].next();
      const double l2 = ls[2].next(); const double l3 = ls[3].next();
      const double g0 = gs[0].next(); const double g1 = gs[1].next();
      const double g2 = gs[2].next(); const double g3 = gs[3].next();

      ph0_ += i0; if (ph0_ >= 1.0) ph0_ -= 1.0;
      ph1_ += i1; if (ph1_ >= 1.0) ph1_ -= 1.0;
      ph2_ += i2; if (ph2_ >= 1.0) ph2_ -= 1.0;
      ph3_ += i3; if (ph3_ >= 1.0) ph3_ -= 1.0;

      const double fbArg = fm::softClip((fbZ1_ + fbZ2_) * 0.5) * fbSmooth_.next() * kPi;
      const double m3 = std::sin(ph3_ * kTau + fbArg) * l3 * e3;
      fbZ2_ = (fbZ1_ < kDenorm && fbZ1_ > -kDenorm) ? 0.0 : fbZ1_;
      fbZ1_ = (m3 < kDenorm && m3 > -kDenorm) ? 0.0 : m3;

      double y = 0.0;
      // Review finding 2026-08-18 (carried across from the TS): operator 4 was
      // computed every sample but never READ in algos 0/1, and `index` was
      // absent from algo 3. Every algorithm now routes both.
      if (algo == 0) {
        // 2-stack, with op4 shading the modulator: op4 -> op2 -> op1
        const double m1 = std::sin(ph1_ * kTau + m3 * index) * l1 * e1 * index;
        y = std::sin(ph0_ * kTau + m1) * l0 * e0 * g0;
      } else if (algo == 1) {
        // 3-stack: op4 -> op3 -> op2 -> op1
        const double m2 = std::sin(ph2_ * kTau + m3 * index) * l2 * e2 * index;
        const double m1 = std::sin(ph1_ * kTau + m2) * l1 * e1 * index;
        y = std::sin(ph0_ * kTau + m1) * l0 * e0 * g0;
      } else if (algo == 2) {
        const double m1 = std::sin(ph1_ * kTau) * l1 * e1 * index;
        y = std::sin(ph0_ * kTau + m1) * l0 * e0 * g0
          + std::sin(ph2_ * kTau + m3 * index) * l2 * e2 * g2;
      } else if (algo == 3) {
        // Parallel carriers, all shaded by op4 scaled by index.
        const double shade = m3 * index * 0.5;
        y = std::sin(ph0_ * kTau + shade) * l0 * e0 * g0
          + std::sin(ph1_ * kTau + shade * 1.4) * l1 * e1 * g1
          + std::sin(ph2_ * kTau + shade * 0.7) * l2 * e2 * g2
          + m3 * g3;
      } else {
        const double m2 = std::sin(ph2_ * kTau) * l2 * e2 * index;
        y = std::sin(ph0_ * kTau + m2) * l0 * e0 * g0
          + std::sin(ph1_ * kTau + m3 * index) * l1 * e1 * g1;
      }

      const double s = y * amp;
      out[offset + n] = static_cast<float>(static_cast<double>(out[offset + n])
                                           + (s == s ? s : 0.0));
    }
  }

private:
  static constexpr double kPi = 3.14159265358979311599796346854;

  void applyRouting() {
    const double raw = static_cast<double>(params_[fm::kPAlgo]);
    const double q = raw < 0.0 ? 0.0
                   : (raw > static_cast<double>(fm::kMaxAlgo) ? static_cast<double>(fm::kMaxAlgo)
                                                              : jsRound(raw));
    algo_ = static_cast<int>(q);
    carrierMask_ = static_cast<int>(fm::kCarrierMask[algo_]);
    applyEnvelopes();
  }

  /** Carriers follow the amp ADSR, modulators the brightness ADSR. */
  void configure(Envelope& env, int bit) {
    const int base = (carrierMask_ & bit) != 0 ? fm::kPAmpA : fm::kPModA;
    env.set(static_cast<double>(params_[base]),
            static_cast<double>(params_[base + 1]),
            static_cast<double>(params_[base + 2]),
            static_cast<double>(params_[base + 3]));
  }

  void applyEnvelopes() {
    configure(envA_, 1);
    configure(envB_, 2);
    configure(envC_, 4);
    configure(envD_, 8);
  }

  /** Block-rate work: operator increments, levels, carrier balance, key scaling. */
  void updateBlock() {
    const double spread = static_cast<double>(params_[fm::kPSpread]);
    for (int k = 0; k < fm::kNumOps; ++k) {
      const int b = fm::kPOpBase + k * fm::kPOpStride;
      const double ratio = fm::quantizeRatio(static_cast<double>(params_[b]));
      const double semis = static_cast<double>(params_[b + 1])
                         + static_cast<double>(fm::kSpreadSemis[k]) * spread;
      const double f = (baseFreq_ * ratio * std::pow(2.0, semis / 12.0)) / sr_;
      inc_[k] = static_cast<float>(f > 0.45 ? 0.45 : f);
      level_[k] = params_[b + 2];
    }

    const double ks = std::pow(kRefHz / baseFreq_, static_cast<double>(params_[fm::kPKeyScale]));
    keyScale_ = ks < 0.15 ? 0.15 : (ks > 2.5 ? 2.5 : ks);

    // Velocity into brightness (Touch). Scales the patch's Index DOWN as
    // velocity falls, squared so the opening is weighted into the top of the
    // range. At amount 0 this is exactly 1.0 and the old signal path is
    // bit-identical - the multiply in render() is by exactly one.
    const double vel = velocity_ < 0.0 ? 0.0 : (velocity_ > 1.0 ? 1.0 : velocity_);
    velIndexScale_ = 1.0 - static_cast<double>(params_[fm::kPVelIndex]) * (1.0 - vel * vel);

    const int mask = carrierMask_;
    int n = 0;
    for (int k = 0; k < fm::kNumOps; ++k) if ((mask & (1 << k)) != 0) n++;
    const double tilt = static_cast<double>(params_[fm::kPBalance]);
    int rank = 0;
    for (int k = 0; k < fm::kNumOps; ++k) {
      if ((mask & (1 << k)) == 0) {
        carrierGain_[k] = 0.0f;
        continue;
      }
      const double p = n > 1 ? static_cast<double>(rank) / static_cast<double>(n - 1) : 0.0;
      carrierGain_[k] = static_cast<float>((1.0 - tilt) * (1.0 - 0.85 * p)
                                           + tilt * (0.15 + 0.85 * p));
      rank++;
    }
  }

  /** A fresh note snaps levels and balance so it starts at its target instead
   *  of gliding in from a stolen voice's stale state. */
  void snapGains() {
    updateBlock();
    Smoother* ls = levelSmooth_;
    Smoother* gs = gainSmooth_;
    ls[0].snap(static_cast<double>(level_[0])); gs[0].snap(static_cast<double>(carrierGain_[0]));
    ls[1].snap(static_cast<double>(level_[1])); gs[1].snap(static_cast<double>(carrierGain_[1]));
    ls[2].snap(static_cast<double>(level_[2])); gs[2].snap(static_cast<double>(carrierGain_[2]));
    ls[3].snap(static_cast<double>(level_[3])); gs[3].snap(static_cast<double>(carrierGain_[3]));
  }

  float params_[fm::kNumParams] = {0.0f};   // Float32Array in the TS
  float inc_[fm::kNumOps] = {0.0f};         // Float32Array
  float level_[fm::kNumOps] = {0.0f};       // Float32Array
  float carrierGain_[fm::kNumOps] = {0.0f}; // Float32Array

  Envelope envA_, envB_, envC_, envD_;
  Smoother indexSmooth_, fbSmooth_;
  Smoother levelSmooth_[fm::kNumOps];
  Smoother gainSmooth_[fm::kNumOps];

  double sr_;
  double baseFreq_ = 220.0;
  double velocity_ = 1.0;
  bool active_ = false;
  int algo_ = 0;
  int carrierMask_ = 1;
  double keyScale_ = 1.0;
  double velIndexScale_ = 1.0;

  double ph0_ = 0.0, ph1_ = 0.0, ph2_ = 0.0, ph3_ = 0.0;
  double fbZ1_ = 0.0, fbZ2_ = 0.0;
};

}  // namespace sigil
