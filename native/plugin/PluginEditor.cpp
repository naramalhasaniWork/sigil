#include "PluginEditor.h"

#include "diag.h"
#include "ui-bundle.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

/** The event ids the page uses. Must match TO_HOST / FROM_HOST in
 *  src/audio/plugin-bridge.ts. */
const juce::Identifier kFromUi{"sigilFromUi"};
const juce::Identifier kToUi{"sigilFromHost"};

/** "analog.cutoff" -> "analog". */
juce::String ownerOf(const juce::String& id) {
  const int dot = id.indexOfChar('.');
  return dot <= 0 ? juce::String() : id.substring(0, dot);
}

/** "analog.cutoff" -> "cutoff". */
juce::String leafOf(const juce::String& id) {
  const int dot = id.indexOfChar('.');
  return dot <= 0 ? id : id.substring(dot + 1);
}

/**
 * Everything the interface needs, served from memory.
 *
 * The page is loaded from getResourceProviderRoot(), so every absolute path the
 * export emits ("/_next/static/...") arrives here. Returning nullopt for an
 * unknown path is a real failed request, which shows up in the WebView console
 * as a missing file - better than a 200 with no bytes, which renders as a blank
 * screen with no explanation.
 */
std::optional<juce::WebBrowserComponent::Resource> provide(const juce::String& url) {
  const auto* asset = sigil::ui::findAsset(url.toRawUTF8());
  if (asset == nullptr) return std::nullopt;

  std::vector<std::byte> bytes(asset->size);
  if (asset->size > 0) std::memcpy(bytes.data(), asset->data, asset->size);
  return juce::WebBrowserComponent::Resource{std::move(bytes), juce::String(asset->mime)};
}

}  // namespace

SigilAudioProcessorEditor::SigilAudioProcessorEditor(SigilAudioProcessor& p)
    : AudioProcessorEditor(&p), proc_(p) {
  const auto& refs = proc_.paramRefs();

  ids_.reserve(refs.size());
  gestures_.resize(refs.size());
  // std::atomic is not copyable, so the vector cannot be resized into shape
  // later; it is built at the size it will keep.
  dirty_ = std::vector<std::atomic<bool>>(refs.size());

  for (size_t i = 0; i < refs.size(); ++i) {
    auto* withId = dynamic_cast<juce::AudioProcessorParameterWithID*>(refs[i].param);
    const juce::String id = withId != nullptr ? withId->paramID : juce::String();
    ids_.push_back(id);
    if (id.isNotEmpty()) byId_[id] = static_cast<int>(i);
    byParamIndex_[refs[i].param->getParameterIndex()] = static_cast<int>(i);
    dirty_[i].store(false);
    refs[i].param->addListener(this);
  }
  if (auto* engine = proc_.engineParam()) engine->addListener(this);

  createWebView();
  scheduleHealthCheck();

  setResizable(true, true);
  setResizeLimits(720, 480, 3000, 2000);
  setSize(1180, 820);
  sigil::diag::write(sigil::diag::tag(&p) + " editor opened, engine " + p.activeEngineId()
                     + " " + p.diagFingerprint());
}

void SigilAudioProcessorEditor::createWebView() {
  web_ = std::make_unique<juce::WebBrowserComponent>(
      juce::WebBrowserComponent::Options{}
          .withNativeIntegrationEnabled()
          .withResourceProvider(provide)
          // Without this the page is thrown away every time the editor is
          // hidden - switching away from the plugin in Live and back would
          // reload the whole interface and lose whatever view you were in.
          .withKeepPageLoadedWhenBrowserIsHidden()
          .withEventListener(kFromUi, [this](juce::var payload) {
            handleMessageFromUi(payload);
          }));

  addAndMakeVisible(*web_);
  web_->setBounds(getLocalBounds());
  web_->goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
}

void SigilAudioProcessorEditor::rebuildWebView() {
  webFailures_ = 0;
  createWebView();
  // The page comes back empty of everything the processor told the old one, so
  // it has to be told again. Without this the view returns and shows defaults
  // over a patch that is still sounding.
  sendSnapshot();
}

