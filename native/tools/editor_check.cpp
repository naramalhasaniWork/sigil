// Two instances, two editors, one process - what a DAW does the moment a second
// SIGIL lands on a second track, and the thing nothing else here tests.
//
// Both editors are WebBrowserComponents loading the SAME origin
// (juce://juce.backend/), so everything a browser keys on origin is shared
// between them: localStorage, sessionStorage, BroadcastChannel. What must NOT
// be shared is which processor an editor is wired to, which sound each one
// holds, or whether one closing takes the other one's page with it.
//
// The order below is Live's order, not a convenient one: the second instance
// arrives LATE, on top of a first that is already loaded and has been touched,
// and editors are then destroyed and rebuilt underneath each other, which is
// what opening and closing a device does all day.
//
// Three modes:
//   (default)                  the checks, in Live's order
//   SIGIL_EDITOR_VST3=<path>   the same two instances loaded through the VST3
//                              host instead, which is the only way to exercise
//                              the wrapper and the host's own window
//   SIGIL_EDITOR_HOLD_MS=<ms>  hold SIGIL_EDITOR_COUNT editors open doing
//                              nothing, and report what each page put in the
//                              shared storage - for looking, not asserting
//
// Needs a window server and opens real windows, so it is run by hand rather
// than from ctest.
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_gui_extra/juce_gui_extra.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <memory>
#include <vector>

#include "../plugin/PluginEditor.h"
#include "../plugin/PluginProcessor.h"

