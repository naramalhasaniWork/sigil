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
// Modes:
//   (default)                    the checks, in Live's order
//   SIGIL_EDITOR_VST3=<path>     the same two instances loaded through the VST3
//                                host instead, which is the only way to
//                                exercise the wrapper and the host's own window
//   SIGIL_EDITOR_HOLD_MS=<ms>    hold SIGIL_EDITOR_COUNT editors open doing
//                                nothing, and report what each page put in the
//                                shared storage - for looking, not asserting
//
// And the save/restore round trip, which is what "the sound does not come back
// when I reopen the set" needs to be measured against. The processor-level state
// test (tools/state_check.cpp) passes that round trip with no wrapper and no
// page attached, so it cannot see anything either of those two do:
//   SIGIL_EDITOR_RESTORE=<path>  through the real VST3 wrapper, editors attached
//   SIGIL_EDITOR_RESTORE=direct  directly instantiated, so the PAGE can be
//                                driven and questioned as well
//   SIGIL_EDITOR_RESTORE=engine  the engine selector moving under a page showing
//                                a different engine - the smallest form of a
//                                real loss, and the one wired into ctest
//
// Needs a window server and opens real windows. The engine mode is in ctest and
// returns 77 (skip) when there is no screen; the rest are run by hand.
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
// Mode: save -> destroy -> recreate -> restore, through the REAL VST3 wrapper,
// with an editor attached and the page loaded. This is what the DAW does when a
// set is saved and reopened, and it is the layer the processor-level state test
// cannot see: there the plugin is a bare C++ object with no wrapper and no page.
//
//   SIGIL_EDITOR_RESTORE=<path to SIGIL.vst3>       with editors  (default)
//   SIGIL_EDITOR_RESTORE_NOEDITOR=1                 without editors, to isolate
//
// The order is Live's order: state is applied to a freshly created instance
// BEFORE it is activated and BEFORE its window is opened.
// ---------------------------------------------------------------------------
namespace restore {

struct Session {
  std::unique_ptr<juce::AudioPluginInstance> inst;
  std::unique_ptr<juce::DocumentWindow> window;
  juce::WebBrowserComponent* web = nullptr;
};

std::vector<float> paramSnapshot(juce::AudioPluginInstance& inst) {
  std::vector<float> out;
  for (auto* p : inst.getParameters()) out.push_back(p->getValue());
  return out;
}

/** Prints what moved, by name, and returns how many did. */
int diff(juce::AudioPluginInstance& inst, const std::vector<float>& a,
         const std::vector<float>& b, const juce::String& label, float tol = 1.0e-4f) {
  int moved = 0;
  const size_t n = juce::jmin(a.size(), b.size());
  for (size_t i = 0; i < n; ++i) {
    if (std::abs(a[i] - b[i]) <= tol) continue;
    if (moved < 12) {
      const juce::String name = (int)i < inst.getParameters().size()
                                    ? inst.getParameters()[(int)i]->getName(40)
                                    : juce::String("?");
      note(label + ": [" + juce::String((int)i) + "] " + name + "  "
           + juce::String(a[i], 6) + " -> " + juce::String(b[i], 6));
    }
    ++moved;
  }
  if (moved > 12) note(label + ": ... and " + juce::String(moved - 12) + " more");
  return moved;
}

/**
 * A block of audio with a note held, reduced to one number.
 *
 * Prepared first, deliberately. The engine has noise and drift in it, so its
 * output depends on how long it has been running, and the saved instance has
 * been processing blocks to flush parameter changes while the restored one is
 * fresh. Measured, comparing a warm instance against a cold one differed by 3%
 * with every parameter identical - which is the harness being unfair, not the
 * patch being wrong. Preparing both immediately before measuring starts them
 * from the same place.
 */
double renderEnergy(juce::AudioPluginInstance& inst) {
  inst.prepareToPlay(48000.0, 512);
  juce::AudioBuffer<float> buf(juce::jmax(2, inst.getTotalNumOutputChannels()), 512);
  double acc = 0.0;
  for (int b = 0; b < 120; ++b) {
    juce::MidiBuffer m;
    if (b == 0) m.addEvent(juce::MidiMessage::noteOn(1, 60, 0.8f), 0);
    if (b == 90) m.addEvent(juce::MidiMessage::noteOff(1, 60), 0);
    buf.clear();
    inst.processBlock(buf, m);
    for (int ch = 0; ch < juce::jmin(2, buf.getNumChannels()); ++ch) {
      const float* p = buf.getReadPointer(ch);
      for (int i = 0; i < 512; ++i) acc += std::abs((double)p[i]);
    }
  }
  return acc;
}

/** Empties the host's queued parameter changes into the plugin, the way a real
 *  host does: a host-side write is a queued event, not a direct call. */
void flush(juce::AudioPluginInstance& inst, int blocks = 4) {
  juce::AudioBuffer<float> buf(juce::jmax(2, inst.getTotalNumOutputChannels()), 512);
  for (int b = 0; b < blocks; ++b) {
    juce::MidiBuffer m;
    buf.clear();
    inst.processBlock(buf, m);
  }
}

Session make(juce::AudioPluginFormatManager& manager, const juce::PluginDescription& d,
             const juce::String& title, bool withEditor, bool activate) {
  Session s;
  juce::String err;
  s.inst = manager.createPluginInstance(d, 48000.0, 512, err);
  check(s.inst != nullptr, title + ": instance created " + err);
  if (s.inst == nullptr) return s;
  if (activate) s.inst->prepareToPlay(48000.0, 512);
  if (!withEditor) return s;

  auto* ed = s.inst->createEditorAndMakeActive();
  check(ed != nullptr, title + ": editor created");
  if (ed == nullptr) return s;
  s.window = std::make_unique<juce::DocumentWindow>(title, juce::Colours::black,
                                                    juce::DocumentWindow::closeButton);
  s.window->setUsingNativeTitleBar(true);
  s.window->setContentNonOwned(ed, true);
  s.window->setTopLeftPosition(40, 60);
  s.window->setVisible(true);
  s.window->toFront(true);
  // Through the VST3 wrapper the editor is an NSView the host embeds, so the
  // page is NOT reachable as a child Component from here. That is a limit of
  // this mode, not a failure: the page is still loaded and still running, which
  // is the thing being tested. restoreDirectMode() below is the variant that
  // can also talk to it.
  s.web = webOf(*ed);
  note(title + (s.web != nullptr ? ": page reachable" : ": page loaded but opaque to the host"));
  if (s.web != nullptr) check(waitForPage(*s.web), title + ": page rendered");
  else pump(6000);
  return s;
}

void teardown(Session& s) {
  /*
   * Order matters and there is no releaseResources() here.
   *
   * The editor belongs to the AudioPluginInstance, not to the window holding it
   * (setContentNonOwned), and through the VST3 wrapper it is a live IPlugView
   * with an NSView attached. Deactivating the plugin underneath an attached view
   * and then destroying both segfaults - measured, exit 139, before any of the
   * restore checks below got to run. Dropping the window, letting the message
   * loop settle, then dropping the instance is what the two-instance mode
   * already does, and it is the order that survives.
   */
  s.window.reset();
  s.web = nullptr;
  pump(500);
  s.inst.reset();
  pump(500);
}

}  // namespace restore

