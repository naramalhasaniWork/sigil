import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KIT_SIZE,
  KO2_MEMORY_BYTES,
  clearSlot,
  createKit,
  kitBytes,
  kitToZip,
  sanitiseSampleName,
  setSlot,
  type Kit,
} from '@/audio/kit';

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i] as number);
  return s;
}

/** Entry names, read out of the central directory in stored order. */
function zipNames(zip: Uint8Array): string[] {
  const view = viewOf(zip);
  const eocd = zip.length - 22;
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = view.getUint16(p + 28, true);
    names.push(readAscii(zip, p + 46, nameLen));
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return names;
}

function zipSizes(zip: Uint8Array): number[] {
  const view = viewOf(zip);
  const eocd = zip.length - 22;
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    sizes.push(view.getUint32(p + 24, true));
    p += 46 + view.getUint16(p + 28, true) + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return sizes;
}

function fakeWav(bytes: number, fill = 7): Uint8Array {
  return new Uint8Array(bytes).fill(fill);
}

describe('createKit', () => {
  it('defaults to 16 empty, index-ordered slots', () => {
    const kit = createKit('Test Kit');
    expect(kit.slots).toHaveLength(DEFAULT_KIT_SIZE);
    expect(kit.slots.map((s) => s.index)).toEqual([...Array(16).keys()]);
    for (const slot of kit.slots) {
      expect(slot.wav).toBeNull();
      expect(slot.durationMs).toBe(0);
    }
  });

  it('honours an explicit size and sanitises the kit name', () => {
    expect(createKit('x', 4).slots).toHaveLength(4);
    expect(createKit('  Deep / Space  ').name).toBe('Deep Space');
    expect(createKit('').name).toBe('Kit');
  });
});

describe('setSlot / clearSlot purity', () => {
  it('setSlot does not mutate the input kit', () => {
    const kit = createKit('Pure');
    const snapshot = JSON.stringify(kit.slots.map((s) => [s.index, s.name, s.durationMs]));
    const next = setSlot(kit, 3, 'Glass Stab', fakeWav(64), 420);

    expect(next).not.toBe(kit);
    expect(next.slots).not.toBe(kit.slots);
    expect(JSON.stringify(kit.slots.map((s) => [s.index, s.name, s.durationMs]))).toBe(snapshot);
    expect((kit.slots[3] as { wav: Uint8Array | null }).wav).toBeNull();
    expect((next.slots[3] as { name: string }).name).toBe('Glass Stab');
    expect((next.slots[3] as { durationMs: number }).durationMs).toBe(420);
  });

  it('clearSlot does not mutate the input kit', () => {
    const filled = setSlot(createKit('Pure'), 0, 'Sub Thud', fakeWav(32), 900);
    const cleared = clearSlot(filled, 0);

    expect(cleared).not.toBe(filled);
    expect((filled.slots[0] as { wav: Uint8Array | null }).wav).not.toBeNull();
    expect((cleared.slots[0] as { wav: Uint8Array | null }).wav).toBeNull();
    expect((cleared.slots[0] as { name: string }).name).toBe('');
    expect((cleared.slots[0] as { durationMs: number }).durationMs).toBe(0);
  });

  it('leaves untouched slots referentially identical', () => {
    const kit = createKit('Pure');
    const next = setSlot(kit, 5, 'A', fakeWav(8), 10);
    expect(next.slots[0]).toBe(kit.slots[0]);
    expect(next.slots[5]).not.toBe(kit.slots[5]);
  });

  it('rejects out-of-range slot indices', () => {
    const kit = createKit('Pure', 4);
    expect(() => setSlot(kit, 4, 'x', fakeWav(4), 1)).toThrow(RangeError);
    expect(() => setSlot(kit, -1, 'x', fakeWav(4), 1)).toThrow(RangeError);
    expect(() => clearSlot(kit, 9)).toThrow(RangeError);
  });
});

