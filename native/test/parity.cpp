// SIGIL parity harness: loader, comparator, reporter, main().
#include "parity.h"

#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>

#ifndef SIGIL_GOLDENS_DIR
#define SIGIL_GOLDENS_DIR "goldens"
#endif

namespace parity {

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
namespace {
std::map<std::string, Runner>& registry() {
  static std::map<std::string, Runner> r;
  return r;
}
}  // namespace

void registerRunner(const std::string& idPrefix, Runner fn) {
  registry()[idPrefix] = std::move(fn);
}

Runner findRunner(const std::string& id) {
  Runner best = nullptr;
  size_t bestLen = 0;
  for (const auto& kv : registry()) {
    const std::string& pre = kv.first;
    if (id.size() >= pre.size() && id.compare(0, pre.size(), pre) == 0 && pre.size() >= bestLen) {
      best = kv.second;
      bestLen = pre.size();
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Binary IO. Goldens are little-endian float32; assemble byte by byte so the
// rig does not silently depend on host endianness.
// ---------------------------------------------------------------------------
std::vector<float> readF32(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) {
    std::cerr << "parity: cannot open " << path << "\n";
    std::exit(2);
  }
  f.seekg(0, std::ios::end);
  const std::streamoff bytes = f.tellg();
  f.seekg(0, std::ios::beg);
  if (bytes % 4 != 0) {
    std::cerr << "parity: " << path << " is not a whole number of float32\n";
    std::exit(2);
  }
  const size_t n = static_cast<size_t>(bytes) / 4;
  std::vector<unsigned char> raw(static_cast<size_t>(bytes));
  f.read(reinterpret_cast<char*>(raw.data()), bytes);
  std::vector<float> out(n);
  for (size_t i = 0; i < n; ++i) {
    const std::uint32_t bits = static_cast<std::uint32_t>(raw[i * 4]) |
                               (static_cast<std::uint32_t>(raw[i * 4 + 1]) << 8) |
                               (static_cast<std::uint32_t>(raw[i * 4 + 2]) << 16) |
                               (static_cast<std::uint32_t>(raw[i * 4 + 3]) << 24);
    float v;
    std::memcpy(&v, &bits, 4);
    out[i] = v;
  }
  return out;
}

namespace {

std::vector<std::string> splitTabs(const std::string& line) {
  std::vector<std::string> out;
  size_t start = 0;
  for (size_t i = 0; i <= line.size(); ++i) {
    if (i == line.size() || line[i] == '\t') {
      out.push_back(line.substr(start, i - start));
      start = i + 1;
    }
  }
  return out;
}

void loadParams(const std::string& dir, std::map<std::string, Case*>& byId) {
  std::ifstream f(dir + "/params.tsv");
  if (!f) return;
  std::string line;
  while (std::getline(f, line)) {
    if (line.empty() || line[0] == '#') continue;
    const auto c = splitTabs(line);
    if (c.size() < 3) continue;
    auto it = byId.find(c[0]);
    if (it != byId.end()) it->second->p.set(c[1], c[2]);
  }
}

}  // namespace

std::vector<Case> loadIndex(const std::string& dir) {
  std::ifstream f(dir + "/index.tsv");
  if (!f) {
    std::cerr << "parity: cannot open " << dir << "/index.tsv\n"
              << "        run `node scripts/golden.mjs` first.\n";
    std::exit(2);
  }
  std::vector<Case> cases;
  std::string line;
  while (std::getline(f, line)) {
    if (line.empty() || line[0] == '#') continue;
    const auto c = splitTabs(line);
    if (c.size() < 12) continue;
    Case k;
    k.id = c[0];
    k.module = c[1];
    k.tolClass = c[2];
    k.tolMaxAbs = std::strtod(c[3].c_str(), nullptr);
    k.tolRms = std::strtod(c[4].c_str(), nullptr);
    k.channels = std::atoi(c[5].c_str());
    k.frames = std::atoi(c[6].c_str());
    k.outFile = c[7];
    k.inFile = c[8] == "-" ? "" : c[8];
    k.inChannels = std::atoi(c[9].c_str());
    k.inFrames = std::atoi(c[10].c_str());
    k.asset = c[11] == "-" ? "" : c[11];
    cases.push_back(std::move(k));
  }
  std::map<std::string, Case*> byId;
  for (auto& k : cases) byId[k.id] = &k;
  loadParams(dir, byId);
  return cases;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
Diff compare(const std::vector<float>& got, const std::vector<float>& want, double tolMaxAbs) {
  Diff d;
  d.n = want.size();
  if (got.size() != want.size()) {
    d.maxAbs = std::numeric_limits<double>::infinity();
    d.overCount = want.size();
    return d;
  }
  double sum = 0.0;
  std::vector<std::pair<double, size_t>> errs;
  errs.reserve(want.size());
  for (size_t i = 0; i < want.size(); ++i) {
    const double a = static_cast<double>(got[i]);
    const double b = static_cast<double>(want[i]);
    if (a != 0.0) d.candidateAllZero = false;
    if (b != 0.0) d.goldenAllZero = false;
    if (!std::isfinite(a)) {
      ++d.nonFinite;
      d.maxAbs = std::numeric_limits<double>::infinity();
      d.worst = i;
      ++d.overCount;
      continue;
    }
    const double e = std::fabs(a - b);
    sum += e * e;
    if (e > d.maxAbs) { d.maxAbs = e; d.worst = i; }
    if (e > tolMaxAbs) ++d.overCount;
    errs.emplace_back(e, i);
  }
  d.rms = want.empty() ? 0.0 : std::sqrt(sum / static_cast<double>(want.size()));
  const size_t keep = std::min<size_t>(5, errs.size());
  std::partial_sort(errs.begin(), errs.begin() + static_cast<long>(keep), errs.end(),
                    [](const auto& x, const auto& y) { return x.first > y.first; });
  for (size_t i = 0; i < keep; ++i) {
    if (errs[i].first == 0.0) break;
    d.worstIndices.push_back(errs[i].second);
  }
  return d;
}

}  // namespace parity

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
namespace {

struct Options {
  std::string dir = SIGIL_GOLDENS_DIR;
  std::string filterId, filterModule, filterPrefix;
  bool strict = false;
  bool list = false;
  bool verbose = false;
  double tolScale = 1.0;
};

void usage() {
  std::cout <<
      "sigil-parity - measure the C++ port against the TypeScript goldens\n\n"
      "  --goldens <dir>     golden directory (default: build-time SIGIL_GOLDENS_DIR)\n"
      "  --id <exact>        run one case\n"
      "  --case <prefix>     run cases whose id starts with <prefix>\n"
      "  --module <file.ts>  run cases for one TS source file, e.g. ladder.ts\n"
      "  --list              list cases and whether a C++ runner is registered\n"
      "  --strict            treat unimplemented cases as failures\n"
      "  --tolerance-scale N multiply every tolerance by N (printed in the report;\n"
      "                      use this instead of editing the manifest, so a loosened\n"
      "                      bar is visible in the log)\n"
      "  --verbose           print PASS lines too\n";
}

std::string fmt(double v) {
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%.3e", v);
  return buf;
}

}  // namespace

int main(int argc, char** argv) {
  Options o;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : std::string(); };
    if (a == "--goldens") o.dir = next();
    else if (a == "--id") o.filterId = next();
    else if (a == "--case") o.filterPrefix = next();
    else if (a == "--module") o.filterModule = next();
    else if (a == "--strict") o.strict = true;
    else if (a == "--list") o.list = true;
    else if (a == "--verbose" || a == "-v") o.verbose = true;
    else if (a == "--tolerance-scale") o.tolScale = std::strtod(next().c_str(), nullptr);
    else if (a == "--help" || a == "-h") { usage(); return 0; }
    else { std::cerr << "parity: unknown option " << a << "\n"; usage(); return 2; }
  }

  auto cases = parity::loadIndex(o.dir);

  size_t pass = 0, fail = 0, skip = 0, selected = 0;
  std::vector<std::string> failed, skipped;

  for (auto& c : cases) {
    if (!o.filterId.empty() && c.id != o.filterId) continue;
    if (!o.filterModule.empty() && c.module != o.filterModule) continue;
    if (!o.filterPrefix.empty() && c.id.compare(0, o.filterPrefix.size(), o.filterPrefix) != 0) continue;
    ++selected;

    parity::Runner run = parity::findRunner(c.id);

    if (o.list) {
      std::cout << (run ? "[impl] " : "[----] ") << std::left << std::setw(40) << c.id
                << " " << std::setw(24) << c.module << " " << c.tolClass << "\n";
      continue;
    }

    if (!run) {
      ++skip;
      skipped.push_back(c.id);
      if (o.verbose) std::cout << "SKIP  " << c.id << "  (no C++ runner registered)\n";
      continue;
    }

    c.golden = parity::readF32(o.dir + "/" + c.outFile);
    if (!c.inFile.empty()) c.input = parity::readF32(o.dir + "/" + c.inFile);
    if (!c.asset.empty()) c.assetData = parity::readF32(o.dir + "/" + c.asset);

    std::vector<float> got;
    const bool ok = run(c, got);
    if (!ok) {
      ++skip;
      skipped.push_back(c.id);
      if (o.verbose) std::cout << "SKIP  " << c.id << "  (runner declined)\n";
      continue;
    }

    const double tolMax = c.tolMaxAbs * o.tolScale;
    const double tolRms = c.tolRms * o.tolScale;
    const parity::Diff d = parity::compare(got, c.golden, tolMax);

    // A stub that returns silence must never read as a pass.
    const bool silentStub = d.candidateAllZero && !d.goldenAllZero;
    const bool good = !silentStub && d.maxAbs <= tolMax && d.rms <= tolRms && d.nonFinite == 0;

    if (good) {
      ++pass;
      if (o.verbose) {
        std::cout << "PASS  " << std::left << std::setw(40) << c.id
                  << " maxAbs " << fmt(d.maxAbs) << "  rms " << fmt(d.rms)
                  << "  (" << c.tolClass << ", tol " << fmt(tolMax) << ")\n";
      }
      continue;
    }

    ++fail;
    failed.push_back(c.id);
    std::cout << "FAIL  " << std::left << std::setw(40) << c.id
              << " maxAbs " << fmt(d.maxAbs) << " @ " << d.worst
              << "  rms " << fmt(d.rms)
              << "  over " << d.overCount << "/" << d.n
              << "  (" << c.module << ", " << c.tolClass << ", tol " << fmt(tolMax) << ")\n";
    if (silentStub) std::cout << "        candidate is all zeros but the golden is not\n";
    if (d.nonFinite) std::cout << "        " << d.nonFinite << " non-finite sample(s) in candidate\n";
    if (got.size() != c.golden.size()) {
      std::cout << "        length mismatch: got " << got.size()
                << " want " << c.golden.size() << "\n";
    } else {
      for (size_t idx : d.worstIndices) {
        std::cout << "        [" << idx << "] got " << std::setprecision(9) << got[idx]
                  << "  want " << c.golden[idx]
                  << "  d " << fmt(std::fabs(static_cast<double>(got[idx]) -
                                             static_cast<double>(c.golden[idx]))) << "\n";
      }
      // One isolated over-tolerance sample in a branchy module usually means a
      // state transition landed one sample early or late; broad drift usually
      // means a coefficient is wrong. Saying which is most of the diagnosis.
      if (d.overCount <= 4) {
        std::cout << "        shape: isolated (" << d.overCount
                  << " sample(s) over tolerance) - look for a one-sample state "
                     "transition shift, not a coefficient\n";
      } else if (d.overCount > d.n / 4) {
        std::cout << "        shape: broad (" << (100 * d.overCount / d.n)
                  << "% of samples over tolerance) - suspect a coefficient or a "
                     "structural difference\n";
      }
    }
    for (const auto& m : c.p.missing()) {
      std::cout << "        runner asked for parameter '" << m << "' which the golden does not define\n";
    }
  }

  if (o.list) {
    std::cout << "\n" << selected << " case(s) listed\n";
    return 0;
  }

  std::cout << "\n";
  if (o.tolScale != 1.0) {
    std::cout << "!! tolerances scaled by " << o.tolScale << " - this run is NOT at the stated bar\n";
  }
  std::cout << "parity: " << pass << " passed, " << fail << " failed, " << skip
            << " not implemented, of " << selected << " selected\n";
  if (!failed.empty()) {
    std::cout << "failed:";
    for (const auto& s : failed) std::cout << " " << s;
    std::cout << "\n";
  }
  if (o.strict && skip) {
    std::cout << "strict: " << skip << " unimplemented case(s) count as failures\n";
  }
  return (fail > 0 || (o.strict && skip > 0)) ? 1 : 0;
}