int restoreMode(const juce::String& bundle, bool withEditor) {
  using namespace restore;

  juce::VST3PluginFormat format;
  juce::OwnedArray<juce::PluginDescription> found;
  format.findAllTypesForFile(found, bundle);
  check(!found.isEmpty(), "VST3 bundle scanned");
  if (found.isEmpty()) return 1;

  juce::AudioPluginFormatManager manager;
  manager.addFormat(std::make_unique<juce::VST3PluginFormat>());

  note(withEditor ? "editors ATTACHED (page loaded)" : "no editors (wrapper only)");

  // ---- session one: dial a sound in, then save -------------------------
  auto one = make(manager, *found[0], "SIGIL save", withEditor, true);
  if (one.inst == nullptr) return 1;

  const int numParams = one.inst->getParameters().size();
  note("parameter count is " + juce::String(numParams));

  // The engine selector first, then a spread across every float. Driven from
  // the host side, which is the same route automation and a DAW preset take:
  // the write is QUEUED and only lands when the plugin next processes.
  auto* engine = one.inst->getParameters()[0];
  engine->beginChangeGesture();
  // Exactly on a choice step, or the harness's own value snaps and reads as a
  // loss. Six engines, so 0.4 is the third of them.
  engine->setValueNotifyingHost(0.4f);
  engine->endChangeGesture();
  flush(*one.inst);

  juce::Random rng(20260902);
  for (int i = 1; i < numParams - 1; ++i) {
    auto* p = one.inst->getParameters()[i];
    p->beginChangeGesture();
    p->setValueNotifyingHost(0.1f + 0.8f * rng.nextFloat());
    p->endChangeGesture();
  }
  flush(*one.inst);

  // And one write the way the USER makes one: through the page.
  if (withEditor && one.web != nullptr) {
    eval(*one.web, "window.__JUCE__.backend.emitEvent('sigilFromUi',"
                   "{t:'param', id:'fx.reverb-mix', v:0.77}); 'sent'");
    pump(800);
    flush(*one.inst);
  }

  const auto dialed = paramSnapshot(*one.inst);
  const double energyBefore = renderEnergy(*one.inst);

  juce::MemoryBlock saved;
  one.inst->getStateInformation(saved);
  check(saved.getSize() > 100, "host got a state chunk (" + juce::String((int)saved.getSize())
                                   + " bytes)");
  teardown(one);

  // ---- session two: a fresh instance, restored the way Live restores one --
  // Created, given the state, and only THEN activated and shown.
  auto two = make(manager, *found[0], "SIGIL restore", false, false);
  if (two.inst == nullptr) return 1;
  two.inst->setStateInformation(saved.getData(), (int)saved.getSize());
  pump(200);
  const auto afterState = paramSnapshot(*two.inst);
  check(diff(*two.inst, dialed, afterState, "lost by setStateInformation") == 0,
        "the patch survives setStateInformation through the VST3 wrapper");

  two.inst->prepareToPlay(48000.0, 512);
  flush(*two.inst);
  const auto afterPrepare = paramSnapshot(*two.inst);
  check(diff(*two.inst, afterState, afterPrepare, "lost by activation") == 0,
        "the patch survives activation");

  if (withEditor) {
    auto* ed = two.inst->createEditorAndMakeActive();
    check(ed != nullptr, "restored instance: editor created");
    if (ed != nullptr) {
      two.window = std::make_unique<juce::DocumentWindow>("SIGIL restore", juce::Colours::black,
                                                          juce::DocumentWindow::closeButton);
      two.window->setUsingNativeTitleBar(true);
      two.window->setContentNonOwned(ed, true);
      two.window->setTopLeftPosition(40, 60);
      two.window->setVisible(true);
      two.window->toFront(true);
      two.web = webOf(*ed);
      if (two.web != nullptr) check(waitForPage(*two.web), "restored instance: page rendered");
      // Long enough for 'ready', the snapshot, hydration, and anything the page
      // decides to do as a CONSEQUENCE of hydrating.
      pump(6000);
      flush(*two.inst);
      pump(1000);
      flush(*two.inst);
    }
  }

  const auto afterEditor = paramSnapshot(*two.inst);
  check(diff(*two.inst, afterPrepare, afterEditor, "lost after the page loaded") == 0,
        "the patch survives the interface loading on top of it");

  const int total = diff(*two.inst, dialed, afterEditor, "lost overall");
  check(total == 0, "the dialed sound is what a reopened project holds");

  const double energyAfter = renderEnergy(*two.inst);
  note("render energy: saved " + juce::String(energyBefore, 3) + "  restored "
       + juce::String(energyAfter, 3));
  /*
   * A loose bound, and honestly so. The engine has noise, drift and a reverb
   * tail in it, so this number depends on how long the instrument has been
   * running: measured, the SAME instance measured twice in a row differs by
   * 0.45%, and a warm instance against a cold one by about 3%. Tightening this
   * would only produce a red that means "one of them had been playing longer".
   *
   * The real assertion is the parameter comparison above, which is exact and
   * covers all 162. This is here to catch the failure that comparison could not
   * miss but which is worth stating in the language of the complaint: a patch
   * that reverted to defaults is a different instrument, not a 3% difference.
   */
  const double denom = juce::jmax(1.0e-9, std::abs(energyBefore));
  check(std::abs(energyAfter - energyBefore) / denom < 0.10,
        "the restored instance sounds like the saved one");

  teardown(two);
  return 0;
}

