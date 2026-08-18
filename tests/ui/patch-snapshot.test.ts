import { describe, expect, it } from 'vitest';
import { cloneSnapshot, sameSnapshot, type PatchSnapshot } from '@/ui/patch-snapshot';

/**
 * Snapshot equality is the whole of undo's judgement: it decides what counts as
 * a step, and — because restoring re-bases on the restored snapshot — whether
 * undo records itself as a new change and eats its own redo.
 */

function base(): PatchSnapshot {
  return {
    engineId: 'analog',
    values: Float32Array.from([0.125, 0.25, 0.375]),
    fx: Float32Array.from([0.5, 0.625]),
    magic: Float32Array.from([0.75]),
    macros: [0.5, 0.5, 0.5, 0.5],
    presetId: null,
  };
}

describe('sameSnapshot', () => {
  it('holds for a value equal to itself', () => {
    expect(sameSnapshot(base(), base())).toBe(true);
  });

  it('sees a moved engine parameter', () => {
    const b = base();
    b.values = Float32Array.from([0.125, 0.25, 0.5]);
    expect(sameSnapshot(base(), b)).toBe(false);
  });

  it('sees a moved fx parameter — a sound is the whole chain', () => {
    const b = base();
    b.fx = Float32Array.from([0.5, 0.875]);
    expect(sameSnapshot(base(), b)).toBe(false);
  });

  it('sees a moved character parameter', () => {
    const b = base();
    b.magic = Float32Array.from([0.875]);
    expect(sameSnapshot(base(), b)).toBe(false);
  });

  it('sees a moved macro', () => {
    const b = base();
    b.macros = [0.5, 0.9, 0.5, 0.5];
    expect(sameSnapshot(base(), b)).toBe(false);
  });

  it('sees an engine change', () => {
    const b = base();
    b.engineId = 'fm';
    expect(sameSnapshot(base(), b)).toBe(false);
  });

  it('sees a preset change even when every value matches', () => {
    // Loading a preset whose values you had already dialled in still moves the
    // highlight, and undo has to put the highlight back.
    const b = base();
    b.presetId = 'analog-glass-bell';
    expect(sameSnapshot(base(), b)).toBe(false);
  });

  it('sees a differently sized parameter list', () => {
    const b = base();
    b.values = Float32Array.from([0.125, 0.25]);
    expect(sameSnapshot(base(), b)).toBe(false);
  });
});

describe('cloneSnapshot', () => {
  it('detaches every array, so later edits cannot rewrite history', () => {
    const live = base();
    const kept = cloneSnapshot(live);
    live.values[0] = 0.99;
    live.fx[0] = 0.99;
    live.magic[0] = 0.99;
    live.macros = [1, 1, 1, 1];
    expect(kept.values[0]).toBe(0.125);
    expect(kept.fx[0]).toBe(0.5);
    expect(kept.magic[0]).toBe(0.75);
    expect(kept.macros).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('round-trips exactly, so a restore never looks like a fresh edit', () => {
    const live = base();
    expect(sameSnapshot(live, cloneSnapshot(live))).toBe(true);
  });
});