void SigilAudioProcessorEditor::scheduleHealthCheck() {
  // Slow on purpose. This is a rescue path, not a render loop, and a plugin
  // sitting open on a track should cost nothing to keep alive.
  constexpr int kIntervalMs = 3000;
  juce::Component::SafePointer<SigilAudioProcessorEditor> safe(this);

  juce::Timer::callAfterDelay(kIntervalMs, [safe]() {
    auto* self = safe.getComponent();
    if (self == nullptr) return;

    // A hidden editor is allowed to have no live page; asking would only
    // provoke a rebuild nobody is looking at.
    if (self->web_ == nullptr || !self->isShowing()) {
      self->scheduleHealthCheck();
      return;
    }

    juce::Component::SafePointer<SigilAudioProcessorEditor> again(self);
    self->web_->evaluateJavascript(
        "1", [again](juce::WebBrowserComponent::EvaluationResult r) {
          auto* ed = again.getComponent();
          if (ed == nullptr) return;
          if (r.getResult() != nullptr) ed->webFailures_ = 0;
          else if (++ed->webFailures_ >= 2) ed->rebuildWebView();
          ed->scheduleHealthCheck();
        });
  });
}

SigilAudioProcessorEditor::~SigilAudioProcessorEditor() {
  stopTimer();
  cancelPendingUpdate();

  const auto& refs = proc_.paramRefs();
  for (size_t i = 0; i < refs.size(); ++i) {
    // A gesture left open would make the host believe the mouse is still down
    // on that parameter for the rest of the session.
    if (gestures_[i].open) refs[i].param->endChangeGesture();
    refs[i].param->removeListener(this);
  }
  if (auto* engine = proc_.engineParam()) engine->removeListener(this);
  sigil::diag::write(sigil::diag::tag(&proc_) + " editor closed");
}

void SigilAudioProcessorEditor::resized() {
  if (web_ != nullptr) web_->setBounds(getLocalBounds());
}

void SigilAudioProcessorEditor::visibilityChanged() {
  if (isVisible() && pageReady_.load()) sendSnapshot();
}

// ---------------------------------------------------------------------------
// host -> UI
// ---------------------------------------------------------------------------
void SigilAudioProcessorEditor::parameterValueChanged(int parameterIndex, float) {
  if (!pageReady_.load()) return;

  // byParamIndex_ is read-only after construction, so this is safe to touch from
  // the audio thread; nothing here allocates or locks.
  const auto found = byParamIndex_.find(parameterIndex);
  if (found == byParamIndex_.end()) {
    // Not one of the refs, so it is the engine selector.
    engineDirty_.store(true);
  } else {
    dirty_[static_cast<size_t>(found->second)].store(true);
  }
  triggerAsyncUpdate();
}

void SigilAudioProcessorEditor::handleAsyncUpdate() {
  if (!pageReady_.load() || web_ == nullptr) return;

  const auto& refs = proc_.paramRefs();
  juce::DynamicObject::Ptr values(new juce::DynamicObject());
  int changed = 0;

  for (size_t i = 0; i < dirty_.size() && i < refs.size(); ++i) {
    if (!dirty_[i].exchange(false)) continue;
    if (ids_[i].isEmpty()) continue;
    values->setProperty(juce::Identifier(ids_[i]), proc_.exactValueOf(refs[i]));
    ++changed;
  }

  const bool engineMoved = engineDirty_.exchange(false);

  /*
   * An engine change is sent as the WHOLE snapshot, not as a delta, and this is
   * load-bearing rather than tidy.
   *
   * The processor holds all six engines' values at once. The page shows one, and
   * it DROPS inbound values for the other five because it has nowhere to put
   * them - so the values it holds for an engine it is not showing are whatever
   * they were when it last had the truth, which after a state load is the
   * factory defaults. The moment the selector moves, the page is suddenly
   * showing an engine it never received values for, and it writes what it is
   * holding back at us: measured, six restored parameters all snapped to their
   * descriptor defaults the instant the engine changed. See the `engine` mode in
   * tools/editor_check.cpp, which fails without this.
   *
   * A delta cannot fix that, because the values the page needs are exactly the
   * ones it was never sent. The snapshot is every engine, so there is nothing
   * stale left to push, and the page's snapshot handler pushes NOTHING back.
   *
   * The dirty flags are drained above rather than skipped, so nothing is left
   * marked for a delta that is no longer coming.
   */
  if (engineMoved) {
    sendSnapshot();
    return;
  }

  if (changed == 0) return;

  auto* message = new juce::DynamicObject();
  message->setProperty("t", "params");
  message->setProperty("v", juce::var(values.get()));
  web_->emitEventIfBrowserIsVisible(kToUi, juce::var(message));
}

