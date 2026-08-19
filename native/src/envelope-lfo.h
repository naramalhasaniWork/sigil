// Umbrella header for the envelope-lfo module of the SIGIL C++ port.
//
// The implementations live one per TypeScript source file, matching the layout
// the rest of native/src/dsp uses:
//
//   src/dsp/envelope.h   <- src/dsp/envelope.ts   (Envelope)
//   src/dsp/lfo.h        <- src/dsp/lfo.ts        (addOsc, Lfo)
//
// Include this when you want both; include the individual headers when you
// want one. Header-only, no allocation, no dependencies beyond <cmath>.
#pragma once

#include "dsp/envelope.h"
#include "dsp/lfo.h"
