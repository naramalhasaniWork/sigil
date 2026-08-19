// SIGIL parity harness.
//
// Loads the goldens produced by scripts/golden.mjs, hands each case to the C++
// module that is supposed to reproduce it, and measures the difference. There
// is deliberately no notion of "looks right" anywhere in here: a case either
// meets its stated numeric tolerance or it fails with the numbers printed.
//
// No dependencies beyond the C++17 standard library.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <fstream>
#include <functional>
#include <map>
#include <sstream>
#include <string>
#include <vector>

namespace parity {

// ---------------------------------------------------------------------------
// Case parameters, read from goldens/params.tsv
// ---------------------------------------------------------------------------
class Params {
public:
  void set(const std::string& k, const std::string& v) { kv_[k] = v; }
  bool has(const std::string& k) const { return kv_.find(k) != kv_.end(); }

  const std::string& str(const std::string& k, const std::string& fallback) const {
    auto it = kv_.find(k);
    return it == kv_.end() ? fallback : it->second;
  }

  // Missing keys are recorded, not silently defaulted: a runner that reads a
  // parameter the golden never wrote is a bug in the runner, and it would
  // otherwise show up as a mysterious numeric failure.
  double num(const std::string& k) const {
    auto it = kv_.find(k);
    if (it == kv_.end()) { missing_.push_back(k); return 0.0; }
    return std::strtod(it->second.c_str(), nullptr);
  }
  double num(const std::string& k, double fallback) const {
    auto it = kv_.find(k);
    return it == kv_.end() ? fallback : std::strtod(it->second.c_str(), nullptr);
  }
  bool flag(const std::string& k, bool fallback) const {
    auto it = kv_.find(k);
    return it == kv_.end() ? fallback : (it->second == "true" || it->second == "1");
  }
  std::vector<double> nums(const std::string& k) const {
    std::vector<double> out;
    auto it = kv_.find(k);
    if (it == kv_.end()) { missing_.push_back(k); return out; }
    std::stringstream ss(it->second);
    std::string tok;
    while (std::getline(ss, tok, ',')) out.push_back(std::strtod(tok.c_str(), nullptr));
    return out;
  }
  std::vector<int> ints(const std::string& k) const {
    std::vector<int> out;
    for (double d : nums(k)) out.push_back(static_cast<int>(d));
    return out;
  }
  const std::vector<std::string>& missing() const { return missing_; }
  const std::map<std::string, std::string>& all() const { return kv_; }

private:
  std::map<std::string, std::string> kv_;
  mutable std::vector<std::string> missing_;
};

// ---------------------------------------------------------------------------
// One golden case
// ---------------------------------------------------------------------------
struct Case {
  std::string id, module, tolClass, outFile, inFile, asset;
  double tolMaxAbs = 0.0, tolRms = 0.0;
  int channels = 1, frames = 0, inChannels = 0, inFrames = 0;
  Params p;

  std::vector<float> golden;     // interleaved, frames * channels
  std::vector<float> input;      // interleaved, inFrames * inChannels
  std::vector<float> assetData;  // shared material, mono

  bool hasInput() const { return inFrames > 0; }

  // De-interleave one channel. Cheap and only used at case setup, never inside
  // a render loop.
  std::vector<float> inputChannel(int c) const {
    std::vector<float> out(static_cast<size_t>(inFrames));
    for (int i = 0; i < inFrames; ++i) out[static_cast<size_t>(i)] = input[static_cast<size_t>(i) * inChannels + c];
    return out;
  }
  std::vector<float> goldenChannel(int c) const {
    std::vector<float> out(static_cast<size_t>(frames));
    for (int i = 0; i < frames; ++i) out[static_cast<size_t>(i)] = golden[static_cast<size_t>(i) * channels + c];
    return out;
  }
};

// A runner fills `out` with frames*channels interleaved floats and returns
// true. Returning false means "this case is not implemented here" and is
// reported as SKIP, never as a pass.
using Runner = std::function<bool(const Case&, std::vector<float>& out)>;

// Runners are matched by longest id prefix, so `ladder_` claims every ladder
// case and `ladder_impulse_` can still override it if you want.
void registerRunner(const std::string& idPrefix, Runner fn);
Runner findRunner(const std::string& id);

struct AutoRegister {
  AutoRegister(const std::string& prefix, Runner fn) { registerRunner(prefix, fn); }
};

#define PARITY_RUNNER(prefix, fn) \
  static const ::parity::AutoRegister parity_auto_##fn(prefix, fn)

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------
struct Diff {
  double maxAbs = 0.0;
  double rms = 0.0;
  size_t worst = 0;
  size_t overCount = 0;
  size_t nonFinite = 0;
  size_t n = 0;
  bool candidateAllZero = true;
  bool goldenAllZero = true;
  std::vector<size_t> worstIndices;  // up to 5, descending error
};

Diff compare(const std::vector<float>& got, const std::vector<float>& want, double tolMaxAbs);

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
std::vector<Case> loadIndex(const std::string& goldensDir);
std::vector<float> readF32(const std::string& path);

}  // namespace parity
