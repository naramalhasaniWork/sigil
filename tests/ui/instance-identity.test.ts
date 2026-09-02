import { describe, expect, it } from 'vitest';
import {
  INSTANCE_IDENTITIES, identityFor, instanceLabel,
} from '@/ui/instance-identity';

describe('instance identity', () => {
  it('never deals two adjacent instances the same identity', () => {
    // The whole point. Two SIGILs side by side that read alike are the bug.
    for (let mark = 0; mark < INSTANCE_IDENTITIES.length - 1; mark++) {
      const a = identityFor(mark);
      const b = identityFor(mark + 1);
      expect(a.name).not.toBe(b.name);
      expect(a.tint).not.toBe(b.tint);
    }
  });

  it('has no repeated name or colour in the table', () => {
    const names = new Set(INSTANCE_IDENTITIES.map((i) => i.name));
    const tints = new Set(INSTANCE_IDENTITIES.map((i) => i.tint));
    expect(names.size).toBe(INSTANCE_IDENTITIES.length);
    expect(tints.size).toBe(INSTANCE_IDENTITIES.length);
  });

  it('gives every tint enough contrast to carry the page ground as text', () => {
    // The badge draws --bg (#0E0E0E) on the tint. WCAG AA for the 11px bold
    // label it holds is 4.5:1, and a colour that fails is a name you cannot
    // read, which defeats the entire feature.
    const channel = (c: number): number => (
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    );
    const luminance = (hex: string): number => {
      const n = parseInt(hex.slice(1), 16);
      const r = channel(((n >> 16) & 255) / 255);
      const g = channel(((n >> 8) & 255) / 255);
      const b = channel((n & 255) / 255);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ground = luminance('#0E0E0E');
    for (const identity of INSTANCE_IDENTITIES) {
      const ratio = (luminance(identity.tint) + 0.05) / (ground + 0.05);
      expect(ratio, `${identity.name} ${identity.tint}`).toBeGreaterThan(4.5);
    }
  });

  it('wraps rather than falling off the end of the table', () => {
    const n = INSTANCE_IDENTITIES.length;
    expect(identityFor(n)).toEqual(identityFor(0));
    expect(identityFor(n * 3 + 2)).toEqual(identityFor(2));
  });

  it('survives a mark no sane patch would carry', () => {
    // A corrupt or hand-edited patch must not put `undefined` in the header.
    for (const mark of [-1, -37, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
      const identity = identityFor(mark);
      expect(identity.name.length).toBeGreaterThan(0);
      expect(identity.tint).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('prefers the name the player gave over the one it was dealt', () => {
    expect(instanceLabel(0, 'Bass')).toBe('Bass');
    expect(instanceLabel(0, '  Lead  ')).toBe('Lead');
  });

  it('falls back to the dealt name when the player cleared theirs', () => {
    expect(instanceLabel(1, '')).toBe(identityFor(1).name);
    expect(instanceLabel(1, '   ')).toBe(identityFor(1).name);
  });
});
