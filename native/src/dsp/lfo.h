// Port of src/dsp/lfo.ts
//
// Two things live in this file, as in the TypeScript: `addOsc`, the block-form
// antialiased audio oscillator, and `Lfo`, the modulation source.
//
// Porting notes that matter (see src/dsp/util.h for the general rules):
//
//  * `out`, `ph` and `tri` are Float64Array in the TS, so they are `double`
//    here, not `float`. Nothing in addOsc ever narrows to f32.
//  * The shape dispatch is `<= WAVE_SAW`, then `>= WAVE_SINE`, then
//    `=== WAVE_PULSE`, else triangle. `shape` is a JS number, so it stays a
//    double and the comparisons keep their exact semantics.
//  * The triangle integrator's denormal flush and the Lfo output's denormal
//    flush are copied literally, constant and comparison direction intact.
//  * Lfo::rand is JS xorshift32. In JS `<<`/`^` operate on int32 and `>>>` on
//    uint32; the bit patterns are identical if the whole thing is done in
//    uint32, which is what happens here. The state is kept as int32 because
//    that is what the TS field holds after `| 0`.
//  * `seed()` computes `voiceIndex * 0x9e3779b1 + 0x85ebca6b` in DOUBLE and
//    only then applies `| 0`. Doing the multiply in 32-bit would wrap early
//    and give a different seed.
#pragma once

#include <cmath>
#include <cstdint>

#include "blep.h"
#include "util.h"

namespace sigil {

namespace lfo_detail {
constexpr double kTwoPi = 6.283185307179586;
constexpr double kDenormal = 1e-20;
}  // namespace lfo_detail

/** Oscillator shapes, in descriptor step order. */
constexpr int WAVE_SAW = 0;
constexpr int WAVE_PULSE = 1;
constexpr int WAVE_TRIANGLE = 2;
constexpr int WAVE_SINE = 3;
constexpr int WAVE_COUNT = 4;

/** A leaky-integrated square settles at ~0.245 peak, whatever the pitch. */
constexpr double TRI_SCALE = 4.083;

/**
 * Adds `count` antialiased oscillator samples into `out`, scaled by `gain`.
 *
 * Block form on purpose: the waveform choice is hoisted out of the loop so each
 * shape is a tight monomorphic loop. `ph` holds phases and `tri` the triangle
 * integrator states, indexed by `u`, so one voice can run several copies.
 *
 * Zero allocation: everything is caller-owned.
 */
inline void addOsc(double shape, double* out, int count,
                   double* ph, double* tri, int u,
                   double inc, double pw, double gain) {
  using lfo_detail::kTwoPi;
  using lfo_detail::kDenormal;

  double p = ph[u];
  if (shape <= WAVE_SAW) {
    for (int i = 0; i < count; i++) {
      p += inc; if (p >= 1.0) p -= 1.0;
      out[i] = out[i] + (2.0 * p - 1.0 - blep(p, inc)) * gain;
    }
  } else if (shape >= WAVE_SINE) {
    for (int i = 0; i < count; i++) {
      p += inc; if (p >= 1.0) p -= 1.0;
      out[i] = out[i] + std::sin(p * kTwoPi) * gain;
    }
  } else if (shape == WAVE_PULSE) {
    for (int i = 0; i < count; i++) {
      p += inc; if (p >= 1.0) p -= 1.0;
      double q = p + pw; if (q >= 1.0) q -= 1.0;
      const double sq = (2.0 * p - 1.0 - blep(p, inc)) - (2.0 * q - 1.0 - blep(q, inc));
      out[i] = out[i] + sq * gain;
    }
  } else {
    double t = tri[u];
    const double g = gain * TRI_SCALE;
    for (int i = 0; i < count; i++) {
      p += inc; if (p >= 1.0) p -= 1.0;
      double q = p + 0.5; if (q >= 1.0) q -= 1.0;
      const double sq = (2.0 * p - 1.0 - blep(p, inc)) - (2.0 * q - 1.0 - blep(q, inc));
      t = t * (1.0 - inc) + inc * sq;
      if (t < kDenormal && t > -kDenormal) t = 0.0;
      out[i] = out[i] + t * g;
    }
    tri[u] = t;
  }
  ph[u] = p;
}

/** LFO shapes, in descriptor step order. */
constexpr int LFO_SINE = 0;
constexpr int LFO_TRIANGLE = 1;
constexpr int LFO_SQUARE = 2;
constexpr int LFO_SAMPLE_HOLD = 3;
constexpr int LFO_RANDOM_WALK = 4;
constexpr int LFO_SHAPE_COUNT = 5;

/** How far one random-walk step may move, in output units. */
constexpr double WALK_STEP = 0.55;

/**
 * A modulation source that is not an envelope. Five shapes, all -1..1.
 * Keysync, fade-in and per-voice seeding are the parts that make it musical;
 * they are also the parts with state, so they are the parts that must port
 * exactly. Allocation-free: next() touches numbers only.
 */
class Lfo {
public:
  explicit Lfo(double sampleRate) {
    sr_ = sampleRate > 1.0 ? sampleRate : 1.0;
    setRate(4.0);
  }

