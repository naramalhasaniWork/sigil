// Port of src/dsp/fx.ts - the master FX chain.
//
//   drive -> bitcrush -> chorus -> delay -> reverb -> trim -> safety limiter
//
// PORTING NOTES that decide whether this matches:
//
//  * `v` and `target` are Float32Arrays in the TypeScript. Every smoothed
//    parameter is therefore rounded to single precision before the DSP sees
//    it, and so is every setParam target. They are float[] here for that
//    reason. The Smoother's own state is a plain `number` and stays double.
//  * Chorus.phase is a Float32Array too, but the value USED within a sample is
//    the un-rounded local `ph`; only what carries to the next sample rounds.
//    Both must be reproduced, and they are not the same number.
//  * process()/processStereo() step every Smoother once in gate() AND once per
//    sample, so a block of n samples advances them n+1 times. That is the
//    reference behaviour; the goldens encode it, block sizes included.
//  * The buffer is a Float32Array: reading rounds nothing (it is already f32)
//    but every store back rounds, and the chain is fed its own output across
//    block boundaries only through its internal state, not the buffer.
//  * The bit-exact bypasses (drive at 0, crush transparent, limiter below the
//    knee, chorus/delay/reverb gated off) are load-bearing: the TS has tests
//    asserting the default chain is bit-transparent, so this port must be too.
#pragma once

#include <cmath>
#include <string>
#include <vector>

#include "dsp/fx_core.h"
#include "dsp/smoothing.h"
#include "fx-chain-params.h"
#include "fx-chain-reverb.h"
#include "fx-chain-units.h"

namespace sigil {
namespace fxchain {

using sigil::fx::flush;
using sigil::fx::glueOut;
using sigil::fx::limitOut;
using sigil::fx::onePole;
using sigil::fx::sat;

constexpr double DRIVE_REF = 0.35, DRIVE_MAX_G = 24;
constexpr double TILT_HZ = 900, TILT_AMOUNT = 0.9;
/** Bits mapped from a full 16: 2^(16-1). At or above this the quantiser is a
 *  no-op worth skipping rather than a subtle noise floor worth keeping. */
constexpr double CRUSH_TRANSPARENT = 32768;
/** Below this a mix is inaudible, so the unit is skipped outright. */
constexpr double SILENT = 1e-4;

class FxChain {
public:
  explicit FxChain(double sampleRate)
      : sr_(sampleRate), chorus_(sampleRate), delay_(sampleRate),
        reverb_(sampleRate, def(P_RV_SIZE), def(P_RV_DECAY)) {
    sm_.reserve(N_PARAMS);
    for (int i = 0; i < N_PARAMS; i++) sm_.emplace_back(sampleRate, kSmoothMs[i]);
    tiltC_ = onePole(TILT_HZ, sampleRate);
    for (int i = 0; i < N_PARAMS; i++) setParam(i, def(i));
    reset();
  }

  void setParam(int index, double value) {
    if (index < 0 || index >= N_PARAMS) return;
    const double dsp = toDsp(index, value);
    target_[index] = static_cast<float>(dsp);
    sm_[static_cast<size_t>(index)].setTarget(dsp);
    if (index == P_RV_SIZE) sizeRaw_ = value;
    else if (index == P_RV_DECAY) decayRaw_ = value;
    else return;
    reverb_.setDecay(sizeRaw_, decayRaw_);
  }

  /** Clears every buffer and snaps all smoothers. */
  void reset() {
    tilt_ = 0.0; held_ = 0.0; acc_ = 0.0;
    for (int i = 0; i < N_PARAMS; i++) {
      const double t = target_[i];
      sm_[static_cast<size_t>(i)].snap(t);
      v_[i] = static_cast<float>(t);
    }
    chorus_.reset(); delay_.reset(); reverb_.reset();
  }

