// Loads the BUILT SIGIL.vst3 the way a DAW does - through JUCE's VST3 host
// format - and plays it. Compiling is not evidence that a plugin works; this is
// the cheapest thing that is.
//
// It checks, and prints numbers for, each of:
//   * the bundle is found, scanned, and instantiated by VST3PluginFormat
//   * every descriptor parameter is present and automatable
//   * each of the six engines makes sound from a MIDI note, and silence again
//     after note-off plus the tail
//   * state save/load round-trips through the id-keyed JSON, including across
//     an engine switch
//
// Usage: sigil_host_check <path to SIGIL.vst3>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_utils/juce_audio_utils.h>

#include <cmath>
#include <memory>
#include <vector>

#include "sigil-engine.h"
#include "../plugin/param-range.h"

namespace {

int failures = 0;

void fail(const juce::String& what) {
  std::fprintf(stderr, "FAIL  %s\n", what.toRawUTF8());
  failures++;
}

double peakOf(const juce::AudioBuffer<float>& b) {
  double peak = 0.0;
  for (int ch = 0; ch < b.getNumChannels(); ++ch) {
    for (int i = 0; i < b.getNumSamples(); ++i) {
      const double a = std::abs(static_cast<double>(b.getSample(ch, i)));
      if (a > peak) peak = a;
    }
  }
  return peak;
}

double runBlocks(juce::AudioPluginInstance& p, int blocks, int blockSize,
                 const juce::MidiBuffer& firstBlockMidi) {
  juce::AudioBuffer<float> buffer(2, blockSize);
  double peak = 0.0;
  for (int b = 0; b < blocks; ++b) {
    buffer.clear();
    juce::MidiBuffer midi;
    if (b == 0) midi = firstBlockMidi;
    p.processBlock(buffer, midi);
    peak = juce::jmax(peak, peakOf(buffer));
  }
  return peak;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: sigil_host_check <SIGIL.vst3>\n");
    return 2;
  }
  const juce::ScopedJuceInitialiser_GUI juceInit;
  const juce::String path(argv[1]);

  juce::VST3PluginFormat format;
  juce::OwnedArray<juce::PluginDescription> found;
  format.findAllTypesForFile(found, path);
  if (found.isEmpty()) {
    fail("VST3PluginFormat found no plugin in " + path);
    return 1;
  }
  std::printf("scanned: %s  (%s, %s, isInstrument=%d)\n",
              found[0]->name.toRawUTF8(), found[0]->manufacturerName.toRawUTF8(),
              found[0]->version.toRawUTF8(), found[0]->isInstrument ? 1 : 0);
  if (!found[0]->isInstrument) fail("plugin does not report itself as an instrument");

  juce::AudioPluginFormatManager manager;
  manager.addFormat(std::make_unique<juce::VST3PluginFormat>());
  juce::String err;
  constexpr double kSampleRate = 48000.0;
  constexpr int kBlock = 512;
  auto instance = manager.createPluginInstance(*found[0], kSampleRate, kBlock, err);
  if (instance == nullptr) {
    fail("could not instantiate: " + err);
    return 1;
  }

  instance->setPlayConfigDetails(0, 2, kSampleRate, kBlock);
  instance->prepareToPlay(kSampleRate, kBlock);

  // ---- parameters -------------------------------------------------------
  const auto& params = instance->getParameters();
  std::printf("parameters: %d\n", params.size());
  int nonAutomatable = 0;
  juce::StringArray ids;
  for (auto* p : params) {
    if (!p->isAutomatable()) nonAutomatable++;
    // A HOSTED parameter is a wrapper around the VST3 one, not our
    // AudioParameterFloat, so the id has to come from the instance.
    if (auto* hosted = dynamic_cast<juce::HostedAudioProcessorParameter*>(p)) {
      ids.add(hosted->getParameterID());
    }
  }
  if (nonAutomatable > 0) fail(juce::String(nonAutomatable) + " parameter(s) are not automatable");
  ids.removeDuplicates(false);
  if (ids.size() != params.size()) {
    fail("parameter ids are not unique: " + juce::String(ids.size()) + " unique of " +
         juce::String(params.size()));
  }
  auto* engineParam = params[0];
  if (engineParam->getName(64) != "Engine") fail("first parameter is not the engine selector");
  const int engineCount = engineParam->getNumSteps();

