#include "PluginProcessor.h"

#include "PluginEditor.h"
#include "param-range.h"

#include <cmath>

namespace {

juce::String labelFor(const sigil::desc::ParamDesc& p) {
  const juce::String unit(p.unit);
  if (unit == "hz") return "Hz";
  if (unit == "db") return "dB";
  if (unit == "ms") return "ms";
  if (unit == "pct") return "%";
  if (unit == "semitones") return "st";
  return {};
}

double clampToRange(const sigil::desc::ParamDesc& p, double v) {
  if (!std::isfinite(v)) return p.min;
  return v < p.min ? p.min : (v > p.max ? p.max : v);
}

}  // namespace

SigilAudioProcessor::SigilAudioProcessor()
    : AudioProcessor(BusesProperties().withOutput("Output", juce::AudioChannelSet::stereo(),
                                                  true)) {
  buildParameters();
}

void SigilAudioProcessor::buildParameters() {
  using namespace sigil::desc;

  juce::StringArray engineNames;
  for (int e = 0; e < kEngineCount; e++) engineNames.add(kEngines[e].name);

  // Version hint 1 throughout: these ids are the same ids the web app saves, so
  // they are not going to be renamed without a format change anyway.
  auto* choice = new juce::AudioParameterChoice(juce::ParameterID("engine", 1), "Engine",
                                                engineNames,
                                                sigil::SigilEngine::defaultEngineIndex());
  engineParam_ = choice;
  addParameter(choice);

  refs_.reserve(static_cast<size_t>(200));

  auto addSection = [this](const EngineDesc& d, sigil::ParamSection section, int engineIndex,
                           const juce::String& idPrefix, const juce::String& namePrefix) {
    for (int i = 0; i < d.count; i++) {
      const ParamDesc& p = d.params[i];
      auto* ap = new juce::AudioParameterFloat(
          juce::ParameterID(idPrefix + p.id, 1), namePrefix + " " + p.name, sigil::rangeFor(p),
          static_cast<float>(p.def),
          juce::AudioParameterFloatAttributes().withLabel(labelFor(p)));
      addParameter(ap);
      SigilParamRef ref;
      ref.param = ap;
      ref.section = section;
      ref.engineIndex = engineIndex;
      ref.index = i;
      ref.exact = p.def;
      ref.lastNormalised = ap->convertTo0to1(static_cast<float>(p.def));
      refs_.push_back(ref);
    }
  };

  for (int e = 0; e < kEngineCount; e++) {
    const EngineDesc& d = kEngines[e];
    addSection(d, sigil::ParamSection::kEngine, e, juce::String(d.id) + ".", juce::String(d.name));
  }
  addSection(kFxDesc, sigil::ParamSection::kFx, -1, "fx.", "FX");
  addSection(kMagicDesc, sigil::ParamSection::kMagic, -1, "magic.", "Character");
}

void SigilAudioProcessor::prepareToPlay(double sampleRate, int) {
  engine_.prepare(sampleRate);
  lastEngineIndex_ = engineParam_->getIndex();
  engine_.setEngine(lastEngineIndex_);
  pushAllParameters();
}

void SigilAudioProcessor::releaseResources() { engine_.allNotesOff(); }

bool SigilAudioProcessor::isBusesLayoutSupported(const BusesLayout& layouts) const {
  if (layouts.getMainInputChannels() != 0) return false;
  const auto out = layouts.getMainOutputChannelSet();
  return out == juce::AudioChannelSet::stereo() || out == juce::AudioChannelSet::mono();
}

/** Every parameter, unconditionally. Used after prepare and after a state load. */
void SigilAudioProcessor::pushAllParameters() {
  for (SigilParamRef& r : refs_) {
    const float n = r.param->getValue();
    if (n != r.lastNormalised) {
      r.lastNormalised = n;
      r.exact = static_cast<double>(r.param->convertFrom0to1(n));
    }
    engine_.setParamByAddress(sigil::addressOf(r.section, r.index), r.engineIndex, r.exact);
  }
}