// ---------------------------------------------------------------------------
// Mode: the same save -> restore round trip on a DIRECTLY instantiated
// processor, so the page can be talked to.
//
// This is the one the wrapper cannot give us: the sound is dialed in THROUGH
// THE INTERFACE, the way the owner dials one, and after the restore the page is
// loaded on top and given time to do whatever hydrating makes it do. The state
// is compared as text, because the state IS the patch.
//
//   SIGIL_EDITOR_RESTORE=direct
// ---------------------------------------------------------------------------
namespace {

juce::String stateTextOf(SigilAudioProcessor& p) {
  juce::MemoryBlock b;
  p.getStateInformation(b);
  return juce::String::fromUTF8(static_cast<const char*>(b.getData()), (int)b.getSize());
}

std::vector<double> exactSnapshot(SigilAudioProcessor& p) {
  std::vector<double> out;
  for (const auto& r : p.paramRefs()) out.push_back(p.exactValueOf(r));
  return out;
}

int diffExact(SigilAudioProcessor& p, const std::vector<double>& a, const std::vector<double>& b,
              const juce::String& label) {
  int moved = 0;
  const size_t n = juce::jmin(a.size(), b.size());
  for (size_t i = 0; i < n; ++i) {
    const double scale = juce::jmax(1.0, std::abs(a[i]), std::abs(b[i]));
    if (std::abs(a[i] - b[i]) <= scale * 1.0e-5) continue;
    if (moved < 12) {
      auto* wid = dynamic_cast<juce::AudioProcessorParameterWithID*>(p.paramRefs()[i].param);
      note(label + ": " + (wid != nullptr ? wid->paramID : juce::String("?")) + "  "
           + juce::String(a[i], 6) + " -> " + juce::String(b[i], 6));
    }
    ++moved;
  }
  if (moved > 12) note(label + ": ... and " + juce::String(moved - 12) + " more");
  return moved;
}

}  // namespace