namespace {

int failures = 0;

void check(bool ok, const juce::String& what) {
  std::printf("%s  %s\n", ok ? "ok  " : "FAIL", what.toRawUTF8());
  if (!ok) failures++;
  std::fflush(stdout);
}

void note(const juce::String& what) {
  std::printf("      %s\n", what.toRawUTF8());
  std::fflush(stdout);
}

void pump(int ms) { juce::MessageManager::getInstance()->runDispatchLoopUntil(ms); }

/** The editor adds its WebBrowserComponent as its only child. */
juce::WebBrowserComponent* webOf(juce::AudioProcessorEditor& ed) {
  for (int i = 0; i < ed.getNumChildComponents(); ++i)
    if (auto* w = dynamic_cast<juce::WebBrowserComponent*>(ed.getChildComponent(i))) return w;
  return nullptr;
}

/** evaluateJavascript is asynchronous; the checks read like checks if it is not. */
juce::String eval(juce::WebBrowserComponent& web, const juce::String& js, int timeoutMs = 8000) {
  struct Box {
    bool done = false;
    juce::String value;
  };
  auto box = std::make_shared<Box>();
  web.evaluateJavascript(js, [box](juce::WebBrowserComponent::EvaluationResult r) {
    box->value = r.getResult() != nullptr ? r.getResult()->toString()
                                          : juce::String("<error> ") + r.getError()->message;
    box->done = true;
  });
  const juce::uint32 deadline = juce::Time::getMillisecondCounter() + (juce::uint32)timeoutMs;
  while (!box->done && juce::Time::getMillisecondCounter() < deadline) pump(20);
  return box->done ? box->value : juce::String("<timeout>");
}

int nodeCount(juce::WebBrowserComponent& web) {
  return eval(web, "String(document.querySelectorAll('*').length)").getIntValue();
}

juce::String bodyText(juce::WebBrowserComponent& web) {
  return eval(web, "String(document.body.innerText || '').replace(/\\s+/g,' ').slice(0,110)");
}

juce::String storageKeys(juce::WebBrowserComponent& web) {
  return eval(web, "Object.keys(localStorage).sort().join(',')");
}

/** Waits for the page to have painted something rather than guessing a delay. */
bool waitForPage(juce::WebBrowserComponent& web, int timeoutMs = 15000) {
  const juce::uint32 deadline = juce::Time::getMillisecondCounter() + (juce::uint32)timeoutMs;
  while (juce::Time::getMillisecondCounter() < deadline) {
    if (nodeCount(web) > 50) return true;
    pump(200);
  }
  return false;
}

juce::String firstParamId(SigilAudioProcessor& p) {
  for (const auto& r : p.paramRefs())
    if (auto* wid = dynamic_cast<juce::AudioProcessorParameterWithID*>(r.param))
      if (wid->paramID.isNotEmpty()) return wid->paramID;
  return {};
}

double valueOf(SigilAudioProcessor& p, const juce::String& id) {
  for (const auto& r : p.paramRefs())
    if (auto* wid = dynamic_cast<juce::AudioProcessorParameterWithID*>(r.param))
      if (wid->paramID == id) return p.exactValueOf(r);
  return std::numeric_limits<double>::quiet_NaN();
}

void setFromPage(juce::WebBrowserComponent& web, const juce::String& id, double v) {
  eval(web, "window.__JUCE__.backend.emitEvent('sigilFromUi', {t:'param', id:'" + id +
                "', v:" + juce::String(v, 6) + "}); 'sent'");
}

/** An editor in a window, the way a host puts one there. */
struct Opened {
  std::unique_ptr<juce::AudioProcessorEditor> editor;
  juce::WebBrowserComponent* web = nullptr;
};

Opened open(SigilAudioProcessor& p, int x, int y) {
  Opened o;
  o.editor.reset(p.createEditor());
  if (o.editor == nullptr) return o;
  o.editor->setVisible(true);
  o.editor->addToDesktop(juce::ComponentPeer::windowHasTitleBar
                         | juce::ComponentPeer::windowHasDropShadow);
  o.editor->setTopLeftPosition(x, y);
  o.web = webOf(*o.editor);
  return o;
}

/**
 * The keys that must never appear in the plugin's storage.
 *
 * They are per-instance sound, and the WebView's storage is per ORIGIN, which
 * means one key for every SIGIL in the project. The host owns this state, once
 * per instance, through getStateInformation. See use-instrument.ts and
 * use-arrangement.ts, which turn these writes off when inPlugin().
 */
const char* const kMustNotPersist[] = {"sigil.session.v2", "sigil.delaySync",
                                       "sigil.arrangement.v1"};

// ---------------------------------------------------------------------------
// Mode: hold N editors open and report, for looking at rather than asserting.
// ---------------------------------------------------------------------------
int holdMode(int holdMs) {
  const char* countEnv = std::getenv("SIGIL_EDITOR_COUNT");
  const int count = countEnv != nullptr ? juce::jmax(1, juce::String(countEnv).getIntValue()) : 2;

  std::vector<std::unique_ptr<SigilAudioProcessor>> procs;
  std::vector<Opened> opened;

  for (int i = 0; i < count; ++i) {
    procs.push_back(std::make_unique<SigilAudioProcessor>());
    procs.back()->prepareToPlay(48000.0, 512);
    opened.push_back(open(*procs.back(), 20 + 60 * i, 60 + 60 * i));
    if (opened.back().web == nullptr) continue;
    const bool up = waitForPage(*opened.back().web);
    note("editor " + juce::String(i + 1) + ": rendered=" + juce::String(up ? 1 : 0)
         + " nodes=" + juce::String(nodeCount(*opened.back().web)));
  }

  pump(holdMs);

  for (size_t i = 0; i < opened.size(); ++i) {
    if (opened[i].web == nullptr) continue;
    note("editor " + juce::String((int)i + 1) + ": nodes="
         + juce::String(nodeCount(*opened[i].web)) + "  localStorage="
         + storageKeys(*opened[i].web));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Mode: two REAL VST3 instances, which is the one layer direct instantiation
// cannot reach - the wrapper, the host's NSView embedding, two views attached.
// ---------------------------------------------------------------------------
int vst3Mode(const juce::String& bundle) {
  juce::VST3PluginFormat format;
  juce::OwnedArray<juce::PluginDescription> found;
  format.findAllTypesForFile(found, bundle);
  check(!found.isEmpty(), "VST3 bundle scanned");
  if (found.isEmpty()) return 1;

  juce::AudioPluginFormatManager manager;
  manager.addFormat(std::make_unique<juce::VST3PluginFormat>());

  std::vector<std::unique_ptr<juce::AudioPluginInstance>> insts;
  std::vector<std::unique_ptr<juce::DocumentWindow>> windows;

  for (int i = 0; i < 2; ++i) {
    juce::String err;
    auto inst = manager.createPluginInstance(*found[0], 48000.0, 512, err);
    check(inst != nullptr, "instance " + juce::String(i + 1) + " created " + err);
    if (inst == nullptr) return 1;
    inst->prepareToPlay(48000.0, 512);

    auto* ed = inst->createEditorAndMakeActive();
    check(ed != nullptr, "instance " + juce::String(i + 1) + " editor created");
    if (ed == nullptr) return 1;

    auto win = std::make_unique<juce::DocumentWindow>("SIGIL " + juce::String(i + 1),
                                                      juce::Colours::black,
                                                      juce::DocumentWindow::closeButton);
    win->setUsingNativeTitleBar(true);
    win->setContentNonOwned(ed, true);
    win->setTopLeftPosition(40 + 80 * i, 60 + 80 * i);
    win->setVisible(true);
    win->toFront(true);

    insts.push_back(std::move(inst));
    windows.push_back(std::move(win));
    // The second one arrives on top of a first that is already up, which is the
    // moment the bug this file was written for is reported to happen.
    pump(4000);
  }

  pump(8000);

  for (size_t i = 0; i < insts.size(); ++i) {
    auto* ed = insts[i]->getActiveEditor();
    note("instance " + juce::String((int)i + 1) + " editor "
         + (ed != nullptr ? ed->getBounds().toString() : juce::String("(gone)"))
         + " showing=" + juce::String(ed != nullptr && ed->isShowing() ? 1 : 0));
    check(ed != nullptr && ed->getWidth() > 100 && ed->getHeight() > 100 && ed->isShowing(),
          "instance " + juce::String((int)i + 1) + " editor still on screen");
  }

  windows.clear();
  insts.clear();
  return 0;
}

}  // namespace

int main() {
  const juce::ScopedJuceInitialiser_GUI juceInit;

  if (const char* bundle = std::getenv("SIGIL_EDITOR_VST3")) {
    const int r = vst3Mode(juce::String(bundle));
    std::printf("\n%s: %d failure(s)\n", failures == 0 ? "PASS" : "FAIL", failures);
    return r != 0 ? r : (failures == 0 ? 0 : 1);
  }

  if (const char* holdEnv = std::getenv("SIGIL_EDITOR_HOLD_MS")) {
    return holdMode(juce::String(holdEnv).getIntValue());
  }

  auto a = std::make_unique<SigilAudioProcessor>();
  auto b = std::make_unique<SigilAudioProcessor>();
  a->prepareToPlay(48000.0, 512);
  b->prepareToPlay(48000.0, 512);

  const juce::String id = firstParamId(*a);
  check(id.isNotEmpty(), "found a parameter id to drive");
  if (id.isEmpty()) return 1;

  // ---- 1. one instance, on its own ---------------------------------------
  auto A = open(*a, 20, 60);
  check(A.editor != nullptr && A.web != nullptr, "instance A editor opened");
  if (A.web == nullptr) return 1;
  check(waitForPage(*A.web), "instance A page rendered");

  // The WebView's storage lives on disk and outlives the process, so a key left
  // by an older build would read as a live leak. Start from nothing.
  eval(*A.web, "localStorage.clear(); 'done'");

  const double aStart = valueOf(*a, id);
  const double aWant = aStart + (aStart == 0.0 ? 0.25 : aStart * 0.5);
  setFromPage(*A.web, id, aWant);
  pump(600);
  check(std::abs(valueOf(*a, id) - aWant) < 1e-3, "page A drives processor A while alone");

  // ---- 2. the second instance arrives, late ------------------------------
  auto B = open(*b, 120, 140);
  check(B.editor != nullptr && B.web != nullptr, "instance B editor opened");
  if (B.web == nullptr) return 1;
  check(waitForPage(*B.web), "instance B page rendered");
  check(nodeCount(*A.web) > 50, "instance A page still rendered after B opened");

  const double bStart = valueOf(*b, id);
  const double bWant = bStart + (bStart == 0.0 ? 0.4 : bStart * 0.75);
  const double aHeld = valueOf(*a, id);
  setFromPage(*B.web, id, bWant);
  pump(600);
  note(id + ": A " + juce::String(aHeld, 6) + " -> " + juce::String(valueOf(*a, id), 6) + "   B "
       + juce::String(bStart, 6) + " -> " + juce::String(valueOf(*b, id), 6) + " (asked "
       + juce::String(bWant, 6) + ")");
  check(std::abs(valueOf(*b, id) - bWant) < 1e-3, "page B moves processor B");
  check(std::abs(valueOf(*a, id) - aHeld) < 1e-9, "page B does NOT move processor A");

  const double aWant2 = aHeld * 0.5 + 0.05;
  const double bHeld = valueOf(*b, id);
  setFromPage(*A.web, id, aWant2);
  pump(600);
  check(std::abs(valueOf(*a, id) - aWant2) < 1e-3, "page A moves processor A");
  check(std::abs(valueOf(*b, id) - bHeld) < 1e-9, "page A does NOT move processor B");

  // ---- 3. host -> UI -----------------------------------------------------
  const juce::String textA0 = bodyText(*A.web);
  const juce::String textB0 = bodyText(*B.web);
  auto* engine = a->engineParam();
  check(engine != nullptr && engine->choices.size() > 1, "engine selector has choices");
  if (engine != nullptr && engine->choices.size() > 1) {
    const int wanted = engine->getIndex() == 0 ? 1 : 0;
    engine->beginChangeGesture();
    engine->setValueNotifyingHost(engine->convertTo0to1((float)wanted));
    engine->endChangeGesture();
    pump(1500);
    note("A: " + textA0);
    note("-> " + bodyText(*A.web));
    check(bodyText(*A.web) != textA0, "processor A's engine change reached page A");
    check(bodyText(*B.web) == textB0, "processor A's engine change did NOT reach page B");
    check(a->activeEngineId() != b->activeEngineId(), "processors hold different engines");
  }

  // ---- 4. the shared storage stays free of per-instance sound ------------
  // One origin, one localStorage, however many SIGILs are in the project. A key
  // holding a sound here is a key every other instance would load.
  const juce::String keys = storageKeys(*B.web);
  note("shared localStorage after two instances: " + (keys.isEmpty() ? "(empty)" : keys));
  for (const char* key : kMustNotPersist) {
    check(!keys.contains(key), juce::String(key) + " is not written from inside the plugin");
  }

  // ---- 5. churn: A's window closed and reopened under B ------------------
  for (int round = 1; round <= 3; ++round) {
    A.editor.reset();
    A.web = nullptr;
    pump(400);
    check(nodeCount(*B.web) > 50,
          "round " + juce::String(round) + ": page B survives A being destroyed");

    A = open(*a, 20, 60);
    check(A.web != nullptr && waitForPage(*A.web),
          "round " + juce::String(round) + ": page A comes back");
    if (A.web == nullptr) break;

    const double held = valueOf(*b, id);
    const double want = 0.02 * round + 0.01;
    setFromPage(*A.web, id, want);
    pump(600);
    check(std::abs(valueOf(*a, id) - want) < 1e-3,
          "round " + juce::String(round) + ": reopened page A drives processor A");
    check(std::abs(valueOf(*b, id) - held) < 1e-9,
          "round " + juce::String(round) + ": reopened page A leaves processor B alone");
    check(bodyText(*B.web).isNotEmpty(),
          "round " + juce::String(round) + ": page B still has content");
  }

  // ---- 6. hidden and shown again, the way a host parks a window ---------
  if (A.web != nullptr) {
    A.editor->setVisible(false);
    pump(500);
    B.editor->toFront(true);
    pump(500);
    A.editor->setVisible(true);
    pump(1500);
    check(nodeCount(*A.web) > 50, "page A survives being hidden and shown");
    const double held = valueOf(*b, id);
    setFromPage(*A.web, id, 0.123);
    pump(600);
    check(std::abs(valueOf(*a, id) - 0.123) < 1e-3, "page A drives processor A after hide/show");
    check(std::abs(valueOf(*b, id) - held) < 1e-9, "page B untouched after A hide/show");
  }

  A.editor.reset();
  B.editor.reset();
  pump(300);

  std::printf("\n%s: %d failure(s)\n", failures == 0 ? "PASS" : "FAIL", failures);
  return failures == 0 ? 0 : 1;
}