/**
 * Polled once per block. Allocation-free and lock-free: it walks a preallocated
 * vector and only calls into the DSP when a value actually moved, which is what
 * the worklet's 'params' message did on the web side.
 */
void SigilAudioProcessor::pushChangedParameters() {
  for (SigilParamRef& r : refs_) {
    const float n = r.param->getValue();
    if (n != r.lastNormalised) {
      r.lastNormalised = n;
      r.exact = static_cast<double>(r.param->convertFrom0to1(n));
      engine_.setParamByAddress(sigil::addressOf(r.section, r.index), r.engineIndex, r.exact);
    }
  }
}

void SigilAudioProcessor::handleMidi(const juce::MidiMessage& m) {
  if (m.isNoteOn()) {
    engine_.noteOn(m.getNoteNumber(), m.getFloatVelocity());
  } else if (m.isNoteOff()) {
    engine_.noteOff(m.getNoteNumber());
  } else if (m.isAllNotesOff() || m.isAllSoundOff()) {
    engine_.allNotesOff();
  }
}

void SigilAudioProcessor::renderSegment(juce::AudioBuffer<float>& buffer, int startSample,
                                        int numSamples) {
  if (numSamples <= 0) return;
  float* left = buffer.getWritePointer(0, startSample);
  float* right = buffer.getNumChannels() > 1 ? buffer.getWritePointer(1, startSample) : nullptr;
  engine_.render(left, right, numSamples);
}

void SigilAudioProcessor::processBlock(juce::AudioBuffer<float>& buffer,
                                       juce::MidiBuffer& midi) {
  juce::ScopedNoDenormals noDenormals;

  const int numSamples = buffer.getNumSamples();
  for (int ch = 0; ch < buffer.getNumChannels(); ++ch) buffer.clear(ch, 0, numSamples);
  if (!engine_.prepared() || numSamples == 0) return;

  // Engine switching is a pointer swap in SigilEngine, exactly as in the
  // worklet's 'setEngine' handler, and it releases what is sounding first.
  const int wanted = engineParam_->getIndex();
  if (wanted != lastEngineIndex_) {
    lastEngineIndex_ = wanted;
    engine_.setEngine(wanted);
  }
  pushChangedParameters();

  // Notes played on the plugin's own interface, before any host MIDI in this
  // block. They reach the same allocator by the same calls handleMidi() makes,
  // so there is one path from a note to a voice.
  // Collected here, emitted after the incoming buffer has been consumed and
  // cleared below — a MidiBuffer cannot be appended to while it is iterated.
  juce::MidiBuffer uiOut;
  drainUiEvents(uiOut);

  // Sample-accurate MIDI: render up to each event, apply it, carry on. This is
  // the same shape as the segment-driven parity harness, so what the plugin
  // does per block is what the goldens measure.
  int cursor = 0;
  for (const auto meta : midi) {
    const int pos = juce::jlimit(0, numSamples, meta.samplePosition);
    if (pos > cursor) {
      renderSegment(buffer, cursor, pos - cursor);
      cursor = pos;
    }
    handleMidi(meta.getMessage());
  }
  renderSegment(buffer, cursor, numSamples - cursor);

  // Anything past the first two channels gets the left signal; a surround
  // context is not something this instrument claims to speak.
  for (int ch = 2; ch < buffer.getNumChannels(); ++ch) {
    buffer.copyFrom(ch, 0, buffer, 0, 0, numSamples);
  }
  /*
   * Hand the host what was played on SIGIL's own keyboard.
   *
   * Incoming events are consumed above and dropped; an instrument does not pass
   * its input through. What replaces them is the UI's own notes, so arming a
   * track and playing the plugin's keys records real MIDI. Before this the
   * clip was created and stayed empty, which looked like the recording failing
   * rather than nothing having been sent.
   *
   * Timed at sample 0 rather than sample-accurately: a mouse or a computer key
   * arrives on the message thread with no block position to recover, so the
   * honest granularity is the block. That is the same latency you already hear.
   */
  midi.clear();
  midi.addEvents(uiOut, 0, numSamples, 0);
}

