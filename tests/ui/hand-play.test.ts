import { describe, it, expect } from 'vitest';
import { nextPitchIndex, registerZone } from '@/ui/use-hand-play';

const SPAN = 14;

describe('nextPitchIndex', () => {
  it('takes the nearest note when nothing is sounding', () => {
    expect(nextPitchIndex(0, null, SPAN)).toBe(0);
    expect(nextPitchIndex(4.4, null, SPAN)).toBe(4);
    expect(nextPitchIndex(4.6, null, SPAN)).toBe(5);
  });

  it('holds the current note through wobble inside the deadband', () => {
    // A hand resting on note 5 drifting either way must not change note. This
    // is the behaviour that stops the retriggering that sounded like cutting off.
    for (const p of [4.4, 4.6, 5.0, 5.4, 5.6]) {
      expect(nextPitchIndex(p, 5, SPAN), `position ${p}`).toBe(5);
    }
  });

  it('changes note only once the hand has clearly committed', () => {
    expect(nextPitchIndex(5.68, 5, SPAN)).toBe(5);   // still inside 0.5 + 0.18
    expect(nextPitchIndex(5.7, 5, SPAN)).toBe(6);    // past it
    expect(nextPitchIndex(4.3, 5, SPAN)).toBe(4);
  });

  it('steps one note at a time so a fast sweep does not skip notes', () => {
    // Hand jumps five notes in one frame; the line walks rather than leaps.
    expect(nextPitchIndex(10, 5, SPAN)).toBe(6);
    expect(nextPitchIndex(0, 5, SPAN)).toBe(4);
  });

  it('never leaves the playable range', () => {
    expect(nextPitchIndex(-9, null, SPAN)).toBe(0);
    expect(nextPitchIndex(99, null, SPAN)).toBe(SPAN - 1);
    expect(nextPitchIndex(-9, 0, SPAN)).toBe(0);
    expect(nextPitchIndex(99, SPAN - 1, SPAN)).toBe(SPAN - 1);
  });

  it('respects a custom deadband', () => {
    expect(nextPitchIndex(5.9, 5, SPAN, 0.45)).toBe(5);
    expect(nextPitchIndex(5.9, 5, SPAN, 0.2)).toBe(6);
  });
});

describe('registerZone', () => {
  it('splits the frame into three registers', () => {
    expect(registerZone(0.1, null)).toBe(0);
    expect(registerZone(0.5, null)).toBe(1);
    expect(registerZone(0.9, null)).toBe(2);
  });

  it('holds its zone near a boundary so a drifting hand does not jump octaves', () => {
    // 1/3 is the 0->1 boundary. Just past it, keep the current zone.
    expect(registerZone(0.34, 0)).toBe(0);
    expect(registerZone(0.32, 1)).toBe(1);
  });

  it('switches once the hand clears the boundary properly', () => {
    expect(registerZone(0.45, 0)).toBe(1);
    expect(registerZone(0.2, 1)).toBe(0);
  });

  it('clamps at the edges', () => {
    expect(registerZone(-1, null)).toBe(0);
    expect(registerZone(2, null)).toBe(2);
  });
});
