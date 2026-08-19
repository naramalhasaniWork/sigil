// Parity runners for fx-magic-descriptor.ts, fx-magic-units.ts and fx-magic.ts.
//
// Every case reads its setup out of c.p and its signal out of c.input; nothing
// here regenerates an input or re-derives a constant the golden already stored.
#include <cmath>
#include <string>
#include <vector>

#include "../parity.h"
#include "../../src/dsp/fx_magic.h"
#include "../../src/dsp/fx_magic_descriptor.h"
#include "../../src/dsp/fx_magic_units.h"

using parity::Case;
namespace M = sigil::magic;

namespace {

constexpr double SR = 48000.0;

inline double in(const Case& c, int i) { return static_cast<double>(c.input[static_cast<size_t>(i)]); }
inline void put(std::vector<float>& out, int i, double y) {
  out[static_cast<size_t>(i)] = static_cast<float>(y);
}

// ---------------------------------------------------------------------------
// fx-magic-descriptor.ts + fx-magic-units.ts, one unit per case
// ---------------------------------------------------------------------------
bool run_magic(const Case& c, std::vector<float>& out) {
  if (!c.hasInput()) return false;
  out.assign(static_cast<size_t>(c.frames) * static_cast<size_t>(c.channels), 0.0f);
  const int n = c.frames;

  if (c.id == "magic_softlimit_ramp") {
    const double knee = c.p.num("knee"), span = c.p.num("span");
    for (int i = 0; i < n; i++) put(out, i, M::softLimit(in(c, i), knee, span));
    return true;
  }
  if (c.id == "magic_saturate_ramp") {
    for (int i = 0; i < n; i++) put(out, i, M::saturate(in(c, i)));
    return true;
  }
  if (c.id == "magic_delayline_fractional") {
    M::DelayLine dl(c.p.num("maxSamples"));
    for (int i = 0; i < n; i++) {
      dl.write(in(c, i));
      put(out, i, dl.read(3.5 + static_cast<double>(i % 900) * 1.7));
    }
    return true;
  }
  if (c.id == "magic_allpass2") {
    M::Allpass2 ap(c.p.num("coeff"));
    for (int i = 0; i < n; i++) put(out, i, ap.process(in(c, i)));
    return true;
  }
  if (c.id == "magic_diffuser") {
    M::Diffuser df(c.p.num("lengthSamples"), c.p.num("g"));
    for (int i = 0; i < n; i++) put(out, i, df.process(in(c, i)));
    return true;
  }
  if (c.id == "magic_hilbert") {
    M::HilbertPair h;
    for (int i = 0; i < n; i++) {
      h.process(in(c, i));
      out[static_cast<size_t>(i) * 2] = static_cast<float>(h.i);
      out[static_cast<size_t>(i) * 2 + 1] = static_cast<float>(h.q);
    }
    return true;
  }
  if (c.id.rfind("magic_pitchshifter_", 0) == 0) {
    M::PitchShifter ps(SR, c.p.num("windowMs"));
    const double ratio = c.p.num("ratio");
    for (int i = 0; i < n; i++) put(out, i, ps.process(in(c, i), ratio));
    return true;
  }
  if (c.id.rfind("magic_freqshifter_", 0) == 0) {
    M::FreqShifter fs(SR);
    const double hz = c.p.num("hz"), ring = c.p.num("ring");
    for (int i = 0; i < n; i++) put(out, i, fs.process(in(c, i), hz, ring));
    return true;
  }
  if (c.id.rfind("magic_tape_", 0) == 0) {
    M::Tape t(SR);
    const double wear = c.p.num("wear"), wow = c.p.num("wow"), flutter = c.p.num("flutter");
    for (int i = 0; i < n; i++) put(out, i, t.process(in(c, i), wear, wow, flutter));
    return true;
  }
  if (c.id == "magic_freezer") {
    M::Freezer fz(SR);
    const int captureAt = static_cast<int>(c.p.num("captureAtSample"));
    const int releaseAt = static_cast<int>(c.p.num("releaseAtSample"));
    const double lenSamples = c.p.num("captureLenSamples");
    for (int i = 0; i < n; i++) {
      // capture()/release() happen BEFORE process() on that sample index.
      if (i == captureAt) fz.capture(lenSamples);
      if (i == releaseAt) fz.release();
      put(out, i, fz.process(in(c, i)));
    }
    return true;
  }
  if (c.id.rfind("magic_shimmer_", 0) == 0) {
    M::Shimmer sh(SR);
    const double d = c.p.num("delaySamples"), fb = c.p.num("feedback");
    const double ratio = c.p.num("ratio"), damp = c.p.num("damping");
    for (int i = 0; i < n; i++) put(out, i, sh.process(in(c, i), d, fb, ratio, damp));
    return true;
  }
  if (c.id == "magic_vowel_sweep") {
    M::VowelFilter vf(SR);
    const double N = c.p.num("N");
    for (int i = 0; i < n; i++) {
      const double f = static_cast<double>(i) / N;
      put(out, i, vf.process(in(c, i), f, 0.5 + 0.4 * f));
    }
    return true;
  }
  if (c.id.rfind("magic_vowel_", 0) == 0) {
    M::VowelFilter vf(SR);
    const double pos = c.p.num("pos"), sharp = c.p.num("sharp");
    for (int i = 0; i < n; i++) put(out, i, vf.process(in(c, i), pos, sharp));
    return true;
  }
  if (c.id.rfind("magic_stutter_", 0) == 0) {
    M::Stutter st(SR);
    st.setSeed(c.p.num("seed"));
    const double slice = c.p.num("sliceSamples"), chance = c.p.num("chance");
    const double ratio = c.p.num("ratio");
    for (int i = 0; i < n; i++) put(out, i, st.process(in(c, i), slice, chance, ratio));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// fx-magic.ts, the whole chain over the irregular block pattern
// ---------------------------------------------------------------------------
bool run_magic_chain(const Case& c, std::vector<float>& out) {
  if (!c.hasInput()) return false;
  const bool stereo = c.p.str("mode", "mono") == "stereo";
  if (stereo != (c.channels == 2)) return false;

  M::MagicChain mc(SR);
  // Only the overrides are setParam-ed, so their smoothers RAMP rather than
  // snap; the defaults were already snapped by the constructor.
  const auto& kv = c.p.all();
  for (int i = 0; i < M::kMagicParamCount; i++) {
    const std::string key = std::string("overrides.") + M::MAGIC_PARAMS[static_cast<size_t>(i)].id;
    auto it = kv.find(key);
    if (it != kv.end()) mc.setParam(i, std::strtod(it->second.c_str(), nullptr));
  }

  std::vector<float> bufL = c.inputChannel(0);
  std::vector<float> bufR = stereo ? c.inputChannel(1) : std::vector<float>();

  const std::vector<int> blocks = c.p.ints("blockSizes");
  const int captureBefore = static_cast<int>(c.p.num("freezeCaptureBeforeBlockContaining"));
  int off = 0, done = 0;
  for (int b : blocks) {
    if (done <= captureBefore && done + b > captureBefore) mc.setParam(M::kFreezeCapture, 1.0);
    if (stereo) mc.processStereo(bufL.data() + off, bufR.data() + off, b);
    else mc.process(bufL.data() + off, b);
    off += b; done += b;
  }
  if (off != c.frames) return false;

  out.assign(static_cast<size_t>(c.frames) * static_cast<size_t>(c.channels), 0.0f);
  for (int i = 0; i < c.frames; i++) {
    if (stereo) {
      out[static_cast<size_t>(i) * 2] = bufL[static_cast<size_t>(i)];
      out[static_cast<size_t>(i) * 2 + 1] = bufR[static_cast<size_t>(i)];
    } else {
      out[static_cast<size_t>(i)] = bufL[static_cast<size_t>(i)];
    }
  }
  return true;
}

}  // namespace

PARITY_RUNNER("magic_", run_magic);
PARITY_RUNNER("magicchain_", run_magic_chain);