juce::var SigilAudioProcessorEditor::snapshotVar() const {
  const auto& refs = proc_.paramRefs();

  auto* engines = new juce::DynamicObject();
  auto* fx = new juce::DynamicObject();
  auto* magic = new juce::DynamicObject();

  for (size_t i = 0; i < refs.size(); ++i) {
    if (ids_[i].isEmpty()) continue;
    const juce::String owner = ownerOf(ids_[i]);
    const juce::Identifier leaf(leafOf(ids_[i]));
    const double value = proc_.exactValueOf(refs[i]);

    if (owner == "fx") {
      fx->setProperty(leaf, value);
    } else if (owner == "magic") {
      magic->setProperty(leaf, value);
    } else {
      const juce::Identifier ownerKey(owner);
      juce::var bucket = engines->getProperty(ownerKey);
      if (!bucket.isObject()) {
        bucket = juce::var(new juce::DynamicObject());
        engines->setProperty(ownerKey, bucket);
      }
      bucket.getDynamicObject()->setProperty(leaf, value);
    }
  }

  auto* root = new juce::DynamicObject();
  root->setProperty("t", "snapshot");
  root->setProperty("engineId", proc_.activeEngineId());
  // Which SIGIL this is. Sent with every snapshot rather than once, because a
  // rebuilt WebView (see scheduleHealthCheck) gets a page that knows nothing.
  root->setProperty("name", proc_.instanceName());
  root->setProperty("mark", proc_.instanceMark());
  root->setProperty("engines", juce::var(engines));
  root->setProperty("fx", juce::var(fx));
  root->setProperty("magic", juce::var(magic));
  return juce::var(root);
}

void SigilAudioProcessorEditor::sendSnapshot() {
  if (web_ == nullptr) return;
  web_->emitEventIfBrowserIsVisible(kToUi, snapshotVar());
}

// ---------------------------------------------------------------------------
// UI -> host
// ---------------------------------------------------------------------------
void SigilAudioProcessorEditor::beginOrRefreshGesture(int refIndex) {
  auto& g = gestures_[static_cast<size_t>(refIndex)];
  if (!g.open) {
    proc_.paramRefs()[static_cast<size_t>(refIndex)].param->beginChangeGesture();
    g.open = true;
  }
  g.lastWriteMs = juce::Time::getMillisecondCounter();
  if (!isTimerRunning()) startTimer(60);
}

void SigilAudioProcessorEditor::timerCallback() {
  const juce::uint32 now = juce::Time::getMillisecondCounter();
  bool anyOpen = false;

  for (size_t i = 0; i < gestures_.size(); ++i) {
    auto& g = gestures_[i];
    if (!g.open) continue;
    if (now - g.lastWriteMs >= kGestureIdleMs) {
      proc_.paramRefs()[i].param->endChangeGesture();
      g.open = false;
    } else {
      anyOpen = true;
    }
  }

  // Nothing is being dragged, so nothing needs a clock. An idle plugin with the
  // editor open runs no timer at all.
  if (!anyOpen) stopTimer();
}

