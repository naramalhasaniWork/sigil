// Port of the audio-thread half of src/audio/worklet/sigil-processor.ts.
//
// What is carried across:
//   * One VoiceManager per registered engine, all built up front, so switching
//     engines is a pointer swap and never an allocation on the audio thread.
//   * The flat parameter address space of src/audio/param-space.ts: 0+ engine,
//     1000+ fx, 2000+ magic. setParamByAddress is the single routing point, the
//     same way the worklet's 'params' message is.
//   * The mono-voice / stereo-fx signal flow of process(), including the
//     left-then-copy-to-right ordering, which is not cosmetic: the FX chains see
//     an identical pair and derive their width from it.
//
// What is deliberately NOT carried across, because it is browser plumbing:
//   * the postMessage protocol (the plugin uses parameters and MIDI instead),
//   * the 60-second capture buffer (the host records),
//   * the offline `bounce` processorOptions path.
//
// The one behavioural difference from the worklet, stated plainly: the worklet
// can only address the ACTIVE engine's parameters, because the web UI shows one
// engine at a time. A plugin must publish a static parameter list, so every
// engine's parameters exist at once and an engine-section write carries which
// engine it is for. For the active engine the behaviour is identical.
//
// Allocation: everything is built in prepare(). render(), the note entry points
// and setParamByAddress allocate nothing and throw nothing.
#pragma once

#include <memory>
#include <vector>

#include "fx-chain.h"
#include "fx-magic.h"
#include "sigil-descriptors.h"
#include "voice-analog.h"
#include "voice-fm.h"
#include "voice-granular.h"
#include "voice-manager.h"
#include "voice-physical.h"
#include "voice-sampler.h"
#include "voice-wavetable.h"

namespace sigil {

enum class ParamSection { kEngine, kFx, kMagic };

struct ParamAddress {
  ParamSection section;
  int index;
};

/** Port of sectionOf() in src/audio/param-space.ts. */
inline ParamAddress sectionOf(int address) {
  if (address >= desc::kMagicParamBase) {
    return {ParamSection::kMagic, address - desc::kMagicParamBase};
  }
  if (address >= desc::kFxParamBase) {
    return {ParamSection::kFx, address - desc::kFxParamBase};
  }
  return {ParamSection::kEngine, address - desc::kEngineParamBase};
}

/** Port of addressOf() in src/audio/param-space.ts. */
inline int addressOf(ParamSection section, int index) {
  if (section == ParamSection::kFx) return desc::kFxParamBase + index;
  if (section == ParamSection::kMagic) return desc::kMagicParamBase + index;
  return desc::kEngineParamBase + index;
}

class SigilEngine {
public:
  static constexpr int kMaxVoices = 16;

  /** Builds the whole voice pool. Never call this from the audio thread. */
  void prepare(double sampleRate, int maxVoices = kMaxVoices) {
    sampleRate_ = sampleRate;
    fx_ = std::make_unique<fxchain::FxChain>(sampleRate);
    magic_ = std::make_unique<magic::MagicChain>(sampleRate);
    store_ = std::make_unique<sampler::SampleStore>();
    store_->ensureDefault();

    managers_.clear();
    managers_.reserve(static_cast<size_t>(desc::kEngineCount));
    for (int e = 0; e < desc::kEngineCount; e++) {
      managers_.push_back(makeManager(e, sampleRate, maxVoices));
    }
    if (active_ < 0 || active_ >= desc::kEngineCount) active_ = defaultEngineIndex();
  }

  bool prepared() const { return !managers_.empty(); }
  double sampleRate() const { return sampleRate_; }

  static int defaultEngineIndex() {
    for (int e = 0; e < desc::kEngineCount; e++) {
      const char* a = desc::kEngines[e].id;
      const char* b = desc::kDefaultEngineId;
      int i = 0;
      while (a[i] != '\0' && a[i] == b[i]) i++;
      if (a[i] == '\0' && b[i] == '\0') return e;
    }
    return 0;
  }

  int activeEngine() const { return active_; }

  /** 'setEngine' in the worklet: release what is sounding, then swap. */
  void setEngine(int engineIndex) {
    if (engineIndex < 0 || engineIndex >= static_cast<int>(managers_.size())) return;
    if (engineIndex == active_) return;
    if (!managers_.empty()) managers_[static_cast<size_t>(active_)]->allNotesOff();
    active_ = engineIndex;
  }

  void noteOn(double midiNote, double velocity) {
    if (managers_.empty()) return;
    managers_[static_cast<size_t>(active_)]->noteOn(midiNote, velocity);
  }