// ---------------------------------------------------------------------------
// State. Id-keyed, versioned, and deliberately the same JSON shape as
// src/audio/patch-format.ts so a patch is portable between the web app and the
// plugin. A positional format would silently reinterpret every saved patch the
// first time a parameter is inserted, which is the whole reason that file
// exists - see its header comment.
//
// The plugin holds all six engines' values at once, which the web app does not,
// so those live under an extra "engines" key. loadPatch() in the TypeScript
// ignores keys it does not know, so a plugin-saved patch still loads on the web
// as the active engine plus fx and magic.
// ---------------------------------------------------------------------------
/** The value the DSP is actually being fed - see SigilParamRef. */
double SigilAudioProcessor::exactValueOf(const SigilParamRef& r) const {
  const float n = r.param->getValue();
  if (n == r.lastNormalised) return r.exact;
  return static_cast<double>(r.param->convertFrom0to1(n));
}

void SigilAudioProcessor::getStateInformation(juce::MemoryBlock& destData) {
  using namespace sigil::desc;

  auto* root = new juce::DynamicObject();
  root->setProperty("version", kPatchFormatVersion);

  const int active = engineParam_->getIndex();
  root->setProperty("engineId", juce::String(kEngines[active].id));

  auto keyedFor = [this](sigil::ParamSection section, int engineIndex) {
    auto* obj = new juce::DynamicObject();
    for (const SigilParamRef& r : refs_) {
      if (r.section != section || r.engineIndex != engineIndex) continue;
      const EngineDesc& d = section == sigil::ParamSection::kEngine ? kEngines[engineIndex]
                            : section == sigil::ParamSection::kFx   ? kFxDesc
                                                                    : kMagicDesc;
      obj->setProperty(d.params[r.index].id, exactValueOf(r));
    }
    return juce::var(obj);
  };

  root->setProperty("values", keyedFor(sigil::ParamSection::kEngine, active));
  root->setProperty("fx", keyedFor(sigil::ParamSection::kFx, -1));
  root->setProperty("magic", keyedFor(sigil::ParamSection::kMagic, -1));

  auto* engines = new juce::DynamicObject();
  for (int e = 0; e < kEngineCount; e++) {
    engines->setProperty(kEngines[e].id, keyedFor(sigil::ParamSection::kEngine, e));
  }
  root->setProperty("engines", juce::var(engines));
  root->setProperty("app", "sigil-vst3");

  const juce::String json = juce::JSON::toString(juce::var(root), false);
  destData.replaceAll(json.toRawUTF8(), json.getNumBytesAsUTF8());
}