describe('sanitiseSampleName', () => {
  it('strips path separators and filesystem-illegal characters', () => {
    expect(sanitiseSampleName('Kick/Snare')).toBe('Kick Snare');
    expect(sanitiseSampleName('C:\\Bass')).toBe('C Bass');
    expect(sanitiseSampleName('Hat*?"<>|Stab')).toBe('Hat Stab');
    expect(sanitiseSampleName('Take: One')).toBe('Take One');
  });

  it('drops emoji and other non-ASCII but keeps the readable remainder', () => {
    expect(sanitiseSampleName('Fire 🔥 Lead')).toBe('Fire Lead');
    expect(sanitiseSampleName('🔥🔥🎹')).toBe('Sample');
    expect(sanitiseSampleName('Café Stab')).toBe('Cafe Stab');
    expect(sanitiseSampleName('ノイズ')).toBe('Sample');
  });

  it('collapses whitespace and trims the ends', () => {
    expect(sanitiseSampleName('  Deep    Sub  ')).toBe('Deep Sub');
    expect(sanitiseSampleName('\tTape\nWobble\r')).toBe('Tape Wobble');
  });

  it('strips control characters', () => {
    expect(sanitiseSampleName('Bell\u0000\u0007Tone')).toBe('Bell Tone');
  });

  it('strips leading and trailing dots', () => {
    expect(sanitiseSampleName('.hidden')).toBe('hidden');
    expect(sanitiseSampleName('Stab...')).toBe('Stab');
    expect(sanitiseSampleName('...')).toBe('Sample');
  });

  it('truncates very long names at a word boundary, keeping them readable', () => {
    const long = 'Enormously Long Cavernous Metallic Impact Number Nine';
    const out = sanitiseSampleName(long);
    expect(out).toBe('Enormously Long');
    expect(out.length).toBeLessThanOrEqual(24);
    expect(out).not.toMatch(/\s$/);
    expect(long.startsWith(out)).toBe(true);
  });

  it('hard-cuts when there is no usable word boundary', () => {
    const word = 'Supercalifragilisticexpialidocious';
    expect(sanitiseSampleName(word)).toBe(word.slice(0, 24));
    // A boundary that early would leave too little of the name to recognise.
    expect(sanitiseSampleName('Sub aaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(
      'Sub aaaaaaaaaaaaaaaaaaaa',
    );
  });

  it('caps every long name at the display length', () => {
    for (const input of [
      'Enormously Long Cavernous Metallic Impact',
      'Supercalifragilisticexpialidocious',
      'a'.repeat(200),
      'word '.repeat(40),
    ]) {
      const out = sanitiseSampleName(input);
      expect(out.length).toBeLessThanOrEqual(24);
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it('never returns an empty name', () => {
    for (const input of ['', '   ', '///', '\u0000', '...', '🔥']) {
      expect(sanitiseSampleName(input)).not.toBe('');
      expect(sanitiseSampleName(input).length).toBeGreaterThan(0);
    }
    expect(sanitiseSampleName('')).toBe('Sample');
  });

  it('defuses Windows reserved device names', () => {
    expect(sanitiseSampleName('CON')).toBe('CON 1');
    expect(sanitiseSampleName('nul')).toBe('nul 1');
    expect(sanitiseSampleName('Console')).toBe('Console');
  });
});

describe('kitBytes', () => {
  it('sums only populated slots', () => {
    let kit = createKit('Weight');
    expect(kitBytes(kit)).toBe(0);
    kit = setSlot(kit, 0, 'A', fakeWav(1000), 100);
    kit = setSlot(kit, 7, 'B', fakeWav(2500), 100);
    expect(kitBytes(kit)).toBe(3500);
    expect(kitBytes(clearSlot(kit, 0))).toBe(2500);
  });

  it('gives the UI something to compare against the device limit', () => {
    const kit = setSlot(createKit('Big'), 0, 'A', fakeWav(1024), 100);
    expect(kitBytes(kit)).toBeLessThan(KO2_MEMORY_BYTES);
    expect(KO2_MEMORY_BYTES).toBe(134217728);
  });
});

describe('kitToZip', () => {
  it('orders entries by slot index regardless of the order they were set', () => {
    let kit = createKit('Order');
    kit = setSlot(kit, 15, 'Sub Thud', fakeWav(40), 200);
    kit = setSlot(kit, 0, 'Glass Stab', fakeWav(10), 200);
    kit = setSlot(kit, 9, 'Mid Tom', fakeWav(20), 200);
    kit = setSlot(kit, 3, 'Rim', fakeWav(30), 200);

    expect(zipNames(kitToZip(kit))).toEqual([
      '01 Glass Stab.wav',
      '04 Rim.wav',
      '10 Mid Tom.wav',
      '16 Sub Thud.wav',
    ]);
  });

  it('sorts by slot index even when the slots array itself is out of order', () => {
    // A Kit assembled by hand (or restored from storage) can arrive with its
    // slots in any order; the zip must still be pad-ordered.
    const shuffled: Kit = {
      name: 'Shuffled',
      slots: [
        { index: 9, name: 'Mid Tom', wav: fakeWav(20), durationMs: 200 },
        { index: 0, name: 'Glass Stab', wav: fakeWav(10), durationMs: 200 },
        { index: 15, name: 'Sub Thud', wav: fakeWav(40), durationMs: 200 },
        { index: 3, name: 'Rim', wav: fakeWav(30), durationMs: 200 },
      ],
    };
    expect(zipNames(kitToZip(shuffled))).toEqual([
      '01 Glass Stab.wav',
      '04 Rim.wav',
      '10 Mid Tom.wav',
      '16 Sub Thud.wav',
    ]);
  });

  it('produces identical bytes whatever order the slots were filled in', () => {
    let a = createKit('Order');
    a = setSlot(a, 2, 'Two', fakeWav(12, 2), 100);
    a = setSlot(a, 0, 'Zero', fakeWav(8, 0), 100);

    let b = createKit('Order');
    b = setSlot(b, 0, 'Zero', fakeWav(8, 0), 100);
    b = setSlot(b, 2, 'Two', fakeWav(12, 2), 100);

    expect(Array.from(kitToZip(a))).toEqual(Array.from(kitToZip(b)));
  });

  it('omits empty slots entirely and never emits a zero-byte WAV', () => {
    let kit = createKit('Sparse');
    kit = setSlot(kit, 0, 'Only One', fakeWav(16), 100);
    kit = setSlot(kit, 5, 'Cleared Later', fakeWav(16), 100);
    kit = setSlot(kit, 6, 'Zero Length', new Uint8Array(0), 100);
    kit = clearSlot(kit, 5);

    const zip = kitToZip(kit);
    expect(zipNames(zip)).toEqual(['01 Only One.wav']);
    for (const size of zipSizes(zip)) expect(size).toBeGreaterThan(0);
  });

  it('emits an empty archive for an empty kit', () => {
    expect(zipNames(kitToZip(createKit('Nothing')))).toEqual([]);
  });

  it('carries each slot payload through at its exact size', () => {
    let kit = createKit('Payload');
    kit = setSlot(kit, 0, 'A', fakeWav(11), 100);
    kit = setSlot(kit, 1, 'B', fakeWav(37), 100);
    expect(zipSizes(kitToZip(kit))).toEqual([11, 37]);
  });

  it('widens padding for high pad numbers even in a sparsely built kit', () => {
    // Two slots, but pad 120: width must follow the highest number present,
    // not the number of populated slots.
    const sparse: Kit = {
      name: 'Sparse',
      slots: [
        { index: 119, name: 'High', wav: fakeWav(4), durationMs: 10 },
        { index: 1, name: 'Low', wav: fakeWav(4), durationMs: 10 },
      ],
    };
    const names = zipNames(kitToZip(sparse));
    expect(names).toEqual(['002 Low.wav', '120 High.wav']);
    expect([...names].sort()).toEqual(names);
  });

  it('zero-pads slot numbers so they sort correctly in a file browser', () => {
    let kit: Kit = createKit('Wide', 128);
    kit = setSlot(kit, 0, 'First', fakeWav(4), 10);
    kit = setSlot(kit, 99, 'Hundredth', fakeWav(4), 10);
    const names = zipNames(kitToZip(kit));
    expect(names).toEqual(['001 First.wav', '100 Hundredth.wav']);
    expect([...names].sort()).toEqual(names);
  });

  it('sanitises names on the way into the archive', () => {
    const kit = setSlot(createKit('Dirty'), 0, ' Glass/Stab 🔥 ', fakeWav(4), 10);
    expect(zipNames(kitToZip(kit))).toEqual(['01 Glass Stab.wav']);
  });
});
