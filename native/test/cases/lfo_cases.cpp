// Parity runners for lfo.ts (addOsc + the Lfo class).
//
// Modelled on core_cases.cpp: every setup value is read out of the golden's own
// recorded parameters, nothing is regenerated, and `out` is filled with exactly
// frames*channels interleaved floats.
#include <algorithm>
#include <string>
#include <vector>

#include "../parity.h"
#include "../../src/envelope-lfo.h"

using parity::Case;

// ---------------------------------------------------------------------------
// addOsc: block form, phase/tri state in caller-owned double arrays.
//
// The TS accumulates into a Float64Array and only narrows to f32 when the
// golden is written, so the accumulator here is double and the single
// static_cast<float> at the end is the only rounding.
// ---------------------------------------------------------------------------
static bool run_addosc(const Case& c, std::vector<float>& out) {
  const size_t n = static_cast<size_t>(c.frames);
  out.assign(n, 0.0f);
  std::vector<double> acc(n, 0.0);  // sized once, before any render loop
  double ph[4] = {0, 0, 0, 0};
  double tri[4] = {0, 0, 0, 0};

  if (c.id == "lfo_addosc_triangle_blocked") {
    // Fresh zeroed ph/tri; one voice, rendered across an irregular block
    // pattern to prove the integrator state survives call boundaries.
    const std::vector<int> pattern = c.p.ints("blockPattern");
    if (pattern.empty()) return false;
    const double inc = c.p.num("hz") / 48000.0;
    const double gain = c.p.num("gain");
    int i = 0, k = 0;
    while (i < c.frames) {
      const int m = std::min(pattern[static_cast<size_t>(k) % pattern.size()], c.frames - i);
      sigil::addOsc(c.p.num("shape"), acc.data() + i, m, ph, tri, 0, inc, 0.5, gain);
      i += m; k++;
    }
  } else {
    const std::vector<double> phaseInit = c.p.nums("phaseInit");
    const std::vector<double> triInit = c.p.nums("triInit");
    if (phaseInit.size() != 4 || triInit.size() != 4) return false;
    for (int u = 0; u < 4; ++u) {
      ph[u] = phaseInit[static_cast<size_t>(u)];
      tri[u] = triInit[static_cast<size_t>(u)];
    }
    const double shape = c.p.num("shape");
    const double pw = c.p.num("pw");
    // Two voices summed into one buffer, u=0 then u=1, exactly as a unison
    // oscillator does it. Order matters: it is float64 accumulation, but the
    // TS order is the contract.
    sigil::addOsc(shape, acc.data(), c.frames, ph, tri, 0, c.p.num("inc0"), pw, c.p.num("gain0"));
    sigil::addOsc(shape, acc.data(), c.frames, ph, tri, 1, c.p.num("inc1"), pw, c.p.num("gain1"));
  }

  for (size_t i = 0; i < n; ++i) out[i] = static_cast<float>(acc[i]);
  return true;
}
PARITY_RUNNER("lfo_addosc_", run_addosc);

// ---------------------------------------------------------------------------
// The Lfo class.
//
// Call order is part of the case: setRate, setShape, setDepth, setDelayMs,
// seed, trigger(keysync). seed() draws two randoms before any next(), so
// reordering it changes the whole random stream.
// ---------------------------------------------------------------------------
static void configure(sigil::Lfo& l, double rate, double shape, double depth,
                      double delayMs, double seed, bool keysync) {
  l.setRate(rate);
  l.setShape(shape);
  l.setDepth(depth);
  l.setDelayMs(delayMs);
  l.seed(seed);
  l.trigger(keysync);
}

static bool run_lfo(const Case& c, std::vector<float>& out) {
  const double sr = 48000.0;
  out.assign(static_cast<size_t>(c.frames), 0.0f);

  if (c.id == "lfo_rate_clamps") {
    // Three segments concatenated, a fresh Lfo for each rate: 0, negative, and
    // above sr*0.45.
    const std::vector<double> rates = c.p.nums("rates");
    const int per = static_cast<int>(c.p.num("framesPerRate"));
    if (rates.empty() || per <= 0) return false;
    size_t k = 0;
    for (double rate : rates) {
      sigil::Lfo l(sr);
      configure(l, rate, c.p.num("shape"), 1.0, 0.0, c.p.num("seed"), true);
      for (int i = 0; i < per && k < out.size(); ++i) out[k++] = static_cast<float>(l.next());
    }
    return k == out.size();
  }

  if (c.id.rfind("lfo_shape", 0) == 0) {
    sigil::Lfo l(sr);
    configure(l, c.p.num("rateHz"), c.p.num("shape"), c.p.num("depth"),
              c.p.num("delayMs"), c.p.num("seed"), c.p.flag("keysync", false));
    for (int i = 0; i < c.frames; ++i) out[static_cast<size_t>(i)] = static_cast<float>(l.next());
    return true;
  }
  return false;
}
PARITY_RUNNER("lfo_", run_lfo);