void SigilAudioProcessor::setStateInformation(const void* data, int sizeInBytes) {
  using namespace sigil::desc;

  juce::StringArray warnings;
  if (data == nullptr || sizeInBytes <= 0) return;

  const juce::String text = juce::String::fromUTF8(static_cast<const char*>(data), sizeInBytes);
  juce::var parsed;
  if (juce::JSON::parse(text, parsed).failed() || !parsed.isObject()) {
    warnings.add("State was not readable JSON; nothing was loaded");
    const juce::ScopedLock sl(warningLock_);
    loadWarnings_ = warnings;
    return;
  }

  const int version = parsed.hasProperty("version") ? static_cast<int>(parsed["version"]) : 1;
  if (version > kPatchFormatVersion) {
    warnings.add("Patch was saved by a newer build (format " + juce::String(version) +
                 "); loading what this build understands");
  }
  if (parsed["values"].isArray()) {
    // Version 1 was positional. The plugin never wrote one, and matching by
    // position across six engines would be a guess, so this is refused rather
    // than silently loading the wrong sound.
    warnings.add("Patch uses the legacy positional format; the plugin will not guess "
                 "which engine those values belong to");
    const juce::ScopedLock sl(warningLock_);
    loadWarnings_ = warnings;
    return;
  }

  auto findRef = [this](sigil::ParamSection section, int engineIndex,
                        int index) -> SigilParamRef* {
    for (SigilParamRef& r : refs_) {
      if (r.section == section && r.engineIndex == engineIndex && r.index == index) return &r;
    }
    return nullptr;
  };

  // fromKeyed() in patch-format.ts: missing ids fall back to the DEFAULT,
  // out-of-range values are CLAMPED, unknown ids are IGNORED, and every
  // recovery is reported.
  auto applyKeyed = [&](const juce::var& keyed, const EngineDesc& d, sigil::ParamSection section,
                        int engineIndex, const juce::String& label) {
    if (!keyed.isObject()) return;
    auto* obj = keyed.getDynamicObject();
    if (obj == nullptr) return;
    int missing = 0, clamped = 0, matched = 0;
    for (int i = 0; i < d.count; i++) {
      const ParamDesc& p = d.params[i];
      SigilParamRef* ref = findRef(section, engineIndex, i);
      if (ref == nullptr) continue;
      const juce::Identifier key(p.id);
      double value;
      if (!obj->hasProperty(key)) {
        value = p.def;
        missing++;
      } else {
        const double raw = static_cast<double>(obj->getProperty(key));
        value = clampToRange(p, raw);
        if (value != raw) clamped++;
        matched++;
      }
      // The exact value is remembered; the normalised float is only what the
      // host sees, so a patch reloads to the value it was saved with rather
      // than to a float round trip of it.
      ref->param->setValueNotifyingHost(ref->param->convertTo0to1(static_cast<float>(value)));
      ref->lastNormalised = ref->param->getValue();
      ref->exact = value;
    }
    int unknown = 0;
    for (const auto& prop : obj->getProperties()) {
      bool known = false;
      for (int i = 0; i < d.count && !known; i++) {
        known = (prop.name.toString() == d.params[i].id);
      }
      if (!known) unknown++;
    }
    if (missing > 0) {
      warnings.add(label + ": " + juce::String(missing) +
                   " parameter(s) not in the patch, using defaults");
    }
    if (clamped > 0) {
      warnings.add(label + ": " + juce::String(clamped) +
                   " value(s) were out of range and were clamped");
    }
    if (unknown > 0) {
      warnings.add(label + ": ignored " + juce::String(unknown) +
                   " unknown parameter(s) - saved by a newer build");
    }
    juce::ignoreUnused(matched);
  };

  // Per-engine block first, then the active engine's "values" on top, so a
  // web-saved patch (which has no "engines" key) still lands correctly.
  const juce::var engines = parsed["engines"];
  if (engines.isObject()) {
    for (int e = 0; e < kEngineCount; e++) {
      const juce::var sub = engines[juce::Identifier(kEngines[e].id)];
      if (sub.isObject()) {
        applyKeyed(sub, kEngines[e], sigil::ParamSection::kEngine, e, kEngines[e].name);
      }
    }
  }

  int activeIndex = -1;
  const juce::String engineId = parsed["engineId"].toString();
  for (int e = 0; e < kEngineCount; e++) {
    if (engineId == kEngines[e].id) activeIndex = e;
  }
  if (activeIndex < 0) {
    activeIndex = sigil::SigilEngine::defaultEngineIndex();
    if (engineId.isNotEmpty()) {
      warnings.add("Unknown engine \"" + engineId + "\"; fell back to " +
                   juce::String(kEngines[activeIndex].name));
    }
  } else if (parsed["values"].isObject()) {
    applyKeyed(parsed["values"], kEngines[activeIndex], sigil::ParamSection::kEngine, activeIndex,
               kEngines[activeIndex].name);
  }
  engineParam_->setValueNotifyingHost(
      engineParam_->convertTo0to1(static_cast<float>(activeIndex)));

  applyKeyed(parsed["fx"], kFxDesc, sigil::ParamSection::kFx, -1, "FX");
  applyKeyed(parsed["magic"], kMagicDesc, sigil::ParamSection::kMagic, -1, "Character");

  if (engine_.prepared()) {
    engine_.setEngine(activeIndex);
    lastEngineIndex_ = activeIndex;
    pushAllParameters();
  }

  const juce::ScopedLock sl(warningLock_);
  loadWarnings_ = warnings;
  for (const auto& w : warnings) juce::Logger::writeToLog("SIGIL state: " + w);
}

