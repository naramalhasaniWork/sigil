// Parity runners for fx.ts (the master FX chain).
//
// Setup order is the golden's own, and it matters: construct, setParam every
// descriptor default, setParam the overrides, reset(), then push the recorded
// irregular block pattern through ONE buffer back to back.
#include <string>
#include <vector>

#include "../parity.h"
#include "../../src/fx-chain.h"

using parity::Case;

namespace {

sigil::fxchain::FxChain* makeChain(const Case& c, sigil::fxchain::FxChain& fx) {
  using namespace sigil::fxchain;
  for (int i = 0; i < N_PARAMS; i++) fx.setParam(i, def(i));
  // Overrides arrive as `overrides.<descriptor-id>` keys in params.tsv.
  for (const auto& kv : c.p.all()) {
    if (kv.first.rfind("overrides.", 0) != 0) continue;
    const std::string id = kv.first.substr(10);
    const int idx = paramIndexById(id);
    if (idx < 0) return nullptr;  // unknown parameter -> refuse, never guess
    fx.setParam(idx, std::strtod(kv.second.c_str(), nullptr));
  }
  fx.reset();
  return &fx;
}

bool run_fxchain(const Case& c, std::vector<float>& out) {
  if (c.id.rfind("fxchain_", 0) != 0) return false;
  const std::string mode = c.p.str("mode", "");
  if (mode != "mono" && mode != "stereo") return false;
  const std::vector<int> blocks = c.p.ints("blockSizes");
  if (blocks.empty()) return false;
  if (!c.hasInput() || c.inFrames != c.frames) return false;

  sigil::fxchain::FxChain fx(48000.0);
  if (makeChain(c, fx) == nullptr) return false;

  // The chain rewrites its buffer in place, exactly as the reference does.
  std::vector<float> bufL = c.inputChannel(0);
  std::vector<float> bufR = (c.channels == 2) ? c.inputChannel(1) : std::vector<float>();

  int off = 0;
  for (int b : blocks) {
    if (off + b > c.frames) return false;
    if (mode == "mono") fx.process(bufL.data() + off, b);
    else fx.processStereo(bufL.data() + off, bufR.data() + off, b);
    off += b;
  }
  if (off != c.frames) return false;

  out.assign(static_cast<size_t>(c.frames) * static_cast<size_t>(c.channels), 0.0f);
  for (int i = 0; i < c.frames; i++) {
    if (c.channels == 2) {
      out[static_cast<size_t>(i) * 2] = bufL[static_cast<size_t>(i)];
      out[static_cast<size_t>(i) * 2 + 1] = bufR[static_cast<size_t>(i)];
    } else {
      out[static_cast<size_t>(i)] = bufL[static_cast<size_t>(i)];
    }
  }
  return true;
}

}  // namespace

PARITY_RUNNER("fxchain_", run_fxchain);