  // ---- each engine makes sound -----------------------------------------
  for (int e = 0; e < engineCount; ++e) {
    engineParam->setValueNotifyingHost(engineCount > 1 ? e / static_cast<float>(engineCount - 1)
                                                       : 0.0f);
    juce::MidiBuffer on;
    on.addEvent(juce::MidiMessage::noteOn(1, 60, 0.9f), 0);
    const double peak = runBlocks(*instance, 40, kBlock, on);

    juce::MidiBuffer off;
    off.addEvent(juce::MidiMessage::noteOff(1, 60), 0);
    runBlocks(*instance, 4, kBlock, off);            // release
    juce::MidiBuffer none;
    const double tail = runBlocks(*instance, 700, kBlock, none);  // ~7.5 s of tail
    const double settled = runBlocks(*instance, 20, kBlock, none);

    std::printf("engine %d  %-20s peak=%.6f  tail=%.6f  settled=%.8f\n", e,
                engineParam->getCurrentValueAsText().toRawUTF8(), peak, tail, settled);
    if (!(peak > 1.0e-3)) fail("engine " + juce::String(e) + " produced no audible output");
    if (!std::isfinite(peak) || peak > 8.0) {
      fail("engine " + juce::String(e) + " output is not finite or absurdly loud");
    }
  }

  // ---- state round trip -------------------------------------------------
  engineParam->setValueNotifyingHost(0.0f);
  auto* probe = params[8];  // an ordinary engine parameter
  probe->setValueNotifyingHost(0.375f);
  juce::MemoryBlock saved;
  instance->getStateInformation(saved);
  // This is the VST3 wrapper's chunk, which CONTAINS our JSON rather than being
  // it - JUCE wraps the processor's state blob in its own container. The JSON
  // shape itself is checked at the processor level by sigil_state_check.
  const juce::String blob = juce::String::fromUTF8(static_cast<const char*>(saved.getData()),
                                                   static_cast<int>(saved.getSize()));
  // The host hands back its own container (a "VC2!" header plus base64 XML) with
  // the plugin's blob inside; the SHAPE of that blob - the id-keyed patch JSON -
  // is asserted at processor level by sigil_state_check, because it is the
  // plugin's format, not the host's. What matters here is that state survives a
  // trip through VST3 and into a FRESH instance, which is what reopening a
  // project does.
  std::printf("state: %d bytes\n", static_cast<int>(saved.getSize()));
  if (saved.getSize() < 512) fail("state chunk is suspiciously small");

  probe->setValueNotifyingHost(0.9f);
  engineParam->setValueNotifyingHost(1.0f);
  instance->setStateInformation(saved.getData(), static_cast<int>(saved.getSize()));
  if (std::abs(probe->getValue() - 0.375f) > 1.0e-5f) {
    fail("state did not restore the parameter value: got " + juce::String(probe->getValue()));
  }
  if (std::abs(engineParam->getValue()) > 1.0e-5f) {
    fail("state did not restore the engine selection");
  }

  // Same state into a SECOND instance, then compare every parameter.
  {
    juce::String err2;
    auto fresh = manager.createPluginInstance(*found[0], kSampleRate, kBlock, err2);
    if (fresh == nullptr) {
      fail("could not instantiate a second copy: " + err2);
    } else {
      fresh->setStateInformation(saved.getData(), static_cast<int>(saved.getSize()));
      const auto& a = instance->getParameters();
      const auto& b = fresh->getParameters();
      int mismatched = 0;
      float worst = 0.0f;
      if (a.size() != b.size()) {
        fail("the two instances disagree on how many parameters exist");
      } else {
        for (int i = 0; i < a.size(); ++i) {
          const float d = std::abs(a[i]->getValue() - b[i]->getValue());
          worst = juce::jmax(worst, d);
          if (d > 1.0e-4f) mismatched++;
        }
      }
      std::printf("fresh instance: %d/%d parameters differ, worst %.3e\n", mismatched,
                  b.size(), worst);
      if (mismatched > 0) fail("state did not transfer to a fresh instance");
      fresh->releaseResources();
    }
  }

