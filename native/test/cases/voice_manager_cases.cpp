// Parity runners for voice-manager.ts and the audio-thread half of
// sigil-processor.ts.
//
// The event script is read out of the golden's own recorded parameters and
// replayed verbatim - nothing here decides when a note happens, which is the
// only way a voice-stealing test can mean anything. If the C++ claim() picks a
// different slot from the TypeScript one, the two renders separate on the very
// next sample and the case fails loudly.
#include <algorithm>
#include <string>
#include <vector>

#include "../../src/sigil-engine.h"
#include "../parity.h"

using parity::Case;

namespace {

constexpr int EV_NOTE_ON = 0, EV_NOTE_OFF = 1, EV_ALL_OFF = 2;
constexpr int EV_SET_PARAM = 3, EV_TUNING = 4;

struct Script {
  std::vector<int> segments;
  std::vector<int> seg, type;
  std::vector<double> a, b;
  bool ok = false;
};

Script readScript(const Case& c) {
  Script s;
  s.segments = c.p.ints("segments");
  s.seg = c.p.ints("evSeg");
  s.type = c.p.ints("evType");
  s.a = c.p.nums("evA");
  s.b = c.p.nums("evB");
  s.ok = !s.segments.empty() && !s.seg.empty() && s.seg.size() == s.type.size() &&
         s.seg.size() == s.a.size() && s.seg.size() == s.b.size();
  return s;
}

int engineIndexById(const std::string& id) {
  for (int e = 0; e < sigil::desc::kEngineCount; e++) {
    if (id == sigil::desc::kEngines[e].id) return e;
  }
  return -1;
}

void applyEvent(sigil::SigilEngine& eng, int engineIndex, int type, double a, double b) {
  switch (type) {
    case EV_NOTE_ON: eng.noteOn(a, b); break;
    case EV_NOTE_OFF: eng.noteOff(a); break;
    case EV_ALL_OFF: eng.allNotesOff(); break;
    case EV_SET_PARAM:
      eng.setParamByAddress(sigil::addressOf(sigil::ParamSection::kEngine,
                                             static_cast<int>(a)),
                            engineIndex, b);
      break;
    case EV_TUNING: eng.setTuning(a, 69.0, b); break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// VoiceManager alone: mono, no effects, additive render into a zeroed buffer.
// ---------------------------------------------------------------------------
bool run_voicemanager(const Case& c, std::vector<float>& out) {
  const Script s = readScript(c);
  if (!s.ok) return false;
  const int engineIndex = engineIndexById(c.p.str("engineId", ""));
  if (engineIndex < 0) return false;
  const int maxVoices = static_cast<int>(c.p.num("maxVoices"));

  sigil::SigilEngine eng;
  eng.prepare(48000.0, maxVoices);
  eng.setEngine(engineIndex);

  out.assign(static_cast<size_t>(c.frames), 0.0f);
  int pos = 0;
  for (size_t seg = 0; seg < s.segments.size(); seg++) {
    for (size_t e = 0; e < s.seg.size(); e++) {
      if (static_cast<size_t>(s.seg[e]) == seg) {
        applyEvent(eng, engineIndex, s.type[e], s.a[e], s.b[e]);
      }
    }
    const int n = s.segments[seg];
    if (pos + n > c.frames) return false;
    // The manager renders additively into a caller-zeroed buffer, exactly as in
    // the TS. Writing straight into `out` is that same contract.
    eng.renderVoicesOnly(out.data() + pos, n);
    pos += n;
  }
  return pos == c.frames;
}

// ---------------------------------------------------------------------------
// The processor's full path: manager -> FxChain -> MagicChain, stereo.
// ---------------------------------------------------------------------------
bool run_sigilchain(const Case& c, std::vector<float>& out) {
  const Script s = readScript(c);
  if (!s.ok || c.channels != 2) return false;
  const int engineIndex = engineIndexById(c.p.str("engineId", ""));
  if (engineIndex < 0) return false;
  const int maxVoices = static_cast<int>(c.p.num("maxVoices"));

  sigil::SigilEngine eng;
  eng.prepare(48000.0, maxVoices);
  eng.setEngine(engineIndex);

  const std::vector<int> fxIdx = c.p.ints("fxIndices");
  const std::vector<double> fxVal = c.p.nums("fxValues");
  if (fxIdx.size() != fxVal.size()) return false;
  for (size_t i = 0; i < fxIdx.size(); i++) {
    eng.setParamByAddress(sigil::addressOf(sigil::ParamSection::kFx, fxIdx[i]), engineIndex,
                          fxVal[i]);
  }
  const std::vector<int> mgIdx = c.p.ints("magicIndices");
  const std::vector<double> mgVal = c.p.nums("magicValues");
  if (mgIdx.size() != mgVal.size()) return false;
  for (size_t i = 0; i < mgIdx.size(); i++) {
    eng.setParamByAddress(sigil::addressOf(sigil::ParamSection::kMagic, mgIdx[i]), engineIndex,
                          mgVal[i]);
  }

  int maxSeg = 0;
  for (int n : s.segments) maxSeg = std::max(maxSeg, n);
  std::vector<float> left(static_cast<size_t>(maxSeg), 0.0f);
  std::vector<float> right(static_cast<size_t>(maxSeg), 0.0f);

  out.assign(static_cast<size_t>(c.frames) * 2, 0.0f);
  int pos = 0;
  for (size_t seg = 0; seg < s.segments.size(); seg++) {
    for (size_t e = 0; e < s.seg.size(); e++) {
      if (static_cast<size_t>(s.seg[e]) == seg) {
        applyEvent(eng, engineIndex, s.type[e], s.a[e], s.b[e]);
      }
    }
    const int n = s.segments[seg];
    if (pos + n > c.frames) return false;
    eng.render(left.data(), right.data(), n);
    for (int i = 0; i < n; i++) {
      out[static_cast<size_t>(pos + i) * 2] = left[static_cast<size_t>(i)];
      out[static_cast<size_t>(pos + i) * 2 + 1] = right[static_cast<size_t>(i)];
    }
    pos += n;
  }
  return pos == c.frames;
}

}  // namespace

PARITY_RUNNER("voicemanager_", run_voicemanager);
PARITY_RUNNER("sigilchain_", run_sigilchain);
