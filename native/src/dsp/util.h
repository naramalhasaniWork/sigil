// Shared porting primitives.
//
// PORTING RULES, in force everywhere under native/src/dsp:
//
//  1. A JavaScript `number` is an IEEE-754 double. Every value the TypeScript
//     holds in a plain field or local is `double` here. Only buffers the TS
//     explicitly declares as Float32Array become `float`, and only buffers it
//     declares Float64Array become `double[]` - the rounding at a Float32Array
//     store is audible state, not an implementation detail.
//  2. Evaluate in the same ORDER and the same GROUPING as the TS. Do not
//     rewrite `a + b*c` as an fma, do not factor, do not reassociate. The build
//     passes -ffp-contract=off precisely so the compiler cannot do it either.
//  3. Denormal and NaN guards are copied literally, including the exact
//     constant and the exact comparison direction. They are load-bearing.
//  4. No allocation in any process/render function. Buffers are sized in the
//     constructor.
//  5. std::exp / std::tan / std::sin are NOT guaranteed to give the same last
//     bit as V8's. That is expected and is why the `coeff` and `trans`
//     tolerance classes exist. It is never an excuse for an error larger than
//     those classes allow.
#pragma once

#include <cmath>
#include <cstdint>

namespace sigil {

/** JS `x | 0`: ToInt32, i.e. truncate toward zero then wrap to 32 bits. */
inline std::int32_t toInt32(double x) {
  if (!std::isfinite(x)) return 0;
  const double t = std::trunc(x);
  const double m = std::fmod(t, 4294967296.0);
  std::uint32_t u = static_cast<std::uint32_t>(m < 0 ? m + 4294967296.0 : m);
  return static_cast<std::int32_t>(u);
}

/** JS bitwise index arithmetic: `(a - b) & mask` on 32-bit wrapped ints. */
inline int maskIndex(int v, int mask) {
  return static_cast<int>(static_cast<std::uint32_t>(v) & static_cast<std::uint32_t>(mask));
}

/** JS `Math.round`: half away from... no - half UP, toward +Infinity. */
inline double jsRound(double x) { return std::floor(x + 0.5); }

}  // namespace sigil
