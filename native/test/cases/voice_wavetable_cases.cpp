// Parity runners for src/dsp/wavetable-voice.ts.
//
// The case setup is read out of the golden's own recorded parameters, so the
// C++ and the TS cannot disagree about what is being rendered: parameter
// defaults first (by descriptor index, exactly as scripts/golden/harness.mjs
// applyParams does), then the recorded overrides by parameter id, then noteOn,
// then render across the recorded irregular block sequence with noteOff fired
// before the block containing sample 12000. render() ADDS into a zeroed buffer.
#include <string>
#include <vector>

#include "../parity.h"
#include "../../src/voice-wavetable.h"

using parity::Case;

namespace {

int paramIndexFor(const std::string& id) {
  for (int i = 0; i < sigil::kWavetableParamCount; ++i) {
    if (id == sigil::kWavetableParamIds[i]) return i;
  }
  return -1;
}

bool run_voice_wavetable(const Case& c, std::vector<float>& out) {
  const double sr = 48000.0;
  const int frames = c.frames;
  out.assign(static_cast<size_t>(frames) * static_cast<size_t>(c.channels), 0.0f);
  if (c.channels != 1) return false;

  sigil::WavetableVoice v(sr);

  // applyParams: every descriptor default, then the overrides this case names.
  for (int i = 0; i < sigil::kWavetableParamCount; ++i) {
    v.setParam(i, sigil::kWavetableParamDefaults[i]);
  }
  const std::string prefix = "overrides.";
  for (const auto& kv : c.p.all()) {
    if (kv.first.rfind(prefix, 0) != 0) continue;
    const std::string id = kv.first.substr(prefix.size());
    const int idx = paramIndexFor(id);
    if (idx < 0) {
      std::fprintf(stderr, "voice_wavetable: unknown parameter id '%s'\n", id.c_str());
      return false;
    }
    v.setParam(idx, c.p.num(kv.first));
  }

  v.noteOn(c.p.num("freqHz"), c.p.num("velocity"), c.p.num("voiceIndex"));

  const std::vector<int> blocks = c.p.ints("blockSizes");
  if (blocks.empty()) return false;
  const int noteOffAt = static_cast<int>(c.p.num("noteOffBeforeBlockContaining"));

  int off = 0;
  bool released = false;
  for (int b : blocks) {
    if (!released && off + b > noteOffAt) { v.noteOff(); released = true; }
    v.render(out.data(), off, b);
    off += b;
  }
  return off == frames;
}

}  // namespace

PARITY_RUNNER("voice_wavetable_", run_voice_wavetable);
