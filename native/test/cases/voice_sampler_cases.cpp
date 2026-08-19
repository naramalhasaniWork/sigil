// Parity runners for sampler-voice.ts.
//
// Two independent things are checked, and the split is the point:
// `source_sampler_builtin` proves buildDefault() reproduces the module's
// built-in tone, and `voice_sampler_*` then exercises playback, looping, pitch
// and the character stage on top of it. If the source material is wrong every
// voice case fails for one reason and none of them tell you anything.
//
// The `voice_sampler_injected_*` cases carry an asset: the golden injected
// those exact bytes via setActiveSample(data, 48000, 261.6255653) BEFORE
// allocating the voice, so we do the same and never synthesise material here.
#include <string>
#include <vector>

#include "../parity.h"
#include "../../src/voice-sampler.h"

using parity::Case;

namespace {

// Descriptor order. The golden records overrides keyed by parameter id, so the
// mapping from id to index lives here and cannot silently drift.
const char* const kParamIds[sigil::sampler::kNumParams] = {
  "sample-start", "sample-end", "loop-mode", "loop-start", "loop-length",
  "loop-fade", "reverse", "tune", "fine",
  "filter-cutoff", "filter-resonance", "filter-model",
  "amp-attack", "amp-decay", "amp-sustain", "amp-release",
  "drive", "crush", "amp-velocity", "wobble", "wobble-rate",
};

}  // namespace

// ---------------------------------------------------------------------------
// buildDefault(): the module's built-in struck tone.
// ---------------------------------------------------------------------------
static bool run_source_sampler_builtin(const Case& c, std::vector<float>& out) {
  const std::vector<float> src = sigil::sampler::buildDefault();
  if (static_cast<int>(src.size()) != c.frames) return false;
  out = src;
  return true;
}
PARITY_RUNNER("source_sampler_builtin", run_source_sampler_builtin);

// ---------------------------------------------------------------------------
// SamplerVoice, rendered the way the worklet does it: every parameter set by
// descriptor index (defaults first, then the case's overrides) BEFORE noteOn,
// then render() ADDING into one zeroed buffer across the recorded irregular
// block sequence, with noteOff fired before the block containing the recorded
// note-off sample.
// ---------------------------------------------------------------------------
static bool run_voice_sampler(const Case& c, std::vector<float>& out) {
  out.assign(static_cast<size_t>(c.frames) * static_cast<size_t>(c.channels), 0.0f);

  // One store per case: nothing leaks between cases, which is exactly what the
  // module-level globals in the TS would have done.
  sigil::sampler::SampleStore store;
  if (!c.assetData.empty()) {
    store.setActiveSample(c.assetData.data(), static_cast<int>(c.assetData.size()),
                          c.p.num("sampleSr"), c.p.num("sampleRootHz"));
  }

  sigil::sampler::SamplerVoice v(48000.0, store);
  for (int i = 0; i < sigil::sampler::kNumParams; ++i) {
    v.setParam(i, sigil::sampler::kDefaults[i]);
  }
  for (int i = 0; i < sigil::sampler::kNumParams; ++i) {
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
PARITY_RUNNER("voice_sampler_", run_voice_sampler);
