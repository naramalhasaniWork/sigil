// Chorus and Delay: the two modulated-line units of src/dsp/fx.ts.
//
// PORTING NOTE: Chorus.phase is a Float32Array in the TypeScript, but the value
// USED within a sample is the un-rounded local `ph`; only what carries to the
// next sample rounds to single precision. Those are not the same number and
// both behaviours have to be reproduced.
#pragma once

#include <cmath>

#include "dsp/fx_core.h"
#include "fx-chain-params.h"

namespace sigil {
namespace fxchain {

using sigil::fx::Line;
using sigil::fx::flush;
using sigil::fx::lfo;

constexpr double CH_MID_MS = 12, CH_SPREAD_MS = 7, CH_DEPTH_MS = 3.5;
constexpr double CH_DRY_CUT = 0.4, CH_WET_G = 0.55;

/** Three taps off one modulated line, each with its own LFO phase and (once
 *  width opens up) its own rate, so the copies never line up and cancel. */
class Chorus {
public:
  explicit Chorus(double sr) : line_(static_cast<int>(std::ceil(sr * 0.05))) {
    mid_ = (CH_MID_MS * sr) / 1000.0;
    spread_ = (CH_SPREAD_MS * sr) / 1000.0;
    depth_ = (CH_DEPTH_MS * sr) / 1000.0;
    reset();
  }
  void reset() {
    line_.clear();
    phase_[0] = 0.0f;
    phase_[1] = static_cast<float>(1.0 / 3.0);
    phase_[2] = static_cast<float>(2.0 / 3.0);
    oL = 0.0; oR = 0.0;
  }
  double process(double x, const float* p) {
    const double r = p[P_CH_RATE], d = static_cast<double>(p[P_CH_DEPTH]) * depth_;
    const double w = p[P_CH_WIDTH], m = p[P_CH_MIX];
    double wet = 0.0;
    for (int i = 0; i < 3; i++) {
      double ph = static_cast<double>(phase_[i]) + r * (1.0 + (i - 1) * 0.28 * w);
      if (ph >= 1.0) ph -= 1.0;
      phase_[i] = static_cast<float>(ph);
      wet += line_.read(mid_ + (i - 1) * spread_ * w + d * lfo(ph));
    }
    line_.write(x);
    return x * (1.0 - CH_DRY_CUT * m) + wet * (m * CH_WET_G);
  }
  /** Same three taps, read twice: the right channel's modulation runs half a
   *  cycle out of phase with the left's. At width 0 the two reads land on
   *  identical delays and the channels are bit-identical, not merely close. */
  void processStereo(double l, double r, const float* p) {
    const double rate = p[P_CH_RATE], d = static_cast<double>(p[P_CH_DEPTH]) * depth_;
    const double w = p[P_CH_WIDTH], m = p[P_CH_MIX];
    double wetL = 0.0, wetR = 0.0;
    for (int i = 0; i < 3; i++) {
      double ph = static_cast<double>(phase_[i]) + rate * (1.0 + (i - 1) * 0.28 * w);
      if (ph >= 1.0) ph -= 1.0;
      phase_[i] = static_cast<float>(ph);
      const double base = mid_ + (i - 1) * spread_ * w;
      const double mod = d * lfo(ph);
      const double anti = d * lfo(ph >= 0.5 ? ph - 0.5 : ph + 0.5);
      wetL += line_.read(base + mod);
      wetR += line_.read(base + mod + (anti - mod) * w);
    }
    line_.write((l + r) * 0.5);
    const double dry = 1.0 - CH_DRY_CUT * m, g = m * CH_WET_G;
    oL = l * dry + wetL * g;
    oR = r * dry + wetR * g;
  }
  double oL = 0.0, oR = 0.0;

private:
  Line line_;
  float phase_[3] = {0, 0, 0};
  double mid_ = 0, spread_ = 0, depth_ = 0;
};

constexpr double DL_MAX_S = 2.05;
/** Regeneration ceiling. The two-line cross-feed matrix has spectral radius
 *  exactly this at every width setting, so the delay can never run away. */
constexpr double DL_FB_MAX = 0.92, DL_WET_G = 0.7;

class Delay {
public:
  explicit Delay(double sr)
      : a_(static_cast<int>(std::ceil(sr * DL_MAX_S))),
        b_(static_cast<int>(std::ceil(sr * DL_MAX_S))) {}
  void reset() { a_.clear(); b_.clear(); lpA_ = 0; lpB_ = 0; oL = 0; oR = 0; }
  double process(double x, const float* p) {
    const double t = p[P_DL_TIME], f = p[P_DL_FB];
    const double c = p[P_DL_TONE], w = p[P_DL_WIDTH];
    const double ra = a_.read(t);
    // A mono sum of a true ping-pong is indistinguishable from a plain delay,
    // so width offsets the second line: repeats bounce in time, not in space.
    const double rb = b_.read(t * (1.0 - 0.5 * w));
    lpA_ = flush(lpA_ + c * (ra - lpA_));
    lpB_ = flush(lpB_ + c * (rb - lpB_));
    a_.write(flush(x + f * (w * lpB_ + (1.0 - w) * lpA_)));
    b_.write(flush(f * (w * lpA_ + (1.0 - w) * lpB_)));
    return x + static_cast<double>(p[P_DL_MIX]) * DL_WET_G * (ra + rb);
  }
  /** Real ping-pong: line A to the left, line B to the right. At width 0 the
   *  two lines are fed identically and stay sample-identical. */
  void processStereo(double l, double r, const float* p) {
    const double t = p[P_DL_TIME], f = p[P_DL_FB];
    const double c = p[P_DL_TONE], w = p[P_DL_WIDTH];
    const double ra = a_.read(t), rb = b_.read(t);
    lpA_ = flush(lpA_ + c * (ra - lpA_));
    lpB_ = flush(lpB_ + c * (rb - lpB_));
    const double x = (l + r) * 0.5;
    a_.write(flush(x + f * (w * lpB_ + (1.0 - w) * lpA_)));
    b_.write(flush(x * (1.0 - w) + f * (w * lpA_ + (1.0 - w) * lpB_)));
    const double g = static_cast<double>(p[P_DL_MIX]) * DL_WET_G;
    oL = l + g * ra;
    oR = r + g * rb;
  }
  double oL = 0.0, oR = 0.0;

private:
  Line a_, b_;
  double lpA_ = 0.0, lpB_ = 0.0;
};

}  // namespace fxchain
}  // namespace sigil