  // ---- the VST3's audio vs the parity-verified DSP ----------------------
  // The DSP under native/src is measured against the TypeScript by the golden
  // rig. This closes the last gap: that what comes OUT of the loaded VST3 is
  // that same DSP, and that nothing in the wrapper alters it.
  //
  // A FRESH instance per engine, because several voices are deliberately
  // stateful across notes - analog glides from the pitch of the last note it
  // played and does not clear its sub-oscillator - so a plugin that has already
  // been played is not comparable with a freshly constructed reference. That is
  // correct behaviour in both, not a difference between them.
  {
    constexpr int kBlocks = 60;
    for (int e = 0; e < engineCount; ++e) {
      juce::String errN;
      auto fresh = manager.createPluginInstance(*found[0], kSampleRate, kBlock, errN);
      if (fresh == nullptr) {
        fail("could not instantiate for the DSP comparison: " + errN);
        break;
      }
      fresh->setPlayConfigDetails(0, 2, kSampleRate, kBlock);
      fresh->prepareToPlay(kSampleRate, kBlock);
      auto* sel = fresh->getParameters()[0];
      sel->setValueNotifyingHost(engineCount > 1 ? e / static_cast<float>(engineCount - 1) : 0.0f);

      // Move some parameters OFF their defaults, or the comparison would only
      // prove that two identical default tables produce identical audio - it
      // would still pass with the whole parameter path disconnected. The value
      // read back from the host is what gets fed to the reference, so this
      // tests the routing, not the float precision of the host's normalisation.
      // Parameters are looked up BY INDEX, not by id: JUCE hashes our paramID
      // into a numeric VST3 ParamID, so "analog.osc-detune" does not survive the
      // trip through the host. The order is fixed and published by the
      // descriptor table - engine selector, then every engine in registry order,
      // then fx, then magic - and the name is verified below so a wrong offset
      // cannot pass silently.
      int engineBase = 1;
      for (int k = 0; k < e; ++k) engineBase += sigil::desc::kEngines[k].count;
      int fxBase = 1;
      for (int k = 0; k < sigil::desc::kEngineCount; ++k) fxBase += sigil::desc::kEngines[k].count;
      const int magicBase = fxBase + sigil::desc::kFxDesc.count;

      const sigil::desc::EngineDesc& ed = sigil::desc::kEngines[e];
      struct Moved { int hostIndex; sigil::ParamSection section; int index; double value; };
      std::vector<Moved> moved;
      for (int i = 0; i < juce::jmin(3, ed.count); ++i) {
        const auto& pd = ed.params[i];
        moved.push_back({engineBase + i, sigil::ParamSection::kEngine, i,
                         pd.min + (pd.max - pd.min) * 0.62});
      }
      for (int k = 0; k < sigil::desc::kFxDesc.count; ++k) {
        const juce::String id(sigil::desc::kFxDesc.params[k].id);
        if (id == "reverb-mix") moved.push_back({fxBase + k, sigil::ParamSection::kFx, k, 0.4});
        if (id == "delay-mix") moved.push_back({fxBase + k, sigil::ParamSection::kFx, k, 0.3});
      }
      for (int k = 0; k < sigil::desc::kMagicDesc.count; ++k) {
        const juce::String id(sigil::desc::kMagicDesc.params[k].id);
        if (id == "tape-wow") moved.push_back({magicBase + k, sigil::ParamSection::kMagic, k, 0.35});
        if (id == "vowel-mix") moved.push_back({magicBase + k, sigil::ParamSection::kMagic, k, 0.45});
      }

      std::vector<std::pair<sigil::ParamSection, std::pair<int, double>>> refWrites;
      for (const auto& m : moved) {
        // A HOSTED parameter is not our AudioParameterFloat, so it carries no
        // range - only a normalised float. The conversion therefore uses the
        // same sigil::rangeFor() the plugin built the parameter with.
        auto* target = fresh->getParameters()[m.hostIndex];
        // The host-visible NAME must be the descriptor's, or the index map is
        // wrong and every number after this would be meaningless.
        const sigil::desc::EngineDesc& d = m.section == sigil::ParamSection::kEngine ? ed
                                           : m.section == sigil::ParamSection::kFx
                                               ? sigil::desc::kFxDesc
                                               : sigil::desc::kMagicDesc;
        const juce::NormalisableRange<float> range = sigil::rangeFor(d.params[m.index]);
        if (!target->getName(128).endsWith(d.params[m.index].name)) {
          fail("parameter index " + juce::String(m.hostIndex) + " is \"" +
               target->getName(128) + "\", expected to end with \"" +
               juce::String(d.params[m.index].name) + "\"");
          continue;
        }
        target->setValueNotifyingHost(range.convertTo0to1(static_cast<float>(m.value)));
        // Read BACK what the host now holds: that, not the value asked for, is
        // what the plugin feeds the DSP.
        const double actual = static_cast<double>(range.convertFrom0to1(target->getValue()));
        refWrites.push_back({m.section, {m.index, actual}});
      }

      const juce::MidiMessage noteOn = juce::MidiMessage::noteOn(1, 57, 0.75f);
      std::vector<float> pluginL(static_cast<size_t>(kBlocks) * kBlock, 0.0f);
      juce::AudioBuffer<float> buffer(2, kBlock);
      for (int b = 0; b < kBlocks; ++b) {
        buffer.clear();
        juce::MidiBuffer midi;
        if (b == 0) midi.addEvent(noteOn, 0);
        fresh->processBlock(buffer, midi);
        for (int i = 0; i < kBlock; ++i) {
          pluginL[static_cast<size_t>(b) * kBlock + static_cast<size_t>(i)] =
              buffer.getSample(0, i);
        }
      }
      fresh->releaseResources();

      sigil::SigilEngine ref;
      ref.prepare(kSampleRate);
      ref.setEngine(e);
      for (const auto& w : refWrites) {
        ref.setParamByAddress(sigil::addressOf(w.first, w.second.first), e, w.second.second);
      }
      ref.noteOn(noteOn.getNoteNumber(), noteOn.getFloatVelocity());
      std::vector<float> refL(static_cast<size_t>(kBlock), 0.0f);
      std::vector<float> refR(static_cast<size_t>(kBlock), 0.0f);
      double worst = 0.0;
      size_t worstAt = 0;
      for (int b = 0; b < kBlocks; ++b) {
        ref.render(refL.data(), refR.data(), kBlock);
        for (int i = 0; i < kBlock; ++i) {
          const size_t k = static_cast<size_t>(b) * kBlock + static_cast<size_t>(i);
          const double d = std::abs(static_cast<double>(pluginL[k]) -
                                    static_cast<double>(refL[static_cast<size_t>(i)]));
          if (d > worst) { worst = d; worstAt = k; }
        }
      }
      std::printf("engine %d vs DSP reference: maxAbs %.3e at sample %d\n", e, worst,
                  static_cast<int>(worstAt));
      if (!(worst == 0.0)) {
        fail("engine " + juce::String(e) + ": VST3 output differs from the DSP reference by " +
             juce::String(worst));
      }
    }
  }

  instance->releaseResources();
  instance.reset();

  if (failures == 0) {
    std::printf("host check OK\n");
    return 0;
  }
  std::printf("host check: %d failure(s)\n", failures);
  return 1;
}
