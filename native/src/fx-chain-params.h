// Parameter indices, defaults and smoothing times for the master FX chain:
// the parts of src/dsp/fx-core.ts and src/dsp/fx-descriptor.ts that fx.ts
// addresses BY INDEX. Order is load-bearing - never reorder.
#pragma once

#include <string>

namespace sigil {
namespace fxchain {

constexpr int P_DRIVE = 0, P_DRIVE_TONE = 1, P_CRUSH_RATE = 2, P_CRUSH_BITS = 3;
constexpr int P_CH_RATE = 4, P_CH_DEPTH = 5, P_CH_WIDTH = 6, P_CH_MIX = 7;
constexpr int P_DL_TIME = 8, P_DL_FB = 9, P_DL_TONE = 10, P_DL_WIDTH = 11, P_DL_MIX = 12;
constexpr int P_RV_PREDELAY = 13, P_RV_SIZE = 14, P_RV_DECAY = 15;
constexpr int P_RV_DAMP = 16, P_RV_MIX = 17, P_TRIM = 18;
constexpr int N_PARAMS = 19;

/** FX_DESCRIPTOR.params[i].id, in descriptor order. */
inline const char* const* paramIds() {
  static const char* const ids[N_PARAMS] = {
      "drive-amount", "drive-tone", "crush-rate", "crush-bits",
      "chorus-rate", "chorus-depth", "chorus-width", "chorus-mix",
      "delay-time", "delay-feedback", "delay-tone", "delay-width", "delay-mix",
      "reverb-predelay", "reverb-size", "reverb-decay",
      "reverb-damping", "reverb-mix", "output-trim"};
  return ids;
}

/** FX_DESCRIPTOR.params[i].default, i.e. `def(i)` in fx-core.ts. */
constexpr double kDefault[N_PARAMS] = {
    0.0, 0.5, 0.0, 16.0, 0.45, 0.35, 0.6, 0.0, 340.0, 0.4,
    4000.0, 0.5, 0.0, 18.0, 0.55, 2200.0, 0.5, 0.0, 0.0};

inline double def(int i) { return (i >= 0 && i < N_PARAMS) ? kDefault[i] : 0.0; }

inline int paramIndexById(const std::string& id) {
  for (int i = 0; i < N_PARAMS; i++) {
    if (id == paramIds()[i]) return i;
  }
  return -1;
}

/** Per-parameter smoothing in ms. Delay time and reverb size move a read
 *  pointer so they glide; mixes and gains only need de-zippering. */
constexpr double kSmoothMs[N_PARAMS] = {
    25, 25, 25, 25, 30, 30, 30, 30, 80, 30, 30, 60, 30, 120, 120, 30, 40, 30, 25};

}  // namespace fxchain
}  // namespace sigil
