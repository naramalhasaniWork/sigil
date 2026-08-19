// Parity runners for fm-voice.ts.
//
// Setup comes entirely out of the golden's own recorded parameters: block
// sizes, note frequency, velocity, voice index, the noteOff point, and the
// override set. The only thing hard-coded here is FM_DESCRIPTOR's parameter
// ORDER and defaults, because applyParams() in the harness sets parameters by
// descriptor index and the golden records overrides by id.
#include <string>
#include <vector>

#include "../parity.h"
#include "../../src/voice-fm.h"

using parity::Case;

namespace {

// FM_DESCRIPTOR parameter ids, in descriptor order. Index into this is the
// index fm-voice.ts's setParam() expects.
const char* const kIds[sigil::fm::kNumParams] = {
    "algorithm",
    "op1-ratio", "op1-fine", "op1-level",
    "op2-ratio", "op2-fine", "op2-level",
    "op3-ratio", "op3-fine", "op3-level",
    "op4-ratio", "op4-fine", "op4-level",
    "index", "key-scale", "feedback", "spread", "balance",
    "amp-attack", "amp-decay", "amp-sustain", "amp-release",
    "mod-attack", "mod-decay", "mod-sustain", "mod-release",
};

bool run_voice_fm(const Case& c, std::vector<float>& out) {
  if (c.channels != 1) return false;
  out.assign(static_cast<size_t>(c.frames), 0.0f);

  sigil::FmVoice v(48000.0);

  // harness applyParams(): every descriptor default first, then the overrides,
  // each through setParam(index, value) - the order matters because setParam
  // re-derives routing and envelopes as it goes.
  for (int i = 0; i < sigil::fm::kNumParams; ++i) {
    v.setParam(i, static_cast<double>(sigil::fm::kDefaults[i]));
  }
  for (int i = 0; i < sigil::fm::kNumParams; ++i) {
    const std::string key = std::string("overrides.") + kIds[i];
    if (c.p.has(key)) v.setParam(i, c.p.num(key));
  }

  v.noteOn(c.p.num("freqHz"), c.p.num("velocity"), static_cast<int>(c.p.num("voiceIndex")));

  const std::vector<int> blocks = c.p.ints("blockSizes");
  if (blocks.empty()) return false;
  const int noteOffAt = static_cast<int>(c.p.num("noteOffBeforeBlockContaining"));

  int off = 0;
  bool released = false;
  for (int b : blocks) {
    if (off + b > c.frames) return false;
    if (!released && off + b > noteOffAt) { v.noteOff(); released = true; }
    v.render(out.data(), off, b);
    off += b;
  }
  return off == c.frames;
}

}  // namespace

PARITY_RUNNER("voice_fm_", run_voice_fm);
