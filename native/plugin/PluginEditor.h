// The SIGIL interface inside the plugin.
//
// The editor is a juce::WebBrowserComponent showing the static export of the
// real Next app, compiled into the binary (see ui-bundle.h). It is not a
// screenshot of the web app and not a second implementation of it: it is the
// same TypeScript, with src/audio/plugin-bridge.ts swapped in for the worklet.
//
// Which makes this class exactly one thing: the wire between an
// AudioProcessorParameter and that page.
//   UI  -> host   a knob turns, the matching VST3 parameter moves, so the DAW
//                 records it and any automation lane it is on stays truthful.
//   host -> UI    the parameter's Listener fires, and the change is posted to
//                 the page. NOT polled: an idle plugin with an open editor does
//                 no work at all, because nothing calls anything.
//
// Parameters are matched by ID on both sides - "analog.cutoff", "fx.drive-tone".
// Never by position. src/audio/patch-format.ts explains at length why, and the
// same reasoning holds harder here: a positional wire would silently repoint
// every automation lane in a saved project the first time a parameter is
// inserted into a descriptor.
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_extra/juce_gui_extra.h>

#include <atomic>
#include <memory>
#include <unordered_map>
#include <vector>

#include "PluginProcessor.h"

class SigilAudioProcessorEditor final : public juce::AudioProcessorEditor,
                                        private juce::AudioProcessorParameter::Listener,
                                        private juce::AsyncUpdater,
                                        private juce::Timer {
public:
  explicit SigilAudioProcessorEditor(SigilAudioProcessor&);
  ~SigilAudioProcessorEditor() override;

  void resized() override;
  /** A host that hides rather than destroys the editor leaves the page holding
   *  whatever it last heard; resyncing on the way back in is cheaper than
   *  keeping a queue of everything it missed. */
  void visibilityChanged() override;

private:
  // -- AudioProcessorParameter::Listener ------------------------------------
  /** Called from whichever thread moved the parameter, including the audio
   *  thread. Does no work beyond setting a flag and waking the message thread. */
  void parameterValueChanged(int parameterIndex, float newValue) override;
  void parameterGestureChanged(int, bool) override {}

  // -- AsyncUpdater ---------------------------------------------------------
  /** Message thread. Drains the flags into one message to the page. */
  void handleAsyncUpdate() override;

  // -- Timer ----------------------------------------------------------------
  /** Runs only while a UI-driven gesture is open. See beginOrRefreshGesture. */
  void timerCallback() override;

  // -- the page -------------------------------------------------------------
  void handleMessageFromUi(const juce::var& payload);
  void sendSnapshot();
  juce::var snapshotVar() const;

  /**
   * Automation records a DRAG, not a series of unrelated writes, and a host
   * only knows a drag happened if it is bracketed by begin/endChangeGesture.
   * The page cannot send those honestly - a knob's pointer capture lives in
   * React and the bridge only sees values - so the gesture is inferred: it opens
   * on the first write to a parameter and closes once that parameter has been
   * still for kGestureIdleMs. A long, slow drag with a pause in it therefore
   * records as two gestures, which is harmless; the alternative, no gestures at
   * all, makes touch-sensitive automation modes ignore the plugin entirely.
   */
  void beginOrRefreshGesture(int refIndex);

  /**
   * A one-shot proof, off unless SIGIL_BRIDGE_SELFTEST is set in the
   * environment, that the interface really is running inside the plugin and the
   * wire really is connected. It reports what the page rendered, then drives one
   * parameter through the same event the page's own bridge uses and reports the
   * value the DSP ends up being fed.
   *
   * It exists because a WebView in a plugin fails silently: a blank editor and a
   * working editor are the same process, the same memory, the same logs. Run the
   * standalone build from a terminal with the variable set and the answer is in
   * stderr.
   */
  void runSelfTest();

  SigilAudioProcessor& proc_;

  /** Parameter id -> index into proc_.paramRefs(). Built once. */
  std::unordered_map<juce::String, int> byId_;
  /** Processor-wide parameter index -> index into proc_.paramRefs(). The two
   *  orders happen to line up today; relying on that would be a positional
   *  assumption of exactly the kind this bridge exists to avoid. */
  std::unordered_map<int, int> byParamIndex_;
  /** Cached ids, so the message thread never re-reads them from parameters. */
  std::vector<juce::String> ids_;

  /**
   * One flag per parameter, plus one for the engine selector.
   *
   * Deliberately a flag rather than a queue of values: the audio thread must not
   * allocate, and coalescing is the correct behaviour anyway - if automation
   * moves a parameter fifty times between two paints, the page only ever needed
   * the last value.
   */
  std::vector<std::atomic<bool>> dirty_;
  std::atomic<bool> engineDirty_{false};
  std::atomic<bool> pageReady_{false};

  struct OpenGesture {
    bool open = false;
    juce::uint32 lastWriteMs = 0;
  };
  std::vector<OpenGesture> gestures_;

  static constexpr juce::uint32 kGestureIdleMs = 300;

  std::unique_ptr<juce::WebBrowserComponent> web_;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(SigilAudioProcessorEditor)
};
