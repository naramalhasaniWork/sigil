// Port of src/dsp/granular-voice.ts
//
// Follows the five porting rules at the top of src/dsp/util.h. The three that
// bite hardest in this module:
//
//   * `params`, `gTaper`, `gGainL`, `gGainR` and the source buffer are
//     Float32Array in the TS, so they are `float` here and every read widens
//     back to double. The rounding at those stores is audible state: a grain's
//     taper and pan gains are quantised to f32 before they are ever used, and
//     the descriptor default position 0.12 is NOT 0.12 once it has been through
//     a Float32Array.
//   * `gPos`, `gInc`, `gAge`, `gLen` are Float64Array -> plain double.
//   * The RNG is consumed in a fixed order inside spawn(): spray, pitch
//     scatter, reverse coin, duration jitter, pan. Five draws, always, even
//     when the corresponding parameter is zero. Reordering or short-circuiting
//     any of them desynchronises the entire grain cloud from that point on.
//
// The DC blocker's denormal guard and the `y === y` NaN guard are copied
// literally, including the asymmetric handling of dcX1 (the input is flushed,
// the output is flushed separately) which is what the TS actually does.
#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

#include "dsp/blep.h"
#include "dsp/envelope.h"
#include "dsp/ladder.h"
#include "dsp/smoothing.h"
#include "dsp/util.h"