void SigilAudioProcessorEditor::handleMessageFromUi(const juce::var& payload) {
  if (!payload.isObject()) return;
  const juce::String type = payload["t"].toString();

  if (type == "ready") {
    pageReady_.store(true);
    sigil::diag::write(sigil::diag::tag(&proc_) + " page ready, sending snapshot: "
                       + proc_.activeEngineId() + " " + proc_.diagFingerprint());
    sendSnapshot();
    if (std::getenv("SIGIL_BRIDGE_SELFTEST") != nullptr) runSelfTest();
    return;
  }

  if (type == "param") {
    const juce::String id = payload["id"].toString();
    const auto found = byId_.find(id);
    if (found == byId_.end()) return;
    const int refIndex = found->second;
    auto* param = proc_.paramRefs()[static_cast<size_t>(refIndex)].param;
    sigil::diag::write(sigil::diag::tag(&proc_) + " page wrote " + id + "="
                       + juce::String(static_cast<double>(payload["v"]), 4));
    beginOrRefreshGesture(refIndex);
    param->setValueNotifyingHost(
        param->convertTo0to1(static_cast<float>(static_cast<double>(payload["v"]))));
    return;
  }

  if (type == "params") {
    const juce::var values = payload["v"];
    if (!values.isObject()) return;
    auto* obj = values.getDynamicObject();
    if (obj == nullptr) return;
    sigil::diag::write(sigil::diag::tag(&proc_) + " page wrote "
                       + juce::String(obj->getProperties().size())
                       + " parameters AT ONCE (this is the shape of an overwrite)");
    for (const auto& prop : obj->getProperties()) {
      const auto found = byId_.find(prop.name.toString());
      if (found == byId_.end()) continue;
      const int refIndex = found->second;
      auto* param = proc_.paramRefs()[static_cast<size_t>(refIndex)].param;
      beginOrRefreshGesture(refIndex);
      param->setValueNotifyingHost(
          param->convertTo0to1(static_cast<float>(static_cast<double>(prop.value))));
    }
    return;
  }

  if (type == "engine") {
    proc_.setActiveEngineId(payload["id"].toString());
    /*
     * The page asked for this, so it does not need telling. Clearing the flag
     * the parameter listener just set stops handleAsyncUpdate from sending the
     * whole snapshot back — which would be correct but not free: hydrating
     * re-centres the macro dials, and a page-driven engine change can be an
     * undo that has just restored them deliberately.
     *
     * Safe to clear here because setActiveEngineId() runs the listener
     * synchronously on this thread, while handleAsyncUpdate is a posted message
     * that cannot have run yet.
     */
    engineDirty_.store(false);
    return;
  }

  if (type == "note") {
    const bool on = static_cast<bool>(payload["on"]);
    proc_.noteFromUi(static_cast<int>(payload["note"]),
                     static_cast<float>(static_cast<double>(payload["vel"])), on);
    return;
  }

  if (type == "panic") {
    proc_.panicFromUi();
    return;
  }

  if (type == "name") {
    // No snapshot back: the page already shows what it just typed, and hydrating
    // it would re-centre the macro dials under the player's hands.
    proc_.setInstanceName(payload["v"].toString());
    sigil::diag::write(sigil::diag::tag(&proc_) + " named \"" + proc_.instanceName() + "\"");
    return;
  }
}

