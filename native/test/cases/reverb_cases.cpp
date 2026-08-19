// Parity runners for src/dsp/fx-reverb.ts.
//
// Two shapes of case, three settings each. The setup comes straight out of the
// golden's own params: `size`/`decayMs` are the plain constructor arguments,
// while `dspParams` is the 19-entry FX parameter vector the reference held in a
// Float32Array - so it is rebuilt as float here, not double. p[P_RV_SIZE] is
// float(0.55) and the constructor's `size` is double 0.55; they are genuinely
// different numbers and the reference uses both.
#include <vector>

#include "../parity.h"
#include "../../src/reverb.h"

using parity::Case;

static bool run_reverb(const Case& c, std::vector<float>& out) {
  if (!c.hasInput()) return false;

  const std::vector<double> dsp = c.p.nums("dspParams");
  if (dsp.size() < 19) return false;
  float p[19];
  for (int i = 0; i < 19; ++i) p[i] = static_cast<float>(dsp[static_cast<size_t>(i)]);

  sigil::fx::Reverb rv(48000.0, c.p.num("size"), c.p.num("decayMs"));
  out.assign(static_cast<size_t>(c.frames) * static_cast<size_t>(c.channels), 0.0f);

  if (c.channels == 1) {
    for (int i = 0; i < c.frames; ++i) {
      const double x = static_cast<double>(c.input[static_cast<size_t>(i)]);
      out[static_cast<size_t>(i)] = static_cast<float>(rv.process(x, p));
    }
    return true;
  }
  if (c.channels == 2) {
    for (int i = 0; i < c.frames; ++i) {
      const double l = static_cast<double>(c.input[static_cast<size_t>(i) * 2]);
      const double r = static_cast<double>(c.input[static_cast<size_t>(i) * 2 + 1]);
      rv.processStereo(l, r, p);
      out[static_cast<size_t>(i) * 2] = static_cast<float>(rv.oL);
      out[static_cast<size_t>(i) * 2 + 1] = static_cast<float>(rv.oR);
    }
    return true;
  }
  return false;
}
PARITY_RUNNER("reverb_", run_reverb);
