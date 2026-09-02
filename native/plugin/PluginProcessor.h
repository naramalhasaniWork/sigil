// SIGIL VST3 wrapper.
//
// The DSP under native/src is plain C++17 with no JUCE in it, and that stays
// true: JUCE lives only in this directory. Everything here is host plumbing -
// parameters, MIDI, state - around sigil::SigilEngine, which is the port of the
// worklet's audio-thread half.
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <vector>

#include "sigil-engine.h"

/**
 * How the flat parameter address space of src/audio/param-space.ts reaches a
 * host that requires a STATIC parameter list.
 *
 * The web app shows one engine at a time, so its worklet only ever addresses the
 * active engine's parameters: address 0..n is "engine", 1000+ is "fx", 2000+ is
 * "magic". A DAW cannot work that way - the parameter list must not change when
 * the user switches engine, or every automation lane in the project breaks.
 *
 * So the plugin publishes every engine's parameters at once, and each one
 * remembers which engine it belongs to. Routing still goes through exactly one
 * call, SigilEngine::setParamByAddress(address, engineIndex, value), with the
 * address built by the ported addressOf(). fx and magic ignore engineIndex.
 */
struct SigilParamRef {
  juce::RangedAudioParameter* param = nullptr;
  sigil::ParamSection section = sigil::ParamSection::kEngine;
  int engineIndex = -1;  // -1 for fx and magic
  int index = 0;         // index within the section

  /**
   * Why there are two values here rather than one.
   *
   * A host parameter is a normalised FLOAT. Round-tripping a descriptor default
   * through it - convertTo0to1 then convertFrom0to1 - is lossy: measured, a
   * default cutoff of 1800 Hz comes back as 1799.999634, and an amp release of
   * 300 ms as 300.0000916. That is roughly 2e-7 relative, which is nothing on
   * its own but is NOT what the TypeScript reference is fed, and it would also
   * mean a patch drifted slightly every time it was saved and reloaded.
   *
   * So the exact value is kept alongside, and the normalised float is used only
   * to detect that the HOST moved the parameter. Untouched defaults and
   * patch-loaded values therefore reach the DSP bit-exact; a parameter the user
   * or an automation lane actually moves is as precise as the plugin format
   * allows, which is float.
   */
  double exact = 0.0;
  float lastNormalised = 0.0f;
};

class SigilAudioProcessor final : public juce::AudioProcessor {
public:
  SigilAudioProcessor();
  ~SigilAudioProcessor() override = default;

  void prepareToPlay(double sampleRate, int samplesPerBlock) override;
  void releaseResources() override;
  bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
  void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

  juce::AudioProcessorEditor* createEditor() override;
  bool hasEditor() const override { return true; }

  const juce::String getName() const override { return "SIGIL"; }
  bool acceptsMidi() const override { return true; }
  bool producesMidi() const override { return false; }
  bool isMidiEffect() const override { return false; }
  double getTailLengthSeconds() const override { return 6.0; }

  int getNumPrograms() override { return 1; }
  int getCurrentProgram() override { return 0; }
  void setCurrentProgram(int) override {}
  const juce::String getProgramName(int) override { return "Default"; }
  void changeProgramName(int, const juce::String&) override {}

  void getStateInformation(juce::MemoryBlock& destData) override;
  void setStateInformation(const void* data, int sizeInBytes) override;

  /** Warnings from the last setStateInformation, in the spirit of
   *  LoadResult.warnings in src/audio/patch-format.ts: recoveries are reported,
   *  never hidden. */
  juce::StringArray lastLoadWarnings() const;

  /**
   * A handful of values, short enough for one log line, chosen so that "is this
   * the same patch" can be answered by eye: the active engine's first three
   * parameters plus one from each of fx and magic. Only used by the opt-in
   * diagnostic log - see plugin/diag.h for why that exists.
   */
  juce::String diagFingerprint() const;