  void process(float* buffer, int count) {
    gate();
    const bool onChorus = onChorus_, onDelay = onDelay_, onReverb = onReverb_;
    for (int n = 0; n < count; n++) {
      step();
      double x = front(buffer[n], v_);
      if (onChorus) x = chorus_.process(x, v_);
      if (onDelay) x = delay_.process(x, v_);
      if (onReverb) x = reverb_.process(x, v_);
      // Trim first, exactly as the old always-on stage was driven; the limiter
      // stays behind the glue, so glue 0 is `limitOut(x * trim)` untouched.
      const double t = x * static_cast<double>(v_[P_TRIM]);
      const double glue = static_cast<double>(v_[P_GLUE]);
      x = limitOut(glue > 0.0 ? glueOut(t, glue) : t);
      buffer[n] = static_cast<float>(x == x ? x : 0.0);
    }
  }

  /** The stereo entry point. Width lives here, not in the oscillators. */
  void processStereo(float* left, float* right, int count) {
    gate();
    const bool onChorus = onChorus_, onDelay = onDelay_, onReverb = onReverb_;
    for (int n = 0; n < count; n++) {
      step();
      const double li = left[n], ri = right[n];
      const double mid = front((li + ri) * 0.5, v_);
      const double side = (li - ri) * 0.5;
      double l = mid + side, r = mid - side;
      if (onChorus) { chorus_.processStereo(l, r, v_); l = chorus_.oL; r = chorus_.oR; }
      if (onDelay) { delay_.processStereo(l, r, v_); l = delay_.oL; r = delay_.oR; }
      if (onReverb) { reverb_.processStereo(l, r, v_); l = reverb_.oL; r = reverb_.oR; }
      const double trim = v_[P_TRIM];
      const double glue = v_[P_GLUE];
      const double tl = l * trim, tr = r * trim;
      l = limitOut(glue > 0.0 ? glueOut(tl, glue) : tl);
      r = limitOut(glue > 0.0 ? glueOut(tr, glue) : tr);
      left[n] = static_cast<float>(l == l ? l : 0.0);
      right[n] = static_cast<float>(r == r ? r : 0.0);
    }
  }

private:
  /** Descriptor units in, DSP units out. Every exp and pow lives here. */
  double toDsp(int i, double v) const {
    if (i == P_DRIVE) return v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v);
    if (i == P_DRIVE_TONE) return (v * 2.0 - 1.0) * TILT_AMOUNT;
    if (i == P_CRUSH_RATE) return 1.0 / (1.0 + v * 63.0);
    if (i == P_CRUSH_BITS) return std::pow(2.0, v - 1.0);
    if (i == P_CH_RATE) return v / sr_;
    if (i == P_DL_TIME || i == P_RV_PREDELAY) return (v * sr_) / 1000.0;
    if (i == P_DL_FB) return v * DL_FB_MAX;
    if (i == P_DL_TONE) return onePole(v, sr_);
    if (i == P_RV_DAMP) return 1.0 - 0.985 * v * v;
    if (i == P_TRIM) return std::pow(10.0, v / 20.0);
    return v;
  }

  /** Chorus, delay and reverb are skipped when their mix is silent. Re-enabling
   *  resets the unit, because its delay lines still hold audio from before the
   *  bypass and fading that in would burst stale sound. */
  void gate() {
    for (int i = 0; i < N_PARAMS; i++) v_[i] = static_cast<float>(sm_[static_cast<size_t>(i)].next());
    onChorus_ = static_cast<double>(v_[P_CH_MIX]) > SILENT;
    onDelay_ = static_cast<double>(v_[P_DL_MIX]) > SILENT;
    onReverb_ = static_cast<double>(v_[P_RV_MIX]) > SILENT;
    if (onChorus_ && !wasChorus_) { chorus_.reset(); snapRange(P_CH_RATE, P_CH_WIDTH); }
    if (onDelay_ && !wasDelay_) { delay_.reset(); snapRange(P_DL_TIME, P_DL_WIDTH); }
    if (onReverb_ && !wasReverb_) { reverb_.reset(); snapRange(P_RV_PREDELAY, P_RV_DAMP); }
    wasChorus_ = onChorus_; wasDelay_ = onDelay_; wasReverb_ = onReverb_;
  }

