// Processor-level state tests: the id-keyed patch format of
// src/audio/patch-format.ts, as implemented by SigilAudioProcessor.
//
// The VST3 host check exercises loading and playing; this one exercises the
// rules that file exists to enforce, because they are the ones that fail
// silently and turn a finished track into a different sound:
//
//   * ids, not positions
//   * an id we do not have is IGNORED
//   * an id we expect but do not find falls back to that parameter's DEFAULT
//   * values are CLAMPED to the parameter's range
//   * every recovery is REPORTED, never hidden
//   * a patch written by the web app loads here, and vice versa
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <new>

#include "../plugin/PluginProcessor.h"

// ---------------------------------------------------------------------------
// Allocation counter. Armed only around processBlock, so construction and state
// loading (which legitimately allocate) are not counted.
// ---------------------------------------------------------------------------
namespace {
bool countingAllocations = false;
int allocations = 0;
}  // namespace

void* operator new(std::size_t n) {
  if (countingAllocations) allocations++;
  void* p = std::malloc(n == 0 ? 1 : n);
  if (p == nullptr) std::abort();
  return p;
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void* operator new[](std::size_t n) { return operator new(n); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }

namespace {

int failures = 0;

void check(bool ok, const juce::String& what) {
  if (!ok) {
    std::printf("FAIL  %s\n", what.toRawUTF8());
    failures++;
  }
}

juce::RangedAudioParameter* byId(juce::AudioProcessor& p, const juce::String& id) {
  for (auto* param : p.getParameters()) {
    if (auto* wid = dynamic_cast<juce::AudioProcessorParameterWithID*>(param)) {
      if (wid->paramID == id) return dynamic_cast<juce::RangedAudioParameter*>(param);
    }
  }
  return nullptr;
}

double valueOf(juce::AudioProcessor& p, const juce::String& id) {
  auto* param = byId(p, id);
  if (param == nullptr) {
    std::printf("FAIL  no parameter with id \"%s\"\n", id.toRawUTF8());
    failures++;
    return 0.0;
  }
  return static_cast<double>(param->convertFrom0to1(param->getValue()));
}

void setValue(juce::AudioProcessor& p, const juce::String& id, double v) {
  auto* param = byId(p, id);
  if (param == nullptr) {
    std::printf("FAIL  no parameter with id \"%s\"\n", id.toRawUTF8());
    failures++;
    return;
  }
  param->setValueNotifyingHost(param->convertTo0to1(static_cast<float>(v)));
}

void load(juce::AudioProcessor& p, const juce::String& json) {
  p.setStateInformation(json.toRawUTF8(), static_cast<int>(json.getNumBytesAsUTF8()));
}

}  // namespace

int main() {
  const juce::ScopedJuceInitialiser_GUI juceInit;
  SigilAudioProcessor proc;
  proc.prepareToPlay(48000.0, 512);

  // ---- the state we write is the id-keyed format ------------------------
  setValue(proc, "analog.filter-cutoff", 1234.0);
  setValue(proc, "fx.reverb-mix", 0.42);
  setValue(proc, "magic.tape-wow", 0.25);
  juce::MemoryBlock saved;
  proc.getStateInformation(saved);
  const juce::String json = juce::String::fromUTF8(static_cast<const char*>(saved.getData()),
                                                   static_cast<int>(saved.getSize()));
  check(json.contains("\"version\": 2"), "state carries the patch format version");
  check(json.contains("\"engineId\""), "state carries engineId");
  check(json.contains("\"filter-cutoff\""), "state keys engine values by parameter id");
  check(!json.contains("\"0\":"), "state is not positional");
  std::printf("state: %d bytes, keys engineId/values/fx/magic/engines\n",
              static_cast<int>(saved.getSize()));

  // ---- round trip -------------------------------------------------------
  setValue(proc, "analog.filter-cutoff", 8000.0);
  load(proc, json);
  check(std::abs(valueOf(proc, "analog.filter-cutoff") - 1234.0) < 0.5, "round trip restores cutoff");
  check(std::abs(valueOf(proc, "fx.reverb-mix") - 0.42) < 1.0e-4, "round trip restores fx");
  check(std::abs(valueOf(proc, "magic.tape-wow") - 0.25) < 1.0e-4, "round trip restores magic");

  // ---- a patch written by the WEB app ------------------------------------
  // No "engines" key, only the active engine's values, exactly what
  // serialisePatch() produces in src/audio/patch-format.ts.
  const juce::String webPatch =
      "{\"version\":2,\"engineId\":\"fm\",\"values\":{\"index\":3.5,\"feedback\":0.4},"
      "\"fx\":{\"reverb-mix\":0.31},\"magic\":{\"tape-wow\":0.12},"
      "\"name\":\"from the web\",\"lineage\":\"hunt\",\"savedAt\":\"2026-01-01T00:00:00.000Z\"}";
  load(proc, webPatch);
  check(valueOf(proc, "fx.reverb-mix") > 0.30 && valueOf(proc, "fx.reverb-mix") < 0.32,
        "web patch applies fx by id");
  check(std::abs(valueOf(proc, "magic.tape-wow") - 0.12) < 1.0e-4,
        "web patch applies magic by id");
  {
    juce::MemoryBlock after;
    proc.getStateInformation(after);
    const juce::String s = juce::String::fromUTF8(static_cast<const char*>(after.getData()),
                                                  static_cast<int>(after.getSize()));
    check(s.contains("\"engineId\": \"fm\""), "web patch selected the FM engine");
  }
  // Missing ids fall back to defaults, and that is REPORTED.
  {
    const auto w = proc.lastLoadWarnings();
    bool sawMissing = false;
    for (const auto& s : w) sawMissing = sawMissing || s.contains("using defaults");
    check(sawMissing, "missing ids are reported, not silently defaulted");
    std::printf("web patch warnings: %d\n", w.size());
  }

  // ---- unknown ids are ignored, out-of-range values are clamped ----------
  const juce::String weird =
      "{\"version\":9,\"engineId\":\"analog\","
      "\"values\":{\"filter-cutoff\":999999,\"filter-resonance\":-5,\"not-a-real-param\":1},"
      "\"fx\":{\"reverb-mix\":2.5}}";
  load(proc, weird);
  {
    auto* cutoff = byId(proc, "analog.filter-cutoff");
    auto* res = byId(proc, "analog.filter-resonance");
    // Exact equality with the published bounds: "inside the range" would also
    // pass if the value had silently fallen back to a default.
    check(cutoff != nullptr &&
              std::abs(valueOf(proc, "analog.filter-cutoff") -
                       static_cast<double>(cutoff->getNormalisableRange().end)) < 1.0e-3,
          "999999 is clamped to the cutoff maximum");
    check(res != nullptr &&
              std::abs(valueOf(proc, "analog.filter-resonance") -
                       static_cast<double>(res->getNormalisableRange().start)) < 1.0e-6,
          "-5 is clamped to the resonance minimum");
    check(std::abs(valueOf(proc, "fx.reverb-mix") - 1.0) < 1.0e-6, "fx value clamped to 1");
    const auto w = proc.lastLoadWarnings();
    bool sawClamp = false, sawUnknown = false, sawNewer = false;
    for (const auto& s : w) {
      sawClamp = sawClamp || s.contains("clamped");
      sawUnknown = sawUnknown || s.contains("unknown");
      sawNewer = sawNewer || s.contains("newer build");
    }
    check(sawClamp, "clamping is reported");
    check(sawUnknown, "unknown ids are reported as ignored");
    check(sawNewer, "a newer format version is reported");
    std::printf("tolerant load warnings: %d\n", w.size());
  }

  // ---- the legacy positional format is refused, not guessed --------------
  load(proc, "{\"version\":1,\"engineId\":\"analog\",\"values\":[1,2,3]}");
  {
    const auto w = proc.lastLoadWarnings();
    bool refused = false;
    for (const auto& s : w) refused = refused || s.contains("positional");
    check(refused, "a legacy positional patch is refused with a warning");
  }

  // ---- garbage does not crash or half-load -------------------------------
  load(proc, "not json at all");
  check(proc.lastLoadWarnings().size() > 0, "unparseable state is reported");

  // ---- per-engine values survive a switch --------------------------------
  {
    SigilAudioProcessor p2;
    p2.prepareToPlay(48000.0, 512);
    setValue(p2, "analog.filter-cutoff", 700.0);
    setValue(p2, "wavetable.filter-cutoff", 5500.0);
    juce::MemoryBlock st;
    p2.getStateInformation(st);
    setValue(p2, "analog.filter-cutoff", 100.0);
    setValue(p2, "wavetable.filter-cutoff", 100.0);
    p2.setStateInformation(st.getData(), static_cast<int>(st.getSize()));
    check(std::abs(valueOf(p2, "analog.filter-cutoff") - 700.0) < 1.0,
          "the inactive engines' values are saved too");
    check(std::abs(valueOf(p2, "wavetable.filter-cutoff") - 5500.0) < 5.0,
          "the inactive engines' values are restored too");
  }

  // ---- processBlock allocates nothing ------------------------------------
  {
    SigilAudioProcessor rt;
    rt.setPlayConfigDetails(0, 2, 48000.0, 512);
    rt.prepareToPlay(48000.0, 512);
    juce::AudioBuffer<float> buf(2, 512);
    juce::MidiBuffer midi;
    midi.addEvent(juce::MidiMessage::noteOn(1, 60, 0.8f), 0);
    midi.addEvent(juce::MidiMessage::noteOn(1, 64, 0.8f), 137);
    rt.processBlock(buf, midi);  // warm up: first block may touch lazily-built state

    countingAllocations = true;
    allocations = 0;
    for (int b = 0; b < 400; ++b) {
      juce::MidiBuffer m;
      if (b % 37 == 0) m.addEvent(juce::MidiMessage::noteOn(1, 48 + (b % 24), 0.7f), b % 512);
      if (b % 53 == 0) m.addEvent(juce::MidiMessage::noteOff(1, 48 + (b % 24)), 3);
      buf.clear();
      rt.processBlock(buf, m);
    }
    const int inLoop = allocations;
    countingAllocations = false;
    std::printf("processBlock allocations over 400 blocks: %d\n", inLoop);
    // Measured zero, including the blocks that carry MIDI, so the bar is zero.
    check(inLoop == 0, "processBlock does not allocate");
    rt.releaseResources();
  }

  proc.releaseResources();
  if (failures == 0) {
    std::printf("state check OK\n");
    return 0;
  }
  std::printf("state check: %d failure(s)\n", failures);
  return 1;
}
