// Port of the primitives in src/dsp/fx-core.ts.
//
// The implementation lives in src/primitives.h (sigil::fx namespace), which
// ports smoothing.ts, blep.ts and the fx-core.ts primitives together as one
// foundation module. This header is kept so existing includes keep resolving;
// there is deliberately only one definition of these symbols in the tree.
//
// Still NOT ported: N_PARAMS and def(), which read FX_DESCRIPTOR out of
// fx-descriptor.ts, and the FxChain itself.
#pragma once
#include "../primitives.h"
