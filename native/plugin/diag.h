// Opt-in diagnostic log for the one question a DAW will not answer from the
// outside: what order did the host do things in, and who wrote to the
// parameters last.
//
// It exists because "the sound does not come back when I reopen the set"
// reproduces in no offline harness in this repository - the processor round trip
// passes, the VST3 wrapper round trip passes, and the round trip with a real
// editor and a real page attached passes (see tools/state_check.cpp and the
// restore modes in tools/editor_check.cpp). So the remaining evidence has to
// come from the DAW itself.
//
// OFF unless it is turned on, and turning it on is deliberate: a plugin that
// writes to disk while a session is running is not a plugin. Two ways in, both
// read ONCE per process, so Live has to be restarted for a change to take:
//
//   mkdir -p ~/Library/Logs/SIGIL && touch ~/Library/Logs/SIGIL/on
//   SIGIL_LOG=1 ./SIGIL.app/...        (the standalone, from a terminal)
//
// The log lands at ~/Library/Logs/SIGIL/plugin.log. Delete the `on` file to
// stop.
//
// Nothing here is called from processBlock. It touches the filesystem and takes
// a lock, so the audio thread must never see it.
#pragma once

#include <juce_core/juce_core.h>

#include <cstdlib>

namespace sigil {
namespace diag {

inline juce::File logDir() {
  return juce::File::getSpecialLocation(juce::File::userHomeDirectory)
      .getChildFile("Library/Logs/SIGIL");
}

inline bool enabled() {
  static const bool on = std::getenv("SIGIL_LOG") != nullptr
                         || logDir().getChildFile("on").existsAsFile();
  return on;
}

inline juce::CriticalSection& logLock() {
  static juce::CriticalSection l;
  return l;
}

inline void write(const juce::String& line) {
  if (!enabled()) return;
  const juce::ScopedLock sl(logLock());
  const juce::File f = logDir().getChildFile("plugin.log");
  f.getParentDirectory().createDirectory();
  // Truncated rather than rotated. This is read within minutes of being written,
  // and several instances writing every parameter move would otherwise fill a
  // disk over a long session.
  if (f.getSize() > 4 * 1024 * 1024) f.deleteFile();
  f.appendText(juce::Time::getCurrentTime().toISO8601(true) + "  " + line + "\n",
               false, false, "\n");
}

/** A short stable name for one instance, so several SIGILs in one project can be
 *  told apart in a single log. */
inline juce::String tag(const void* p) {
  return "[" + juce::String::toHexString(reinterpret_cast<juce::pointer_sized_int>(p))
                   .getLastCharacters(4)
       + "]";
}

}  // namespace diag
}  // namespace sigil