  void noteOff(double midiNote) {
    if (managers_.empty()) return;
    managers_[static_cast<size_t>(active_)]->noteOff(midiNote);
  }

  void allNotesOff() {
    for (auto& m : managers_) m->allNotesOff();
  }

  void setTuning(double divisions, double refNote, double refHz) {
    for (auto& m : managers_) {
      m->tuning.setEqualDivisions(divisions);
      m->tuning.setReference(refNote, refHz);
    }
  }

  /**
   * The single routing point, matching the worklet's 'params' handler.
   * `engineIndex` is ignored for the fx and magic sections.
   */
  void setParamByAddress(int address, int engineIndex, double value) {
    const ParamAddress a = sectionOf(address);
    if (a.section == ParamSection::kFx) {
      if (fx_) fx_->setParam(a.index, value);
    } else if (a.section == ParamSection::kMagic) {
      if (magic_) magic_->setParam(a.index, value);
    } else if (engineIndex >= 0 && engineIndex < static_cast<int>(managers_.size())) {
      managers_[static_cast<size_t>(engineIndex)]->setParam(a.index, value);
    }
  }

  double engineParam(int engineIndex, int index) const {
    if (engineIndex < 0 || engineIndex >= static_cast<int>(managers_.size())) return 0.0;
    return managers_[static_cast<size_t>(engineIndex)]->paramValue(index);
  }

  int activeVoiceCount() const {
    if (managers_.empty()) return 0;
    return managers_[static_cast<size_t>(active_)]->activeCount();
  }

  /** The voice bus alone, with no effects. Zeroes first, because the manager's
   *  render is additive - the same contract as `left.fill(0)` in the worklet. */
  void renderVoicesOnly(float* out, int count) {
    if (managers_.empty() || out == nullptr || count <= 0) return;
    for (int i = 0; i < count; i++) out[i] = 0.0f;
    managers_[static_cast<size_t>(active_)]->render(out, count);
  }

  void reset() {
    allNotesOff();
    if (fx_) fx_->reset();
    if (magic_) magic_->reset();
  }

  sampler::SampleStore* sampleStore() { return store_.get(); }

  /**
   * `right` may be null for a mono host bus, exactly as the worklet's bounce
   * path renders into a single channel.
   */
  void render(float* left, float* right, int count) {
    if (managers_.empty() || left == nullptr || count <= 0) return;
    renderVoicesOnly(left, count);
    if (right != nullptr) {
      for (int i = 0; i < count; i++) right[i] = left[i];
      fx_->processStereo(left, right, count);
      magic_->processStereo(left, right, count);
    } else {
      fx_->process(left, count);
      magic_->process(left, count);
    }
  }

private:
  std::unique_ptr<VoiceManagerBase> makeManager(int engineIndex, double sr, int maxVoices) {
    const desc::EngineDesc& d = desc::kEngines[engineIndex];
    std::vector<double> defaults(static_cast<size_t>(d.count));
    for (int i = 0; i < d.count; i++) defaults[static_cast<size_t>(i)] = d.params[i].def;
    const double* def = defaults.data();

    switch (engineIndex) {
      case 0:
        return std::make_unique<VoiceManager<AnalogVoice>>(
            def, d.count, maxVoices, [sr] { return AnalogVoice(sr); });
      case 1:
        return std::make_unique<VoiceManager<FmVoice>>(
            def, d.count, maxVoices, [sr] { return FmVoice(sr); });
      case 2:
        return std::make_unique<VoiceManager<PhysicalVoice>>(
            def, d.count, maxVoices, [sr] { return PhysicalVoice(sr); });
      case 3:
        return std::make_unique<VoiceManager<granular::GranularVoice>>(
            def, d.count, maxVoices, [sr] { return granular::GranularVoice(sr); });
      case 4: {
        sampler::SampleStore* store = store_.get();
        return std::make_unique<VoiceManager<sampler::SamplerVoice>>(
            def, d.count, maxVoices,
            [sr, store] { return sampler::SamplerVoice(sr, *store); });
      }
      default:
        return std::make_unique<VoiceManager<WavetableVoice>>(
            def, d.count, maxVoices, [sr] { return WavetableVoice(sr); });
    }
  }

  std::vector<std::unique_ptr<VoiceManagerBase>> managers_;
  std::unique_ptr<fxchain::FxChain> fx_;
  std::unique_ptr<magic::MagicChain> magic_;
  std::unique_ptr<sampler::SampleStore> store_;
  double sampleRate_ = 48000.0;
  int active_ = defaultEngineIndex();
};

}  // namespace sigil