  // -------------------------------------------------------------------------
  // Seams for the editor. The editor is a WebBrowserComponent hosting the real
  // SIGIL interface, so it needs to read and move parameters by ID and to play
  // notes from an on-screen keyboard. It is deliberately given accessors rather
  // than made a friend: the plugin's state still only ever moves through
  // AudioProcessorParameter, which is what makes the host record it.
  // -------------------------------------------------------------------------

  /** Every published parameter, in the order they were added. */
  const std::vector<SigilParamRef>& paramRefs() const noexcept { return refs_; }

  /** The engine selector, which is a choice rather than a float. */
  juce::AudioParameterChoice* engineParam() const noexcept { return engineParam_; }

  /** The value the DSP is actually being fed - see SigilParamRef. */
  double exactValueOf(const SigilParamRef& r) const;

  // -------------------------------------------------------------------------
  // Instance identity.
  //
  // Several SIGILs in one project are indistinguishable: same window, same
  // wordmark, same colours, and the DAW's own device title is the plugin's
  // name, which VST3 gives no per-instance say over. So the instrument carries
  // its own.
  //
  // Deliberately NOT a parameter. Parameters map to VST3 by index and inserting
  // one repoints automation in every saved project (see buildParameters), a
  // name is not a number, and no one wants an automation lane for it. It lives
  // in the state JSON beside the patch, under keys the web app's loadPatch()
  // ignores, so a patch stays portable.
  // -------------------------------------------------------------------------

  /** What the player called this one. Empty means it is still using the name
   *  its mark was given. */
  juce::String instanceName() const;

  /** Renames, and tells the host the project changed so the name is saved. */
  void setInstanceName(const juce::String& name);

  /**
   * Which identity this instance was dealt: an index the interface turns into a
   * name and an accent colour. Assigned in order of creation so two instances
   * are never dealt the same one, and then persisted, so a reopened project
   * gets its identities back rather than re-dealing them.
   */
  int instanceMark() const noexcept { return instanceMark_; }

  /** Descriptor id of the engine currently selected, e.g. "analog". */
  juce::String activeEngineId() const;

  /** Selects by descriptor id. Ignores an id this build does not have. */
  void setActiveEngineId(const juce::String& id);

  /**
   * A note played on the interface's own keyboard.
   *
   * It is queued rather than played, because the WebView calls from the message
   * thread and the voice allocator is only safe to touch from the audio thread.
   * The queue is a lock-free FIFO drained at the top of the next processBlock,
   * so the note lands at sample 0 of that block. That is coarser than the
   * sample-accurate placement host MIDI gets, and it does not matter: the
   * quantisation is one buffer, well under the jitter already in a mouse click.
   */
  void noteFromUi(int note, float velocity, bool on);
  void panicFromUi();

private:
  void buildParameters();
  void pushChangedParameters();
  void pushAllParameters();
  void renderSegment(juce::AudioBuffer<float>& buffer, int startSample, int numSamples);
  void handleMidi(const juce::MidiMessage& m);

  sigil::SigilEngine engine_;

  /** A note or a panic from the interface. POD on purpose: the audio thread
   *  reads these and must not touch anything that could allocate. */
  struct UiEvent {
    int note = 0;
    float velocity = 0.0f;
    bool on = false;
    bool panic = false;
  };
  static constexpr int kUiEventCapacity = 256;
  juce::AbstractFifo uiEvents_{kUiEventCapacity};
  std::array<UiEvent, kUiEventCapacity> uiEventBuffer_{};

  void pushUiEvent(const UiEvent& e);
  void drainUiEvents(juce::MidiBuffer& out);
  std::vector<SigilParamRef> refs_;
  juce::AudioParameterChoice* engineParam_ = nullptr;
  int lastEngineIndex_ = -1;

  juce::CriticalSection warningLock_;
  juce::StringArray loadWarnings_;

  /** Guards instanceName_ only. The editor reads it from the message thread and
   *  a state load writes it from whichever thread the host chose. */
  mutable juce::CriticalSection nameLock_;
  juce::String instanceName_;
  int instanceMark_ = 0;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(SigilAudioProcessor)
};