void setFromHost(SigilAudioProcessor& p, const juce::String& id, double v) {
  for (const auto& r : p.paramRefs()) {
    auto* wid = dynamic_cast<juce::AudioProcessorParameterWithID*>(r.param);
    if (wid == nullptr || wid->paramID != id) continue;
    r.param->beginChangeGesture();
    r.param->setValueNotifyingHost(r.param->convertTo0to1(static_cast<float>(v)));
    r.param->endChangeGesture();
    return;
  }
  check(false, "no parameter with id " + id);
}

/**
 * The engine selector moving while the page is showing a DIFFERENT engine.
 *
 * This is the shape of the loss, reduced to its smallest form. The processor
 * holds all six engines' values at once and a restored patch fills all of them;
 * the page only ever displays one, and it deliberately DROPS inbound values for
 * the other five because it has nowhere to put them. So the moment the engine
 * selector moves - a restored project, an automation lane, a device preset, an
 * undo - the page finds itself showing an engine whose values it never received,
 * and pushes what it happens to be holding back at the host.
 *
 * Run on its own so it is not masked: when the engine and its parameters arrive
 * in the SAME message, the page's own follow-up writes repair the damage by
 * accident, and the failure hides behind a race it usually wins.
 */
int engineSwitchMode() {
  note("the engine selector moving under a page showing another engine");

  auto p = std::make_unique<SigilAudioProcessor>();
  p->prepareToPlay(48000.0, 512);
  auto A = open(*p, 20, 60);
  // 77 is ctest's skip code. This needs a window server and a live WebView, and
  // "there is no screen" must not read as "the bug is back".
  if (A.web == nullptr || !waitForPage(*A.web)) {
    std::printf("SKIP  no window server or the page never rendered\n");
    return 77;
  }
  check(true, "page rendered");
  eval(*A.web, "localStorage.clear(); 'done'");
  pump(2500);  // 'ready', snapshot, hydrate: the page is synced and showing analog
  check(p->activeEngineId() == "analog", "the page is showing the default engine");

  // Values for an engine the page is NOT showing, set by the host. This is what
  // a restored patch looks like from the page's point of view.
  const char* const ids[] = {"physical.material", "physical.structure", "physical.decay",
                             "physical.damping", "physical.position", "physical.grit"};
  const double wanted[] = {0.81, 0.47, 610.0, 0.19, 0.33, 0.72};
  for (size_t i = 0; i < 6; ++i) setFromHost(*p, ids[i], wanted[i]);
  pump(1500);

  std::vector<double> held;
  for (size_t i = 0; i < 6; ++i) held.push_back(valueOf(*p, ids[i]));
  for (size_t i = 0; i < 6; ++i) {
    check(std::abs(held[i] - wanted[i]) < 0.5,
          juce::String(ids[i]) + " is held by the processor before the switch");
  }

  // And now the selector moves, on its own, the way a host moves it.
  eval(*A.web, "window.__sigilSeen=[];"
               "window.__JUCE__.backend.addEventListener('sigilFromHost',"
               "m=>window.__sigilSeen.push(m&&m.t));'hooked'");
  p->setActiveEngineId("physical");
  pump(4000);

  /*
   * The other half of the fix, and it needs asserting separately: a delta
   * carrying only the engine leaves the page DISPLAYING its stale values for an
   * engine it was never sent any, which is the interface lying about what is
   * sounding - and one click away from pushing those values for real. The whole
   * snapshot is what makes the page's copy true again.
   */
  const juce::String seen = eval(*A.web, "String(window.__sigilSeen)");
  note("messages the page received on the switch: " + seen);
  check(seen.contains("snapshot"), "the engine change hands the page the whole snapshot");

  int lost = 0;
  for (size_t i = 0; i < 6; ++i) {
    const double now = valueOf(*p, ids[i]);
    const double scale = juce::jmax(1.0, std::abs(held[i]));
    if (std::abs(now - held[i]) > scale * 1.0e-4) {
      note(juce::String(ids[i]) + ": " + juce::String(held[i], 6) + " -> "
           + juce::String(now, 6));
      ++lost;
    }
  }
  check(lost == 0, "switching engine does not overwrite what the processor holds");

  A.editor.reset();
  pump(300);
  p->releaseResources();
  return 0;
}