  /** Settings of a unit just switched back on jump to target rather than
   *  gliding from wherever they were left; they were not advanced per sample
   *  while the unit was silent (see step()) and its buffers have just been
   *  cleared. Mix values are never snapped: a mix has to fade. */
  void snapRange(int from, int to) {
    for (int i = from; i <= to; i++) {
      const double t = static_cast<double>(target_[i]);
      sm_[static_cast<size_t>(i)].snap(t);
      v_[i] = static_cast<float>(t);
    }
  }

  /**
   * Advance the smoothers this sample actually consumes.
   *
   * Mirrors fx.ts step(): the eleven parameters belonging to switched-off units
   * are not read by anything, so they are not advanced per sample - they still
   * advance once per block in gate(), and are snapped on the way back in. The
   * three mix values stay in the per-sample set because gate() tests them and a
   * mix must fade without a step.
   */
  void step() {
    for (int i = P_DRIVE; i <= P_CRUSH_BITS; i++) v_[i] = static_cast<float>(sm_[static_cast<size_t>(i)].next());
    if (onChorus_) {
      for (int i = P_CH_RATE; i <= P_CH_WIDTH; i++) v_[i] = static_cast<float>(sm_[static_cast<size_t>(i)].next());
    }
    v_[P_CH_MIX] = static_cast<float>(sm_[P_CH_MIX].next());
    if (onDelay_) {
      for (int i = P_DL_TIME; i <= P_DL_WIDTH; i++) v_[i] = static_cast<float>(sm_[static_cast<size_t>(i)].next());
    }
    v_[P_DL_MIX] = static_cast<float>(sm_[P_DL_MIX].next());
    if (onReverb_) {
      for (int i = P_RV_PREDELAY; i <= P_RV_DAMP; i++) v_[i] = static_cast<float>(sm_[static_cast<size_t>(i)].next());
    }
    v_[P_RV_MIX] = static_cast<float>(sm_[P_RV_MIX].next());
    v_[P_TRIM] = static_cast<float>(sm_[P_TRIM].next());
    v_[P_GLUE] = static_cast<float>(sm_[P_GLUE].next());
  }

  /** Drive and bitcrush: memoryless-plus-tilt, and inherently one-channel. */
  double front(double dry, const float* v) {
    double x = dry;
    const double amt = v[P_DRIVE];
    tilt_ = flush(tilt_ + tiltC_ * (x - tilt_));
    if (amt > 0.0) {
      const double g = 1.0 + amt * DRIVE_MAX_G;
      const double shaped = x + static_cast<double>(v[P_DRIVE_TONE]) * (x - tilt_);
      const double w = (sat(shaped * g) * DRIVE_REF) / sat(DRIVE_REF * g);
      // Blended in, so drive at zero is bit-exact bypass rather than "nearly".
      x = dry + (w - dry) * (amt * (2.0 - amt));
    }
    const double rate = v[P_CRUSH_RATE];
    acc_ += rate;
    if (acc_ >= 1.0) { acc_ -= 1.0; held_ = x; }
    const double half = v[P_CRUSH_BITS];
    // Bit-exact bypass when neither crush control is engaged.
    if (rate >= 1.0 && half >= CRUSH_TRANSPARENT) return held_;
    return std::floor(held_ * half + 0.5) / half;
  }

  double sr_;
  std::vector<Smoother> sm_;
  float target_[N_PARAMS] = {0};
  /** Smoothed, in DSP units - the only path into the DSP. */
  float v_[N_PARAMS] = {0};
  Chorus chorus_;
  Delay delay_;
  Reverb reverb_;
  double tiltC_ = 0.0;
  double sizeRaw_ = def(P_RV_SIZE), decayRaw_ = def(P_RV_DECAY);
  double tilt_ = 0.0, held_ = 0.0, acc_ = 0.0;
  bool wasChorus_ = false, wasDelay_ = false, wasReverb_ = false;
  bool onChorus_ = false, onDelay_ = false, onReverb_ = false;
};

}  // namespace fxchain
}  // namespace sigil