  void setRate(double hz) {
    const double max = sr_ * 0.45;
    const double f = !(hz > 0.0) ? 0.0 : (hz > max ? max : hz);
    inc_ = f / sr_;
  }

  void setShape(double shape) {
    const double s = jsRound(shape);
    shape_ = s < 0.0 ? 0.0 : (s >= LFO_SHAPE_COUNT ? LFO_SHAPE_COUNT - 1.0 : s);
  }

  /** Overall output scale, 0..1. Destination depths multiply on top of this. */
  void setDepth(double depth) {
    depth_ = !(depth > 0.0) ? 0.0 : (depth > 1.0 ? 1.0 : depth);
  }

  /** Time the LFO takes to fade up to full after each note starts. */
  void setDelayMs(double ms) {
    const double samples = (ms / 1000.0) * sr_;
    fadeInc_ = samples >= 1.0 ? 1.0 / samples : 1.0;
  }

  /** Decorrelates one voice from the next; same index gives the same stream. */
  void seed(double voiceIndex) {
    const std::int32_t s = toInt32(std::trunc(voiceIndex) * 2654435761.0 + 2246822507.0);
    rngState_ = (s == 0) ? static_cast<std::int32_t>(0x6d2b79f5) : s;
    from_ = rand();
    to_ = rand();
    held_ = from_;
  }

  /**
   * Note start. The fade always restarts; the phase only resets when the
   * patch asked for keysync.
   */
  void trigger(bool keysync) {
    fade_ = fadeInc_ >= 1.0 ? 1.0 : 0.0;
    if (keysync) phase_ = 0.0;
  }

  void reset() {
    phase_ = 0.0;
    fade_ = 1.0;
    from_ = 0.0;
    to_ = 0.0;
    held_ = 0.0;
  }

  double next() {
    double p = phase_ + inc_;
    if (p >= 1.0) {
      p -= 1.0;
      if (p >= 1.0) p = 0.0;
      // One new random per cycle drives both stepped shapes: sample-and-hold
      // jumps straight to it, the walk takes a step of that size towards its
      // next resting point. The walk REFLECTS off the rails rather than
      // clamping - a clamped walk parks against a rail and stops moving.
      const double r = rand();
      held_ = r;
      from_ = to_;
      double t = to_ + r * WALK_STEP;
      if (t > 1.0) t = 2.0 - t;
      else if (t < -1.0) t = -2.0 - t;
      to_ = t;
    }
    phase_ = p;

    double v;
    if (shape_ == LFO_SINE) {
      v = std::sin(p * lfo_detail::kTwoPi);
    } else if (shape_ == LFO_TRIANGLE) {
      v = p < 0.5 ? 4.0 * p - 1.0 : 3.0 - 4.0 * p;
    } else if (shape_ == LFO_SQUARE) {
      v = p < 0.5 ? 1.0 : -1.0;
    } else if (shape_ == LFO_SAMPLE_HOLD) {
      v = held_;
    } else {
      const double s = p * p * (3.0 - 2.0 * p);
      v = from_ + (to_ - from_) * s;
    }

    if (fade_ < 1.0) {
      fade_ += fadeInc_;
      if (fade_ > 1.0) fade_ = 1.0;
    }

    const double out = v * depth_ * fade_;
    return (out < lfo_detail::kDenormal && out > -lfo_detail::kDenormal) ? 0.0 : out;
  }

private:
  /** Deterministic xorshift32 in -1..1. Seeded per voice, never Math.random. */
  double rand() {
    std::uint32_t s = static_cast<std::uint32_t>(rngState_);
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    rngState_ = static_cast<std::int32_t>(s);
    return static_cast<double>(s) / 2147483648.0 - 1.0;
  }

  double phase_ = 0.0;
  double inc_ = 0.0;
  double shape_ = LFO_SINE;
  double depth_ = 1.0;
  double fade_ = 1.0;
  double fadeInc_ = 1.0;
  double held_ = 0.0;
  double from_ = 0.0;
  double to_ = 0.0;
  std::int32_t rngState_ = static_cast<std::int32_t>(0x9e3779b9);
  double sr_;
};

}  // namespace sigil