int restoreDirectMode() {
  note("direct processor + real editor + real page");

  juce::String saved;
  std::vector<double> dialed;

  {
    auto p = std::make_unique<SigilAudioProcessor>();
    p->prepareToPlay(48000.0, 512);
    auto A = open(*p, 20, 60);
    check(A.web != nullptr && waitForPage(*A.web), "save session: page rendered");
    if (A.web == nullptr) return 1;
    eval(*A.web, "localStorage.clear(); 'done'");

    // A sound, dialed in from the interface: a different engine, and a spread
    // of values across that engine, the fx chain and the character section.
    eval(*A.web, "window.__JUCE__.backend.emitEvent('sigilFromUi',{t:'engine',id:'physical'});'ok'");
    pump(600);

    juce::Random rng(20260902);
    int written = 0;
    for (const auto& r : p->paramRefs()) {
      auto* wid = dynamic_cast<juce::AudioProcessorParameterWithID*>(r.param);
      if (wid == nullptr) continue;
      const juce::String id = wid->paramID;
      if (!(id.startsWith("physical.") || id.startsWith("fx.") || id.startsWith("magic."))) continue;
      const auto range = r.param->getNormalisableRange();
      const double v = static_cast<double>(range.convertFrom0to1(static_cast<float>(0.15 + 0.7 * rng.nextDouble())));
      setFromPage(*A.web, id, v);
      ++written;
    }
    pump(1200);
    note("wrote " + juce::String(written) + " parameters from the page");

    saved = stateTextOf(*p);
    dialed = exactSnapshot(*p);
    check(saved.contains("\"engineId\": \"physical\""), "the saved state is the dialed engine");
    check(saved.length() > 500, "the saved state is a full patch (" + juce::String(saved.length())
                                    + " chars)");
    A.editor.reset();
    pump(400);
  }

  // ---- a fresh instance, Live's order: state first, then activate, then show
  auto q = std::make_unique<SigilAudioProcessor>();
  q->setStateInformation(saved.toRawUTF8(), (int)saved.getNumBytesAsUTF8());
  const auto afterState = exactSnapshot(*q);
  check(diffExact(*q, dialed, afterState, "lost by setStateInformation") == 0,
        "the patch survives setStateInformation");

  q->prepareToPlay(48000.0, 512);
  const auto afterPrepare = exactSnapshot(*q);
  check(diffExact(*q, afterState, afterPrepare, "lost by activation") == 0,
        "the patch survives activation");

  auto B = open(*q, 20, 60);
  check(B.web != nullptr && waitForPage(*B.web), "restore session: page rendered");
  if (B.web != nullptr) {
    // Everything the page does as a consequence of hydrating happens in here.
    pump(8000);
  }

  const auto afterEditor = exactSnapshot(*q);
  check(diffExact(*q, afterPrepare, afterEditor, "lost after the page loaded") == 0,
        "the patch survives the interface loading on top of it");

  const juce::String reread = stateTextOf(*q);
  check(reread == saved, "the state a reopened project would save is the state it loaded");
  if (reread != saved) {
    note("saved   " + saved.substring(0, 200));
    note("reread  " + reread.substring(0, 200));
  }
  check(diffExact(*q, dialed, afterEditor, "lost overall") == 0,
        "the dialed sound is what a reopened project holds");

  B.editor.reset();
  pump(300);
  q->releaseResources();

  // ---- the other order a host uses -------------------------------------
  // State arriving at an instance whose page is ALREADY up and already synced.
  // That is not an exotic case: it is a device preset dropped onto an open
  // plugin, an undo, and any host that opens the view before it applies the
  // state. The page is synced to the DEFAULTS here, which is the worst version
  // of it - if anything pushes back, defaults are what lands.
  {
    auto r = std::make_unique<SigilAudioProcessor>();
    r->prepareToPlay(48000.0, 512);
    auto C = open(*r, 20, 60);
    check(C.web != nullptr && waitForPage(*C.web), "open-page session: page rendered");
    if (C.web != nullptr) pump(3000);  // 'ready', snapshot, hydrate: the page is synced

    if (C.web != nullptr) {
      // Prove the page really is live and synced before the state lands, and
      // record what it is showing, so "no pushback" can be told apart from
      // "the page was never listening".
      note("page before: " + eval(*C.web, "String(document.body.innerText||'')"
                                          ".replace(/\\s+/g,' ').slice(0,60)"));
      eval(*C.web, "window.__sigilSeen=[];window.__sigilOut=[];"
                   "window.__JUCE__.backend.addEventListener('sigilFromHost',"
                   "p=>window.__sigilSeen.push(p&&p.t));"
                   "(()=>{const b=window.__JUCE__.backend,e=b.emitEvent.bind(b);"
                   "b.emitEvent=(id,p)=>{window.__sigilOut.push(JSON.stringify(p).slice(0,90));"
                   "return e(id,p);};})();'hooked'");
    }

    r->setStateInformation(saved.toRawUTF8(), (int)saved.getNumBytesAsUTF8());
    const auto justAfter = exactSnapshot(*r);
    check(diffExact(*r, dialed, justAfter, "lost immediately") == 0,
          "state into an open editor lands in the processor");
    pump(5000);  // everything the page does in reaction to it

    if (C.web != nullptr) {
      note("messages the page received: " + eval(*C.web, "String(window.__sigilSeen)"));
      note("messages the page sent: " + eval(*C.web, "String((window.__sigilOut||[]).length)"
                                                     "+' '+String(window.__sigilOut)"));
      note("page after: " + eval(*C.web, "String(document.body.innerText||'')"
                                         ".replace(/\\s+/g,' ').slice(0,60)"));
    }

    const auto settled = exactSnapshot(*r);
    check(diffExact(*r, justAfter, settled, "the page pushed back over it") == 0,
          "state into an open editor is not overwritten by the page");
    check(diffExact(*r, dialed, settled, "lost overall") == 0,
          "a patch loaded into an open editor is the patch that sounds");

    C.editor.reset();
    pump(300);
    r->releaseResources();
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

  if (const char* bundle = std::getenv("SIGIL_EDITOR_RESTORE")) {
    const bool withEditor = std::getenv("SIGIL_EDITOR_RESTORE_NOEDITOR") == nullptr;
    const juce::String which(bundle);
    const int r = which == "direct"   ? restoreDirectMode()
                  : which == "engine" ? engineSwitchMode()
                                      : restoreMode(which, withEditor);
    if (r == 77) return 77;  // ctest's skip code, passed straight through
    std::printf("\n%s: %d failure(s)\n", failures == 0 ? "PASS" : "FAIL", failures);
    return r != 0 ? r : (failures == 0 ? 0 : 1);
  }

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

  // ---- 3b. the two instances do not look alike ---------------------------
  // The other half of "several SIGILs in one project": nothing in the interface
  // said which one you were looking at, because every window was the same
  // window. The badge is dealt in creation order, so A and B must differ before
  // anyone has renamed anything.
  {
    const juce::String selector =
        "String((document.querySelector('[title=\"Click to rename this SIGIL\"]')||{})"
        ".textContent||'')";
    const juce::String nameA = eval(*A.web, selector);
    const juce::String nameB = eval(*B.web, selector);
    note("badges: A=\"" + nameA + "\"  B=\"" + nameB + "\"");
    check(nameA.isNotEmpty(), "instance A shows an identity badge");
    check(nameB.isNotEmpty(), "instance B shows an identity badge");
    check(nameA != nameB, "two instances are not dealt the same identity");
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
