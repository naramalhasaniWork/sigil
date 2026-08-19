// Convenience umbrella for the fx-magic port. The DSP itself lives under
// src/dsp/ with the rest of the ported modules; this header exists so the VST3
// wrapper can include one file named after the TypeScript module.
#pragma once
#include "dsp/fx_magic.h"          // MagicChain
#include "dsp/fx_magic_descriptor.h"  // primitives + MAGIC_PARAMS table
#include "dsp/fx_magic_units.h"       // Freezer, Shimmer, VowelFilter, Stutter
