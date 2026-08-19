// Parity runners for granular-voice.ts.
//
// Two independent things are checked here, which is the whole point of the
// harness splitting them: `source_granular` proves getSource() reproduces the
// shared source material bit for bit, and `voice_granular_*` then exercises the
// grain scheduler on top of it. If the source is wrong every voice case fails
// for one reason and none of them tell you anything.
#include <string>
#include <vector>

#include "../parity.h"
#include "../../src/voice-granular.h"

using parity::Case;

namespace {

// Descriptor order. The golden records overrides keyed by parameter id, so the
// mapping from id to index lives here and cannot silently drift.
const char* const kParamIds[sigil::granular::kNumParams] = {
  "grain-density", "grain-size", "position", "spray", "pitch-scatter",
  "reverse", "window-shape", "amp-attack", "amp-decay", "amp-sustain",
  "amp-release",
};

}  // namespace

// ---------------------------------------------------------------------------
// getSource(): the module-private source buffer.
// ---------------------------------------------------------------------------
static bool run_source_granular(const Case& c, std::vector<float>& out) {
  const std::vector<float> src = sigil::granular::buildSource();
  if (static_cast<int>(src.size()) != c.frames) return false;
  out = src;
  return true;
}
PARITY_RUNNER("source_granular", run_source_granular);

// ---------------------------------------------------------------------------
// GranularVoice, rendered the way the worklet does it: every parameter set by
// descriptor index (defaults first, then the case's overrides) BEFORE noteOn,
// then render() ADDING into one zeroed buffer across the recorded irregular
// block sequence, with noteOff fired before the block containing the recorded
// note-off sample.
// ---------------------------------------------------------------------------
static bool run_voice_granular(const Case& c, std::vector<float>& out) {
  out.assign(static_cast<size_t>(c.frames) * static_cast<size_t>(c.channels), 0.0f);

  sigil::granular::GranularVoice v(48000.0);
  for (int i = 0; i < sigil::granular::kNumParams; ++i) {
    v.setParam(i, sigil::granular::kDefaults[i]);
  }
  for (int i = 0; i < sigil::granular::kNumParams; ++i) {
    const std::string key = std::string("overrides.") + kParamIds[i];
    if (c.p.has(key)) v.setParam(i, c.p.num(key));
  }

  v.noteOn(c.p.num("freqHz"), c.p.num("velocity"), static_cast<int>(c.p.num("voiceIndex")));

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
  return off == c.frames;
}
PARITY_RUNNER("voice_granular_", run_voice_granular);
