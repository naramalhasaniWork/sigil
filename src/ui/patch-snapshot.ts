/**
 * One complete sound, frozen.
 *
 * "The patch" is not the engine's parameters alone — a sound is the whole
 * chain, which is why Hunt mutates fx and character alongside the engine. So a
 * snapshot that only carried engine values would undo half a change and leave
 * the other half behind, which is worse than no undo at all.
 *
 * Deliberately NOT here: held notes, the export tray, the kit, the loop. Undo
 * is for the sound you are shaping, not for the take you recorded — pulling a
 * recording out from under someone because they pressed Cmd-Z is exactly the
 * kind of surprise undo exists to prevent.
 */
export interface PatchSnapshot {
  engineId: string;
  /** The active engine's parameters. Other engines keep their own values. */
  values: Float32Array;
  fx: Float32Array;
  magic: Float32Array;
  macros: readonly [number, number, number, number];
  /** Which preset this sound came from, so undo restores the highlight too. */
  presetId: string | null;
}

function sameNumbers(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    // Float32Array round-trips are exact, so an epsilon would only mask a
    // genuine difference and swallow a real undo step.
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** True when two snapshots describe the same sound. */
export function sameSnapshot(a: PatchSnapshot, b: PatchSnapshot): boolean {
  return a.engineId === b.engineId
    && a.presetId === b.presetId
    && sameNumbers(a.values, b.values)
    && sameNumbers(a.fx, b.fx)
    && sameNumbers(a.magic, b.magic)
    && sameNumbers(a.macros, b.macros);
}

/** A detached copy, so a later mutation of the live arrays cannot rewrite history. */
export function cloneSnapshot(s: PatchSnapshot): PatchSnapshot {
  return {
    engineId: s.engineId,
    values: Float32Array.from(s.values),
    fx: Float32Array.from(s.fx),
    magic: Float32Array.from(s.magic),
    macros: [...s.macros],
    presetId: s.presetId,
  };
}