// ---------------------------------------------------------------------------
// Self-test. See the declaration for why this is worth carrying.
// ---------------------------------------------------------------------------
void SigilAudioProcessorEditor::runSelfTest() {
  auto report = [](const char* label) {
    return [label](juce::WebBrowserComponent::EvaluationResult r) {
      if (const auto* v = r.getResult()) {
        std::fprintf(stderr, "[sigil-selftest] %s: %s\n", label, v->toString().toRawUTF8());
      } else {
        std::fprintf(stderr, "[sigil-selftest] %s FAILED: %s\n", label,
                     r.getError()->message.toRawUTF8());
      }
      std::fflush(stderr);
    };
  };

  std::fprintf(stderr, "[sigil-selftest] page said ready; %d parameters on the wire\n",
               static_cast<int>(ids_.size()));

  web_->evaluateJavascript(
      "JSON.stringify({"
      "title: document.title,"
      "nodes: document.querySelectorAll('*').length,"
      "buttons: document.querySelectorAll('button').length,"
      "juce: typeof window.__JUCE__,"
      "text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 220)"
      "})",
      report("dom"));

  // Drive a real parameter the way the page drives one, then read back what the
  // DSP is actually being fed. Anything other than the value we asked for means
  // the wire is lying somewhere between the two.
  if (ids_.empty()) return;
  const juce::String id = ids_.front();
  const auto found = byId_.find(id);
  if (found == byId_.end()) return;
  const auto& ref = proc_.paramRefs()[static_cast<size_t>(found->second)];
  const auto range = ref.param->getNormalisableRange();
  const double target = range.start + (range.end - range.start) * 0.25;

  web_->evaluateJavascript(
      "window.__JUCE__.backend.emitEvent('sigilFromUi', {t:'param', id:'" + id + "', v:"
          + juce::String(target, 6) + "}); 'sent'",
      [this, id, target, found](juce::WebBrowserComponent::EvaluationResult r) {
        if (r.getResult() == nullptr) {
          std::fprintf(stderr, "[sigil-selftest] param send FAILED\n");
          std::fflush(stderr);
          return;
        }
        const auto& r2 = proc_.paramRefs()[static_cast<size_t>(found->second)];
        std::fprintf(stderr, "[sigil-selftest] %s asked %.6f, parameter now %.6f\n",
                     id.toRawUTF8(), target, proc_.exactValueOf(r2));
        std::fflush(stderr);
      });

  // And a note, which is the other direction the interface talks in.
  web_->evaluateJavascript(
      "window.__JUCE__.backend.emitEvent('sigilFromUi', {t:'note', on:true, note:60, vel:0.8});"
      "'note'",
      report("note"));

  /*
   * The direction that is easy to believe you have and not have: the HOST
   * moving the interface.
   *
   * Two probes, and the ORDER matters. A float first, while its engine is still
   * the one on screen - the page deliberately ignores a parameter belonging to
   * an engine it is not showing, because it has nowhere to put it. Then the
   * engine selector, which should make the page redraw around a different
   * engine entirely.
   *
   * The float is checked indirectly: the page writes its session to
   * localStorage whenever a value changes, so finding the number there proves it
   * reached React state rather than merely arriving at the WebView.
   */
  const double automated = range.start + (range.end - range.start) * 0.8;

  auto* engine = proc_.engineParam();
  const int wanted = engine == nullptr || engine->choices.size() < 2
                         ? -1
                         : (engine->getIndex() == 0 ? 1 : 0);
  const juce::String wantedName = wanted < 0 ? juce::String("(unchanged)") : engine->choices[wanted];

  juce::Component::SafePointer<SigilAudioProcessorEditor> safe{this};

  // Long enough for the parameter listener, the async update, a WebKit IPC hop,
  // a React render and the session write to have all happened.
  const int refIndex = found->second;
  juce::Timer::callAfterDelay(900, [safe, id, automated, report, engine, wanted, wantedName,
                                    refIndex]() {
    if (safe == nullptr || safe->web_ == nullptr) return;

    // Only now, once the page's own write above has definitely landed - the
    // evaluateJavascript calls are asynchronous, so doing this any earlier is a
    // race between two writes to the same parameter.
    auto* p = safe->proc_.paramRefs()[static_cast<size_t>(refIndex)].param;
    p->beginChangeGesture();
    p->setValueNotifyingHost(p->convertTo0to1(static_cast<float>(automated)));
    p->endChangeGesture();
    std::fprintf(stderr, "[sigil-selftest] host set %s to %.6f\n", id.toRawUTF8(), automated);

    juce::Timer::callAfterDelay(900, [safe, id, report, engine, wanted, wantedName]() {
      if (safe == nullptr || safe->web_ == nullptr) return;
      safe->web_->evaluateJavascript(
          "String(((JSON.parse(localStorage.getItem('sigil.session.v2') || '{}').engines || {})['"
              + ownerOf(id) + "'] || {})['" + leafOf(id) + "'])",
          report("value-in-page"));

      if (wanted < 0) return;
      engine->beginChangeGesture();
      engine->setValueNotifyingHost(engine->convertTo0to1(static_cast<float>(wanted)));
      engine->endChangeGesture();

      juce::Timer::callAfterDelay(900, [safe, wantedName, report]() {
        if (safe == nullptr || safe->web_ == nullptr) return;
        std::fprintf(stderr, "[sigil-selftest] host moved engine to %s\n", wantedName.toRawUTF8());
        safe->web_->evaluateJavascript(
            "(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 110)",
            report("after-automation"));
      });
    });
  });
}
