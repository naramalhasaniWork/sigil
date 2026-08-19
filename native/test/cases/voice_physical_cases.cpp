// Parity runners for physical-voice.ts.
//
// Reproduces scripts/golden/cases-voices.mjs renderVoice() literally: allocate
// at 48 kHz, set EVERY descriptor parameter to its default by index, then apply
// the case's overrides by parameter id, then noteOn. Rendering is additive into
// one zeroed buffer across the recorded irregular block pattern, with noteOff
// fired before the first block that would cross sample 12000.
#include <string>
#include <vector>

#include "../parity.h"
#include "../../src/voice-physical.h"

using parity::Case;

namespace {

// Descriptor order. The goldens address overrides by id, the voice by index.
const char* const kParamIds[12] = {
    "material", "structure", "decay",         "damping",  "position", "air",
    "exciter-type", "grit",  "hardness",      "exciter-tone", "release", "level"};

const double kDefaults[12] = {0.62, 0.25, 900.0, 0.35, 0.28, 0.55,
                              0.0,  0.4,  3.0,   4500.0, 120.0, 0.75};

bool run_voice_physical(const Case& c, std::vector<float>& out) {
  const int frames = c.frames;
  out.assign(static_cast<size_t>(frames), 0.0f);  // render() ADDS into this.

  sigil::PhysicalVoice v(48000.0);
  for (int i = 0; i < 12; ++i) v.setParam(i, kDefaults[i]);
  for (int i = 0; i < 12; ++i) {
    const std::string key = std::string("overrides.") + kParamIds[i];
    if (c.p.has(key)) v.setParam(i, c.p.num(key));
  }

  v.noteOn(c.p.num("freqHz"), c.p.num("velocity"), static_cast<int>(c.p.num("voiceIndex")));

  const std::vector<int> blocks = c.p.ints("blockSizes");
  const int noteOffAt = static_cast<int>(c.p.num("noteOffBeforeBlockContaining"));
  int off = 0;
  bool released = false;
  for (size_t b = 0; b < blocks.size(); ++b) {
    const int len = blocks[b];
    if (!released && off + len > noteOffAt) { v.noteOff(); released = true; }
    v.render(out.data(), off, len);
    off += len;
  }
  return off == frames;
}

}  // namespace

PARITY_RUNNER("voice_physical_", run_voice_physical);
