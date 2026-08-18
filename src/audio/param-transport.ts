/** Packs parameter updates as [index, value, index, value, ...]. */
export function packParams(
  updates: ReadonlyArray<readonly [number, number]>,
): Float32Array {
  const buf = new Float32Array(updates.length * 2);
  for (let i = 0; i < updates.length; i++) {
    const pair = updates[i];
    if (!pair) continue;
    buf[i * 2] = pair[0];
    buf[i * 2 + 1] = pair[1];
  }
  return buf;
}

/** Zero-allocation read side — safe to call inside the worklet. */
export function forEachParam(
  packed: Float32Array,
  fn: (index: number, value: number) => void,
): void {
  for (let i = 0; i + 1 < packed.length; i += 2) {
    fn(packed[i] as number, packed[i + 1] as number);
  }
}