juce::StringArray SigilAudioProcessor::lastLoadWarnings() const {
  const juce::ScopedLock sl(warningLock_);
  return loadWarnings_;
}

juce::AudioProcessorEditor* SigilAudioProcessor::createEditor() {
  return new SigilAudioProcessorEditor(*this);
}

// ---------------------------------------------------------------------------
// Editor seams.
// ---------------------------------------------------------------------------
juce::String SigilAudioProcessor::activeEngineId() const {
  using namespace sigil::desc;
  const int i = engineParam_->getIndex();
  if (i < 0 || i >= kEngineCount) return {};
  return juce::String(kEngines[i].id);
}

void SigilAudioProcessor::setActiveEngineId(const juce::String& id) {
  using namespace sigil::desc;
  for (int e = 0; e < kEngineCount; e++) {
    if (id != kEngines[e].id) continue;
    if (engineParam_->getIndex() == e) return;
    engineParam_->beginChangeGesture();
    engineParam_->setValueNotifyingHost(engineParam_->convertTo0to1(static_cast<float>(e)));
    engineParam_->endChangeGesture();
    return;
  }
}

/** Drops the event if the queue is full, which takes 256 unread notes and is
 *  still better than making the interface wait on the audio thread. */
void SigilAudioProcessor::pushUiEvent(const UiEvent& e) {
  const auto scope = uiEvents_.write(1);
  if (scope.blockSize1 > 0) uiEventBuffer_[static_cast<size_t>(scope.startIndex1)] = e;
  else if (scope.blockSize2 > 0) uiEventBuffer_[static_cast<size_t>(scope.startIndex2)] = e;
}

void SigilAudioProcessor::noteFromUi(int note, float velocity, bool on) {
  if (note < 0 || note > 127) return;
  UiEvent e;
  e.note = note;
  e.velocity = juce::jlimit(0.0f, 1.0f, velocity);
  e.on = on;
  pushUiEvent(e);
}

void SigilAudioProcessor::panicFromUi() {
  UiEvent e;
  e.panic = true;
  pushUiEvent(e);
}

void SigilAudioProcessor::drainUiEvents(juce::MidiBuffer& out) {
  const auto scope = uiEvents_.read(uiEvents_.getNumReady());
  auto apply = [this, &out](int start, int count) {
    for (int i = 0; i < count; ++i) {
      const UiEvent& e = uiEventBuffer_[static_cast<size_t>(start + i)];
      if (e.panic) {
        engine_.allNotesOff();
        // A panic is a state, not a note. All-notes-off on channel 1 is the
        // message a host understands without inventing one per sounding voice.
        out.addEvent(juce::MidiMessage::allNotesOff(1), 0);
      } else if (e.on) {
        engine_.noteOn(e.note, e.velocity);
        out.addEvent(juce::MidiMessage::noteOn(1, e.note, e.velocity), 0);
      } else {
        engine_.noteOff(e.note);
        out.addEvent(juce::MidiMessage::noteOff(1, e.note), 0);
      }
    }
  };
  apply(scope.startIndex1, scope.blockSize1);
  apply(scope.startIndex2, scope.blockSize2);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new SigilAudioProcessor(); }
