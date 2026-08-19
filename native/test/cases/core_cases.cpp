// Worked-example parity runners.
//
// This file is the template every porting agent should copy. A runner:
//   * reads its setup out of c.p (the golden's own recorded parameters, so the
//     C++ and the TS can never disagree about what the case is),
//   * reads any input signal out of c.input - never regenerates it,
//   * fills `out` with exactly frames*channels interleaved floats,
//   * returns true.
// Returning false means "not implemented", which reports as SKIP.
#include <cmath>
#include <string>
#include <vector>

#include "../parity.h"
#include "../../src/dsp/blep.h"
#include "../../src/dsp/envelope.h"
#include "../../src/dsp/fx_core.h"
#include "../../src/dsp/ladder.h"
#include "../../src/dsp/smoothing.h"

using parity::Case;

// ---------------------------------------------------------------------------
// smoothing.ts
// ---------------------------------------------------------------------------
static bool run_smoothing(const Case& c, std::vector<float>& out) {
  const double sr = 48000.0;
  out.assign(static_cast<size_t>(c.frames), 0.0f);

  if (c.id.rfind("smoothing_step_", 0) == 0) {
    sigil::Smoother s(sr, c.p.num("timeMs"));
    s.snap(c.p.num("snap"));
    s.setTarget(c.p.num("target"));
    for (int i = 0; i < c.frames; ++i) out[static_cast<size_t>(i)] = static_cast<float>(s.next());
    return true;
  }
  if (c.id == "smoothing_retarget") {
    sigil::Smoother s(sr, c.p.num("timeMs"));
    s.snap(0.0);
    for (int i = 0; i < c.frames; ++i) {
      if (i == 0) s.setTarget(c.p.num("targets.0"));
      else if (i == 2000) s.setTarget(c.p.num("targets.2000"));
      else if (i == 4000) s.setTarget(c.p.num("targets.4000"));
      out[static_cast<size_t>(i)] = static_cast<float>(s.next());
    }
    return true;
  }
  if (c.id == "smoothing_denormal_flush") {
    sigil::Smoother s(sr, c.p.num("timeMs"));
    s.snap(c.p.num("snap"));
    s.setTarget(c.p.num("target"));
    for (int i = 0; i < c.frames; ++i) out[static_cast<size_t>(i)] = static_cast<float>(s.next());
    return true;
  }
  return false;
}
PARITY_RUNNER("smoothing_", run_smoothing);

// ---------------------------------------------------------------------------
// blep.ts
// ---------------------------------------------------------------------------
static bool run_blep(const Case& c, std::vector<float>& out) {
  out.assign(static_cast<size_t>(c.frames), 0.0f);

  if (c.id == "blep_residual_grid") {
    const std::vector<double> dts = c.p.nums("dts");
    const int steps = static_cast<int>(c.p.num("tPerDt"));
    size_t k = 0;
    for (double dt : dts) {
      for (int i = 0; i < steps; ++i) {
        out[k++] = static_cast<float>(sigil::blep(static_cast<double>(i) / steps, dt));
      }
    }
    return k == out.size();
  }
  if (c.id.rfind("blep_saw_", 0) == 0) {
    sigil::SawOscillator o(c.p.num("sampleRate"));
    o.setFrequency(c.p.num("hz"));
    for (int i = 0; i < c.frames; ++i) out[static_cast<size_t>(i)] = static_cast<float>(o.next());
    return true;
  }
  return false;
}
PARITY_RUNNER("blep_", run_blep);

// ---------------------------------------------------------------------------
// ladder.ts
// ---------------------------------------------------------------------------
static bool run_ladder(const Case& c, std::vector<float>& out) {
  if (!c.hasInput()) return false;
  out.assign(static_cast<size_t>(c.frames), 0.0f);
  sigil::LadderFilter f(48000.0);
  f.setCutoff(c.p.num("cutoffHz"));
  f.setResonance(c.p.num("resonance"));
  // The stored input file is literally what process() was fed. Never rescale it.
  for (int i = 0; i < c.frames; ++i) {
    const double x = static_cast<double>(c.input[static_cast<size_t>(i)]);
    out[static_cast<size_t>(i)] = static_cast<float>(f.process(x));
  }
  return true;
}
PARITY_RUNNER("ladder_", run_ladder);

// ---------------------------------------------------------------------------
// envelope.ts
// ---------------------------------------------------------------------------
static bool run_envelope(const Case& c, std::vector<float>& out) {
  out.assign(static_cast<size_t>(c.frames), 0.0f);
  sigil::Envelope e(48000.0);
  e.set(c.p.num("attackMs"), c.p.num("decayMs"), c.p.num("sustain"), c.p.num("releaseMs"));
  e.trigger();
  const int releaseAt = static_cast<int>(c.p.num("releaseAtSample"));
  const int retriggerAt = static_cast<int>(c.p.num("retriggerAtSample", -1));
  for (int i = 0; i < c.frames; ++i) {
    if (i == releaseAt) e.release();
    if (i == retriggerAt) e.trigger();
    out[static_cast<size_t>(i)] = static_cast<float>(e.next());
  }
  return true;
}
PARITY_RUNNER("envelope_", run_envelope);

// ---------------------------------------------------------------------------
// fx-core.ts primitives
// ---------------------------------------------------------------------------
static bool run_fxcore(const Case& c, std::vector<float>& out) {
  out.assign(static_cast<size_t>(c.frames), 0.0f);
  const auto& in = c.input;

  if (c.id == "fxcore_sat_ramp" || c.id == "fxcore_limitOut_ramp" || c.id == "fxcore_flush_ramp" ||
      c.id == "fxcore_lfo_parabolic") {
    for (int i = 0; i < c.frames; ++i) {
      const double x = static_cast<double>(in[static_cast<size_t>(i)]);
      double y = 0.0;
      if (c.id == "fxcore_sat_ramp") y = sigil::fx::sat(x);
      else if (c.id == "fxcore_limitOut_ramp") y = sigil::fx::limitOut(x);
      else if (c.id == "fxcore_flush_ramp") y = sigil::fx::flush(x);
      else y = sigil::fx::lfo(x);
      out[static_cast<size_t>(i)] = static_cast<float>(y);
    }
    return true;
  }
  if (c.id == "fxcore_onepole_table") {
    const double sr = c.p.num("sampleRate");
    for (int i = 0; i < c.frames; ++i) {
      out[static_cast<size_t>(i)] =
          static_cast<float>(sigil::fx::onePole(static_cast<double>(in[static_cast<size_t>(i)]), sr));
    }
    return true;
  }
  if (c.id == "fxcore_line_fractional") {
    sigil::fx::Line line(static_cast<int>(c.p.num("maxSamples")));
    for (int i = 0; i < c.frames; ++i) {
      line.write(static_cast<double>(in[static_cast<size_t>(i)]));
      const double d = 0.25 + static_cast<double>(i % 1500) * 0.9;
      out[static_cast<size_t>(i)] = static_cast<float>(line.read(d));
    }
    return true;
  }
  return false;
}
PARITY_RUNNER("fxcore_", run_fxcore);
