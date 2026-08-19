// Port of src/dsp/tuning.ts and src/dsp/voice-manager.ts.
//
// Rules from util.h apply: JS `number` is `double`, Float32Array is `float`,
// same order and grouping. Two things here are load-bearing and easy to lose:
//
//  * claim() is not "steal the oldest". It prefers ANY released slot over ANY
//    held one, and only then compares age, and the scan starts from slots[0]
//    which is also the initial victim. Reproduced literally.
//  * noteOn re-pushes EVERY stored parameter into the voice before starting it.
//    A voice that has been sitting idle may hold values from a patch that was
//    changed while it was silent, so this is not redundant.
//
// Allocation: the voice pool and the parameter array are built in the
// constructor. noteOn/noteOff/setParam/render allocate nothing and throw
// nothing - std::vector is only ever indexed, never grown.
#pragma once

#include <cmath>
#include <memory>
#include <utility>
#include <vector>

namespace sigil {

/** Port of src/dsp/tuning.ts. */
class TuningTable {
public:
  void setEqualDivisions(double n) { divisions_ = n < 1.0 ? 1.0 : n; }

  void setReference(double midiNote, double hz) {
    refNote_ = midiNote;
    refHz_ = hz;
  }

  double frequency(double midiNote) const {
    return refHz_ * std::pow(2.0, (midiNote - refNote_) / divisions_);
  }

private:
  double divisions_ = 12.0;
  double refNote_ = 69.0;
  double refHz_ = 440.0;
};

/**
 * The engine-agnostic face of a VoiceManager. The processor holds one manager
 * per registered engine and switches with a pointer swap, exactly as
 * sigil-processor.ts does; this base class is what that pointer points at.
 *
 * The virtual call is per note event and per block, never per sample.
 */
class VoiceManagerBase {
public:
  virtual ~VoiceManagerBase() = default;

  virtual void setParam(int index, double value) = 0;
  virtual void noteOn(double midiNote, double velocity) = 0;
  virtual void noteOff(double midiNote) = 0;
  virtual void allNotesOff() = 0;
  virtual void render(float* out, int count) = 0;
  virtual int activeCount() const = 0;
  virtual int paramCount() const = 0;
  virtual double paramValue(int index) const = 0;

  TuningTable tuning;
};

/**
 * Owns polyphony so engines never have to think about it.
 *
 * `Alloc` is a callable returning a fresh voice; the sampler needs a SampleStore
 * reference its siblings do not, so construction is not uniform across engines.
 */
template <typename VoiceT>
class VoiceManager final : public VoiceManagerBase {
public:
  template <typename Alloc>
  VoiceManager(const double* defaults, int paramCount, int maxVoices, Alloc alloc)
      : paramCount_(paramCount) {
    paramValues_.assign(static_cast<size_t>(paramCount < 0 ? 0 : paramCount), 0.0f);
    for (int i = 0; i < paramCount_; i++) {
      paramValues_[static_cast<size_t>(i)] = static_cast<float>(defaults[i]);
    }
    slots_.reserve(static_cast<size_t>(maxVoices));
    // Heap-stable slots on purpose. SamplerVoice holds a pointer to one of its
    // own members (activeFilter_ = &ladder_), so a voice that is ever MOVED
    // points its filter at the corpse of the object it came from. Boxing the
    // slots means no voice is ever moved, whatever a later edit does to the
    // container.
    for (int i = 0; i < maxVoices; i++) {
      slots_.push_back(std::unique_ptr<Slot>(new Slot(alloc, i)));
    }
  }

  int activeCount() const override {
    int n = 0;
    for (const auto& s : slots_) {
      if (s->busy) n++;
    }
    return n;
  }

  int paramCount() const override { return paramCount_; }

  double paramValue(int index) const override {
    if (index < 0 || index >= paramCount_) return 0.0;
    return static_cast<double>(paramValues_[static_cast<size_t>(index)]);
  }

  void setParam(int index, double value) override {
    if (index < 0 || index >= paramCount_) return;
    paramValues_[static_cast<size_t>(index)] = static_cast<float>(value);
    for (auto& s : slots_) s->voice.setParam(index, value);
  }

  void noteOn(double midiNote, double velocity) override {
    Slot& slot = claim();
    for (int i = 0; i < paramCount_; i++) {
      slot.voice.setParam(i, static_cast<double>(paramValues_[static_cast<size_t>(i)]));
    }
    slot.note = midiNote;
    slot.age = counter_++;
    slot.held = true;
    slot.busy = true;
    // AnalogVoice and WavetableVoice declare voiceIndex as double, the other
    // four as int; slot.index is a small non-negative integer, so the implicit
    // widening is exact either way.
    slot.voice.noteOn(tuning.frequency(midiNote), velocity, slot.index);
  }

  /** Releases everything sounding - used when switching engines. */
  void allNotesOff() override {
    for (auto& s : slots_) {
      if (s->busy) {
        s->held = false;
        s->voice.noteOff();
      }
    }
  }

  void noteOff(double midiNote) override {
    for (auto& s : slots_) {
      if (s->busy && s->held && s->note == midiNote) {
        s->held = false;
        s->voice.noteOff();
      }
    }
  }

  void render(float* out, int count) override {
    for (auto& s : slots_) {
      if (!s->busy) continue;
      s->voice.render(out, 0, count);
      if (s->voice.isFinished()) {
        s->busy = false;
        s->note = -1.0;
        s->held = false;
      }
    }
  }

private:
  struct Slot {
    // `voice(alloc())` is direct-initialised from a prvalue, so C++17 elides
    // the copy entirely and the voice is built in place.
    template <typename Alloc>
    Slot(Alloc& alloc, int i) : voice(alloc()), index(i) {}
    VoiceT voice;
    int index;
    double note = -1.0;
    double age = 0.0;
    bool held = false;
    bool busy = false;
  };

  Slot& claim() {
    for (auto& s : slots_) {
      if (!s->busy) return *s;
    }
    Slot* victim = slots_[0].get();
    for (auto& s : slots_) {
      const bool better = (!s->held && victim->held) ||
                          (s->held == victim->held && s->age < victim->age);
      if (better) victim = s.get();
    }
    return *victim;
  }

  std::vector<std::unique_ptr<Slot>> slots_;
  std::vector<float> paramValues_;
  int paramCount_;
  double counter_ = 0.0;
};

}  // namespace sigil
