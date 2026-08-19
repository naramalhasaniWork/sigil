// Parity runners for filters.ts (StateVariableFilter, DiodeFilter, createFilter).
//
// ladder.ts has its own runner in core_cases.cpp; this file covers the
// `filters_` prefix only. Every setup is read out of the golden's own recorded
// parameters, and the input signal comes from c.input verbatim - the stored
// file is literally what the reference passed to process().
#include <string>
#include <vector>

#include "../parity.h"
#include "dsp/filters.h"

using parity::Case;

namespace {

/** StateVariableFilter::setMode takes 0 = lp, 1 = bp, 2 = hp. */
int modeFrom(const std::string& s) {
  if (s == "bp") return 1;
  if (s == "hp") return 2;
  return 0;
}

void render(sigil::Filter& f, const Case& c, std::vector<float>& out) {
  for (int i = 0; i < c.frames; ++i) {
    const double x = static_cast<double>(c.input[static_cast<size_t>(i)]);
    out[static_cast<size_t>(i)] = static_cast<float>(f.process(x));
  }
}

bool run_filters(const Case& c, std::vector<float>& out) {
  if (!c.hasInput()) return false;
  out.assign(static_cast<size_t>(c.frames), 0.0f);
  const double sr = 48000.0;

  if (c.id.rfind("filters_svf_", 0) == 0) {
    sigil::StateVariableFilter f(sr);
    // setMode BEFORE setCutoff/setResonance, as the golden does.
    f.setMode(modeFrom(c.p.str("mode", "lp")));
    f.setCutoff(c.p.num("cutoffHz"));
    f.setResonance(c.p.num("resonance"));
    render(f, c, out);
    return true;
  }

  if (c.id.rfind("filters_diode_", 0) == 0) {
    sigil::DiodeFilter f(sr);
    f.setCutoff(c.p.num("cutoffHz"));
    f.setResonance(c.p.num("resonance"));
    render(f, c, out);
    return true;
  }

  if (c.id.rfind("filters_create_", 0) == 0) {
    // createFilter dispatch: 'ladder' is the fallback for anything unknown.
    const std::string model = c.p.str("model", "ladder");
    sigil::StateVariableFilter svf(sr);
    sigil::DiodeFilter diode(sr);
    sigil::LadderModel ladder(sr);
    sigil::Filter& f = model == "svf"   ? static_cast<sigil::Filter&>(svf)
                       : model == "diode" ? static_cast<sigil::Filter&>(diode)
                                          : static_cast<sigil::Filter&>(ladder);
    f.setCutoff(c.p.num("cutoffHz"));
    f.setResonance(c.p.num("resonance"));
    render(f, c, out);
    return true;
  }

  return false;
}

}  // namespace

PARITY_RUNNER("filters_", run_filters);
