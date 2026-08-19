// Cross-check: the GENERATED descriptor table against the hand-ported constants
// already living in the DSP headers.
//
// sigil-descriptors.h is produced by native/tools/gen-descriptors.mjs straight
// out of the TypeScript, so it is the plugin's source of truth for parameter
// ids, ranges and defaults. The DSP headers carry their own copies of the same
// defaults, hand-transcribed and separately verified against the goldens. If
// the two ever disagree, one of them is wrong and the plugin would boot with
// different values from the reference. This asserts they agree.
//
// A count or default mismatch is a hard failure with the numbers printed.
#include <cmath>
#include <cstdio>
#include <string>

#include "../src/dsp/fx_magic_descriptor.h"
#include "../src/fx-chain-params.h"
#include "../src/sigil-descriptors.h"
#include "../src/voice-analog.h"
#include "../src/voice-fm.h"
#include "../src/voice-granular.h"
#include "../src/voice-physical.h"
#include "../src/voice-sampler.h"
#include "../src/voice-wavetable.h"

namespace {

int failures = 0;

void checkCount(const char* what, int generated, int handPorted) {
  if (generated != handPorted) {
    std::printf("FAIL  %s: descriptor says %d params, DSP header says %d\n", what, generated,
                handPorted);
    failures++;
  }
}

/**
 * Defaults are compared after a float32 round trip. Several DSP headers store
 * their defaults as float (the TS stores them in a Float32Array), so exact
 * double equality would flag a difference the reference does not have.
 */
void checkDefault(const char* what, int i, const char* id, double generated, double handPorted) {
  const double a = static_cast<double>(static_cast<float>(generated));
  const double b = static_cast<double>(static_cast<float>(handPorted));
  if (a != b) {
    std::printf("FAIL  %s[%d] (%s): descriptor default %.17g, DSP header %.17g\n", what, i, id,
                generated, handPorted);
    failures++;
  }
}

void checkId(const char* what, int i, const char* generated, const char* handPorted) {
  if (std::string(generated) != std::string(handPorted)) {
    std::printf("FAIL  %s[%d]: descriptor id \"%s\", DSP header \"%s\"\n", what, i, generated,
                handPorted);
    failures++;
  }
}

const sigil::desc::EngineDesc& engine(const char* id) {
  for (int e = 0; e < sigil::desc::kEngineCount; e++) {
    if (std::string(sigil::desc::kEngines[e].id) == id) return sigil::desc::kEngines[e];
  }
  std::printf("FAIL  engine \"%s\" missing from the generated descriptor table\n", id);
  failures++;
  return sigil::desc::kEngines[0];
}

}  // namespace

int main() {
  {
    const auto& d = engine("analog");
    checkCount("analog", d.count, sigil::kAnalogParamCount);
    for (int i = 0; i < d.count && i < sigil::kAnalogParamCount; i++) {
      checkId("analog", i, d.params[i].id, sigil::kAnalogParamIds[i]);
      checkDefault("analog", i, d.params[i].id, d.params[i].def, sigil::kAnalogParamDefaults[i]);
    }
  }
  {
    const auto& d = engine("fm");
    checkCount("fm", d.count, sigil::fm::kNumParams);
    for (int i = 0; i < d.count && i < sigil::fm::kNumParams; i++) {
      checkDefault("fm", i, d.params[i].id, d.params[i].def, sigil::fm::kDefaults[i]);
    }
  }
  {
    const auto& d = engine("physical");
    checkCount("physical", d.count, sigil::physical_detail::kNumParams);
    for (int i = 0; i < d.count && i < sigil::physical_detail::kNumParams; i++) {
      checkDefault("physical", i, d.params[i].id, d.params[i].def,
                   sigil::physical_detail::defaults()[i]);
    }
  }
  {
    const auto& d = engine("granular");
    checkCount("granular", d.count, sigil::granular::kNumParams);
    for (int i = 0; i < d.count && i < sigil::granular::kNumParams; i++) {
      checkDefault("granular", i, d.params[i].id, d.params[i].def, sigil::granular::kDefaults[i]);
    }
  }
  {
    const auto& d = engine("sampler");
    checkCount("sampler", d.count, sigil::sampler::kNumParams);
    for (int i = 0; i < d.count && i < sigil::sampler::kNumParams; i++) {
      checkDefault("sampler", i, d.params[i].id, d.params[i].def, sigil::sampler::kDefaults[i]);
    }
  }
  {
    const auto& d = engine("wavetable");
    checkCount("wavetable", d.count, sigil::kWavetableParamCount);
    for (int i = 0; i < d.count && i < sigil::kWavetableParamCount; i++) {
      checkId("wavetable", i, d.params[i].id, sigil::kWavetableParamIds[i]);
      checkDefault("wavetable", i, d.params[i].id, d.params[i].def,
                   sigil::kWavetableParamDefaults[i]);
    }
  }
  {
    const auto& d = sigil::desc::kFxDesc;
    checkCount("fx", d.count, sigil::fxchain::N_PARAMS);
    for (int i = 0; i < d.count && i < sigil::fxchain::N_PARAMS; i++) {
      checkId("fx", i, d.params[i].id, sigil::fxchain::paramIds()[i]);
      checkDefault("fx", i, d.params[i].id, d.params[i].def, sigil::fxchain::kDefault[i]);
    }
  }
  {
    const auto& d = sigil::desc::kMagicDesc;
    checkCount("magic", d.count, sigil::magic::kMagicParamCount);
    for (int i = 0; i < d.count && i < sigil::magic::kMagicParamCount; i++) {
      const auto& m = sigil::magic::MAGIC_PARAMS[static_cast<size_t>(i)];
      checkId("magic", i, d.params[i].id, m.id);
      checkDefault("magic", i, d.params[i].id, d.params[i].def, m.def);
      if (d.params[i].min != m.min || d.params[i].max != m.max) {
        std::printf("FAIL  magic[%d] (%s): range [%g, %g] vs [%g, %g]\n", i, d.params[i].id,
                    d.params[i].min, d.params[i].max, m.min, m.max);
        failures++;
      }
    }
  }

  // Every default must sit inside its own published range, or a host that
  // resets to default would immediately be out of bounds.
  int params = 0;
  for (int e = 0; e < sigil::desc::kEngineCount; e++) {
    const auto& d = sigil::desc::kEngines[e];
    for (int i = 0; i < d.count; i++) {
      params++;
      const auto& p = d.params[i];
      if (!(p.min <= p.def && p.def <= p.max) || !(p.min < p.max)) {
        std::printf("FAIL  %s.%s: default %g outside [%g, %g]\n", d.id, p.id, p.def, p.min, p.max);
        failures++;
      }
    }
  }

  if (failures == 0) {
    std::printf("descriptor check OK: %d engine params + %d fx + %d magic agree with the DSP\n",
                params, sigil::desc::kFxDesc.count, sigil::desc::kMagicDesc.count);
    return 0;
  }
  std::printf("descriptor check: %d failure(s)\n", failures);
  return 1;
}
