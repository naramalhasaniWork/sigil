/**
 * One flat parameter address space shared by the main thread and the worklet.
 * Engines, the FX chain and the character FX all receive setParam(index, value)
 * through the same transport, so they are separated by offset rather than by
 * message type — one code path, no branching in the hot message handler.
 */
export const ENGINE_PARAM_BASE = 0;
export const FX_PARAM_BASE = 1000;
export const MAGIC_PARAM_BASE = 2000;

export type ParamSection = 'engine' | 'fx' | 'magic';

export function addressOf(section: ParamSection, index: number): number {
  if (section === 'fx') return FX_PARAM_BASE + index;
  if (section === 'magic') return MAGIC_PARAM_BASE + index;
  return ENGINE_PARAM_BASE + index;
}

export function sectionOf(address: number): { section: ParamSection; index: number } {
  if (address >= MAGIC_PARAM_BASE) {
    return { section: 'magic', index: address - MAGIC_PARAM_BASE };
  }
  if (address >= FX_PARAM_BASE) {
    return { section: 'fx', index: address - FX_PARAM_BASE };
  }
  return { section: 'engine', index: address };
}
