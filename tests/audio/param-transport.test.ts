import { describe, it, expect } from 'vitest';
import { packParams, forEachParam } from '@/audio/param-transport';

describe('param transport', () => {
  it('round-trips index/value pairs', () => {
    const packed = packParams([[0, 1800], [3, 0.75], [9, 0.2]]);
    const seen: Array<[number, number]> = [];
    forEachParam(packed, (i, v) => { seen.push([i, v]); });
    expect(seen).toHaveLength(3);
    expect(seen[0]?.[0]).toBe(0);
    expect(seen[0]?.[1]).toBeCloseTo(1800, 2);
    expect(seen[2]?.[0]).toBe(9);
    expect(seen[2]?.[1]).toBeCloseTo(0.2, 5);
  });

  it('handles an empty update set', () => {
    let calls = 0;
    forEachParam(packParams([]), () => { calls++; });
    expect(calls).toBe(0);
  });
});
