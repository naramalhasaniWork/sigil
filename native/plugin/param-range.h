// The mapping from a descriptor parameter to a JUCE parameter range.
//
// It lives in its own header because the host check needs the SAME mapping to
// convert a host-side normalised float back into a real value; two copies that
// drifted apart would make that comparison quietly meaningless.
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <cmath>

#include "sigil-descriptors.h"

namespace sigil {

inline juce::NormalisableRange<float> rangeFor(const desc::ParamDesc& p) {
  juce::NormalisableRange<float> r(static_cast<float>(p.min), static_cast<float>(p.max));
  const juce::String curve(p.curve);
  // No interval snapping, deliberately. `steps` in the descriptors is a coarse
  // UI and MIDI-learn hint, not a grid the DSP obeys: fm-descriptor.ts gives the
  // operator ratios min 0.5, max 16, steps 17, and an even 17-step grid does not
  // contain their default of 1.0 - snapping moved it to 1.46875, a 47% error and
  // a completely different sound. The engines quantise what they want to
  // quantise (quantizeRatio, Math.round on the wave selectors), as on the web.
  if ((curve == "exp" || curve == "log") && p.min > 0.0 && p.max > p.min) {
    // Geometric centre, so a frequency or time control spends half its travel
    // below the geometric mean instead of crowding everything at the top.
    r.setSkewForCentre(static_cast<float>(std::sqrt(p.min * p.max)));
  }
  return r;
}

}  // namespace sigil