namespace sigil {
namespace granular {

// Parameter indices, mirroring the P_* constants in the TS.
enum {
  kDensity = 0, kSize = 1, kPosition = 2, kSpray = 3, kPitchScatter = 4,
  kReverse = 5, kWindow = 6, kAttack = 7, kDecay = 8, kSustain = 9,
  kRelease = 10, kNumParams = 11,
};

/** GRANULAR_DESCRIPTOR defaults, in descriptor order. */
constexpr double kDefaults[kNumParams] = {
  32.0, 90.0, 0.12, 0.12, 0.25, 0.1, 1.0, 25.0, 700.0, 0.75, 900.0,
};

constexpr int kMaxGrains = 32;
constexpr double kDenormal = 1e-20;
constexpr double kTwoPi = 6.283185307179586;
// Math.PI, spelled out so the constant cannot drift.
constexpr double kPi = 3.141592653589793;

constexpr int kSourceSr = 48000;
constexpr int kSourceSeconds = 3;
constexpr double kSourceRootHz = 110.0;

constexpr int kRiseSteps = 1024;

inline double clamp(double v, double lo, double hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/** Cheap rational tanh - monotonic, so dense clouds stay in the rails. */
inline double saturate(double x) {
  const double x2 = x * x;
  return (x * (27.0 + x2)) / (27.0 + 9.0 * x2);
}

/** Half a raised cosine, sampled once. Float32Array in the TS. */
inline const float* riseTable() {
  static const std::array<float, kRiseSteps + 1> table = [] {
    std::array<float, kRiseSteps + 1> t{};
    for (int i = 0; i <= kRiseSteps; ++i) {
      t[static_cast<size_t>(i)] =
          static_cast<float>(0.5 - 0.5 * std::cos((kPi * i) / kRiseSteps));
    }
    return t;
  }();
  return table.data();
}

inline double rise(double x) {
  if (x <= 0.0) return 0.0;
  if (x >= 1.0) return 1.0;
  const double f = x * kRiseSteps;
  const std::int32_t i = toInt32(f);  // JS `f | 0`
  const float* r = riseTable();
  const double a = r[i];
  const double b = r[i + 1];
  return a + (b - a) * (f - i);
}

/** Tukey window: flat top, raised-cosine shoulders; taper 0.5 is a plain Hann.
 * The taper never reaches 0 - a rectangular grain window clicks every grain. */
inline double grainWindow(double phase, double taper) {
  if (phase <= 0.0 || phase >= 1.0) return 0.0;
  if (phase < taper) return rise(phase / taper);
  if (phase > 1.0 - taper) return rise((1.0 - phase) / taper);
  return 1.0;
}

/**
 * getSource(): detuned saws plus swept filtered noise, peak-normalised to 0.9.
 *
 * Note that `peak` tracks the DOUBLE `v`, not the float32 that was just stored
 * in the buffer, while the normalisation pass multiplies the float32 that WAS
 * stored. Both halves of that are reproduced exactly.
 */
inline std::vector<float> buildSource() {
  const int len = kSourceSr * kSourceSeconds;
  std::vector<float> buf(static_cast<size_t>(len), 0.0f);
  SawOscillator s1(kSourceSr), s2(kSourceSr), s3(kSourceSr);
  LadderFilter noiseFilter(kSourceSr);
  noiseFilter.setResonance(0.3);
  // xorshift32. The TS keeps this in a JS number with `>>> 0` normalisation
  // after each step; the bit patterns are identical in uint32_t.
  std::uint32_t rng = 0x9e3779b9u;
  double peak = 1e-9;
  for (int i = 0; i < len; ++i) {
    const double t = static_cast<double>(i) / len;
    const double wob = std::sin(t * kTwoPi * 3.0) * 0.004;
    s1.setFrequency(kSourceRootHz);
    s2.setFrequency(kSourceRootHz * (1.006 + wob));
    s3.setFrequency(kSourceRootHz * 2.0 * (0.994 - wob));
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    const double noise = (static_cast<double>(rng) / 4294967296.0) * 2.0 - 1.0;
    noiseFilter.setCutoff(
        300.0 * std::pow(2.0, 4.5 * (0.5 - 0.5 * std::cos(t * kTwoPi * 2.0))));
    const double air = 0.2 + 0.28 * (0.5 - 0.5 * std::cos(t * kTwoPi * 5.0));
    // Explicit locals: the TS evaluates these left to right and they all have
    // side effects, but C++17 leaves the operand order of `a + b` unspecified.
    const double o1 = s1.next();
    const double o2 = s2.next();
    const double o3 = s3.next();
    const double nf = noiseFilter.process(noise);
    const double v = (o1 + o2 + o3 * 0.6) * 0.32 + nf * air * 1.1;
    buf[static_cast<size_t>(i)] = static_cast<float>(v);
    if (v > peak) peak = v;
    else if (-v > peak) peak = -v;
  }
  const double norm = 0.9 / peak;
  for (int i = 0; i < len; ++i) {
    buf[static_cast<size_t>(i)] =
        static_cast<float>(static_cast<double>(buf[static_cast<size_t>(i)]) * norm);
  }
  return buf;
}

/** The shared source material. Built once, exactly as the TS module-level
 *  `sourceBuffer` singleton is. Never touched from a render loop. */
inline const std::vector<float>& source() {
  static const std::vector<float> buf = buildSource();
  return buf;
}

class GranularVoice {
public:
  explicit GranularVoice(double sampleRate)
      : sr_(sampleRate),
        invSr_(1.0 / sampleRate),
        src_(source().data()),
        srcLen_(static_cast<int>(source().size())),
        srcRateRatio_(static_cast<double>(kSourceSr) / sampleRate),
        ampEnv_(sampleRate),
        posSmooth_(sampleRate, 25.0),
        densitySmooth_(sampleRate, 40.0) {
    for (int i = 0; i < kNumParams; ++i) params_[i] = static_cast<float>(kDefaults[i]);
    posSmooth_.snap(params_[kPosition]);
    densitySmooth_.snap(params_[kDensity]);
  }

  void setParam(int index, double value) {
    if (index < 0 || index >= kNumParams) return;
    params_[index] = static_cast<float>(value);
    if (index == kAttack || index == kDecay || index == kSustain || index == kRelease) {
      applyEnvelope();
    }
  }

  void noteOn(double freq, double velocity, int voiceIndex) {
    velocity_ = velocity;
    active_ = true;
    pitchRatio_ = freq / kSourceRootHz;
    // JS: ((voiceIndex * 2654435761) ^ 0x5bf03635) >>> 0 || 1
    // The multiply happens in double; the `^` forces ToInt32 on the product.
    const std::int32_t mixed =
        toInt32(static_cast<double>(voiceIndex) * 2654435761.0) ^ 0x5bf03635;
    const std::uint32_t seed = static_cast<std::uint32_t>(mixed);
    rng_ = seed != 0u ? seed : 1u;
    spawnAccum_ = 1.0;
    dcX1_ = 0.0;
    dcY1_ = 0.0;
    for (int g = 0; g < kMaxGrains; ++g) gActive_[g] = 0;
    applyEnvelope();
    ampEnv_.trigger();
    posSmooth_.snap(params_[kPosition]);
    densitySmooth_.snap(params_[kDensity]);
  }

  void noteOff() { ampEnv_.release(); }

  bool isFinished() const { return active_ && ampEnv_.isFinished(); }

  /** render() ADDS into out, exactly as the TS does. */
  void render(float* out, int offset, int count) {
    if (!active_) return;

    const float* src = src_;
    const int len = srcLen_;
    const double sizeSamples = clamp(params_[kSize], 1.0, 4000.0) * 0.001 * sr_;
    posSmooth_.setTarget(clamp(params_[kPosition], 0.0, 1.0));
    densitySmooth_.setTarget(clamp(params_[kDensity], 0.0, 400.0));

    for (int i = 0; i < count; ++i) {
      const double pos = posSmooth_.next();
      spawnAccum_ += densitySmooth_.next() * invSr_;
      if (spawnAccum_ >= 1.0) {
        spawnAccum_ -= 1.0;
        if (spawnAccum_ > 1.0) spawnAccum_ = 1.0;
        spawn(pos, sizeSamples);
      }

      double sumL = 0.0;
      double sumR = 0.0;
      for (int g = 0; g < kMaxGrains; ++g) {
        if (gActive_[g] == 0) continue;
        const double age = gAge_[g];
        const double glen = gLen_[g];
        if (age >= glen) { gActive_[g] = 0; continue; }

        double p = gPos_[g];
        const std::int32_t i0 = toInt32(p);
        std::int32_t i1 = i0 + 1;
        if (i1 >= len) i1 = 0;
        const double a = read(src, len, i0);
        const double b = read(src, len, i1);
        const double s = (a + (b - a) * (p - i0)) *
                         grainWindow(age / glen, gTaper_[g]);

        sumL += s * static_cast<double>(gGainL_[g]);
        sumR += s * static_cast<double>(gGainR_[g]);

        p += gInc_[g];
        if (p >= len) p -= len;
        else if (p < 0.0) p += len;
        gPos_[g] = p;
        gAge_[g] = age + 1.0;
      }

      // Grains start and stop mid-waveform, so the cloud carries a wandering
      // DC offset. Left in, it eats headroom and dulls the saturator.
      const double mono = (sumL + sumR) * 0.7071067811865476;
      double hp = mono - dcX1_ + 0.995 * dcY1_;
      if (hp < kDenormal && hp > -kDenormal) hp = 0.0;
      dcX1_ = (mono < kDenormal && mono > -kDenormal) ? 0.0 : mono;
      dcY1_ = hp;

      const double y = saturate(hp * 0.7) * ampEnv_.next() * velocity_ * 0.9;
      const double cur = static_cast<double>(out[offset + i]);
      out[offset + i] = static_cast<float>(cur + (y == y ? y : 0.0));
    }
  }

private:
  void applyEnvelope() {
    ampEnv_.set(params_[kAttack], params_[kDecay], params_[kSustain], params_[kRelease]);
  }

  /** JS array read: out of range yields `undefined`, and `undefined` in
   *  arithmetic is NaN. Reproduced rather than made safe, because the NaN then
   *  poisons the DC-blocker state and silences the voice - which is what the
   *  reference would do. Reachable only if a grain start lands exactly on len. */
  static double read(const float* src, int len, std::int32_t idx) {
    if (idx < 0 || idx >= len) return std::numeric_limits<double>::quiet_NaN();
    return src[idx];
  }

  /** xorshift32. Seeded per voice so a rendered patch is reproducible. */
  double rand() {
    std::uint32_t x = rng_;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    rng_ = x;
    return static_cast<double>(x) / 4294967296.0;
  }

  void spawn(double posNorm, double sizeSamples) {
    int slot = -1;
    for (int g = 0; g < kMaxGrains; ++g) {
      if (gActive_[g] == 0) { slot = g; break; }
    }
    if (slot < 0) return;

    const int len = srcLen_;
    const double spray = clamp(params_[kSpray], 0.0, 1.0);
    double start = (clamp(posNorm, 0.0, 1.0) + (rand() * 2.0 - 1.0) * spray) * len;
    start = std::fmod(start, static_cast<double>(len));  // JS `%`
    if (start < 0.0) start += len;

    const double scatter = clamp(params_[kPitchScatter], 0.0, 12.0);
    const double cents = (rand() * 2.0 - 1.0) * scatter;
    double inc = pitchRatio_ * srcRateRatio_ * std::pow(2.0, cents / 12.0);
    if (inc > 16.0) inc = 16.0;
    if (rand() < clamp(params_[kReverse], 0.0, 1.0)) inc = -inc;

    double dur = sizeSamples * (1.0 + (rand() * 2.0 - 1.0) * 0.15 * spray);
    if (dur < 8.0) dur = 8.0;

    // Grains are panned across the stereo field; render() is mono for now and
    // folds the two gains back down, so pan still shapes the cloud's weight.
    const double pan = rand();
    const double shape = clamp(params_[kWindow], 0.0, 1.0);

    gActive_[slot] = 1;
    gPos_[slot] = start;
    gInc_[slot] = inc;
    gAge_[slot] = 0.0;
    gLen_[slot] = dur;
    gTaper_[slot] = static_cast<float>(0.05 + 0.45 * shape);
    gGainL_[slot] = static_cast<float>(std::cos(pan * kPi * 0.5) * 0.45);
    gGainR_[slot] = static_cast<float>(std::sin(pan * kPi * 0.5) * 0.45);
  }

  float params_[kNumParams] = {0};

  std::uint8_t gActive_[kMaxGrains] = {0};
  double gPos_[kMaxGrains] = {0};
  double gInc_[kMaxGrains] = {0};
  double gAge_[kMaxGrains] = {0};
  double gLen_[kMaxGrains] = {0};
  float gTaper_[kMaxGrains] = {0};
  float gGainL_[kMaxGrains] = {0};
  float gGainR_[kMaxGrains] = {0};

  double sr_;
  double invSr_;
  const float* src_;
  int srcLen_;
  double srcRateRatio_;

  Envelope ampEnv_;
  Smoother posSmooth_;
  Smoother densitySmooth_;

  std::uint32_t rng_ = 1u;
  double spawnAccum_ = 0.0;
  double pitchRatio_ = 1.0;
  double velocity_ = 1.0;
  bool active_ = false;
  double dcX1_ = 0.0;
  double dcY1_ = 0.0;
};

}  // namespace granular
}  // namespace sigil
