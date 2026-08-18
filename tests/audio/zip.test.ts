import { describe, it, expect } from 'vitest';
import { ZIP_DOS_EPOCH_MS, createZip, crc32, type ZipEntry } from '@/audio/zip';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i] as number);
  return s;
}

function eocdOffset(zip: Uint8Array): number {
  return zip.length - 22;
}

/** Walk the central directory, returning one record per entry. */
function centralRecords(zip: Uint8Array): {
  name: string;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localOffset: number;
}[] {
  const view = viewOf(zip);
  const eocd = eocdOffset(zip);
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(p, true)).toBe(CENTRAL_SIG);
    const nameLen = view.getUint16(p + 28, true);
    out.push({
      method: view.getUint16(p + 10, true),
      crc: view.getUint32(p + 16, true),
      compressedSize: view.getUint32(p + 20, true),
      uncompressedSize: view.getUint32(p + 24, true),
      localOffset: view.getUint32(p + 42, true),
      name: readAscii(zip, p + 46, nameLen),
    });
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return out;
}

const entries: ZipEntry[] = [
  { name: '01 Alpha.wav', data: ascii('123456789') },
  { name: '02 Beta.wav', data: new Uint8Array([0, 1, 2, 3, 255, 128]) },
  { name: '03 Gamma.wav', data: new Uint8Array(0) },
];

describe('crc32', () => {
  it('matches the standard check vector for "123456789"', () => {
    expect(crc32(ascii('123456789'))).toBe(0xcbf43926);
  });

  it('matches known vectors for empty and single-byte input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(ascii('a'))).toBe(0xe8b7be43);
    expect(crc32(ascii('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  it('is unsigned', () => {
    // 0xE8B7BE43 has the top bit set: a signed implementation returns negative.
    expect(crc32(ascii('a'))).toBeGreaterThan(0);
  });
});

describe('createZip — structure', () => {
  const zip = createZip(entries);

  it('starts with a local file header signature', () => {
    expect(viewOf(zip).getUint32(0, true)).toBe(LOCAL_SIG);
  });

  it('ends with an end-of-central-directory record', () => {
    expect(viewOf(zip).getUint32(eocdOffset(zip), true)).toBe(EOCD_SIG);
  });

  it('places a local header at every offset the central directory points to', () => {
    const view = viewOf(zip);
    for (const rec of centralRecords(zip)) {
      expect(view.getUint32(rec.localOffset, true)).toBe(LOCAL_SIG);
      const nameLen = view.getUint16(rec.localOffset + 26, true);
      expect(readAscii(zip, rec.localOffset + 30, nameLen)).toBe(rec.name);
    }
  });

  it('reports the entry count in both EOCD fields', () => {
    const view = viewOf(zip);
    const eocd = eocdOffset(zip);
    expect(view.getUint16(eocd + 8, true)).toBe(entries.length);
    expect(view.getUint16(eocd + 10, true)).toBe(entries.length);
  });

  it('sizes and locates the central directory correctly', () => {
    const view = viewOf(zip);
    const eocd = eocdOffset(zip);
    const size = view.getUint32(eocd + 12, true);
    const start = view.getUint32(eocd + 16, true);
    expect(start + size).toBe(eocd);
    expect(view.getUint32(start, true)).toBe(CENTRAL_SIG);
  });

  it('round-trips every entry name in order', () => {
    expect(centralRecords(zip).map((r) => r.name)).toEqual(entries.map((e) => e.name));
  });
});

describe('createZip — per-entry fields', () => {
  const zip = createZip(entries);
  const records = centralRecords(zip);
  const view = viewOf(zip);

  it('stores rather than compresses', () => {
    for (const rec of records) expect(rec.method).toBe(0);
  });

  it('reports compressed size equal to uncompressed size equal to input size', () => {
    records.forEach((rec, i) => {
      const input = entries[i] as ZipEntry;
      expect(rec.uncompressedSize).toBe(input.data.length);
      expect(rec.compressedSize).toBe(input.data.length);
    });
  });

  it('mirrors method, CRC and both sizes in the local header, not just the central one', () => {
    records.forEach((rec, i) => {
      const input = entries[i] as ZipEntry;
      const at = rec.localOffset;
      expect(view.getUint32(at, true)).toBe(LOCAL_SIG);
      expect(view.getUint16(at + 8, true)).toBe(0); // stored
      expect(view.getUint32(at + 14, true)).toBe(crc32(input.data));
      expect(view.getUint32(at + 18, true)).toBe(input.data.length); // compressed
      expect(view.getUint32(at + 22, true)).toBe(input.data.length); // uncompressed
      expect(view.getUint16(at + 26, true)).toBe(input.name.length); // name length
      expect(view.getUint16(at + 28, true)).toBe(0); // no extra field
      // Streaming readers trust the local header alone; it must not disagree.
      expect(view.getUint32(at + 18, true)).toBe(rec.compressedSize);
      expect(view.getUint32(at + 22, true)).toBe(rec.uncompressedSize);
    });
  });

  it('writes the real CRC-32 of the payload into both headers', () => {
    records.forEach((rec, i) => {
      const input = entries[i] as ZipEntry;
      expect(rec.crc).toBe(crc32(input.data));
      expect(view.getUint32(rec.localOffset + 14, true)).toBe(rec.crc);
    });
    // The first entry is literally the check vector, asserted end to end.
    expect((records[0] as { crc: number }).crc).toBe(0xcbf43926);
  });

  it('stores the payload bytes verbatim after the local header', () => {
    records.forEach((rec, i) => {
      const input = entries[i] as ZipEntry;
      const nameLen = view.getUint16(rec.localOffset + 26, true);
      const start = rec.localOffset + 30 + nameLen;
      expect(Array.from(zip.slice(start, start + input.data.length))).toEqual(
        Array.from(input.data),
      );
    });
  });

  it('writes the exact archive length implied by the headers', () => {
    let expected = 22;
    for (const e of entries) {
      expected += 30 + e.name.length + e.data.length; // local header + name + data
      expected += 46 + e.name.length; // central header + name
    }
    expect(zip.length).toBe(expected);
  });
});

describe('createZip — determinism', () => {
  it('is byte-identical across two calls with the same fixed timestamp', () => {
    const a = createZip(entries, ZIP_DOS_EPOCH_MS);
    const b = createZip(entries, ZIP_DOS_EPOCH_MS);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('defaults to the fixed epoch, so no-argument calls also match', () => {
    expect(Array.from(createZip(entries))).toEqual(
      Array.from(createZip(entries, ZIP_DOS_EPOCH_MS)),
    );
  });

  it('actually varies when the timestamp varies (the test above can fail)', () => {
    const later = Date.UTC(2026, 7, 17, 12, 34, 56);
    expect(Array.from(createZip(entries, later))).not.toEqual(
      Array.from(createZip(entries, ZIP_DOS_EPOCH_MS)),
    );
  });

  it('packs the DOS date and time fields correctly', () => {
    const zip = createZip(entries, Date.UTC(2026, 7, 17, 12, 34, 56));
    const view = viewOf(zip);
    const time = view.getUint16(10, true);
    const date = view.getUint16(12, true);
    expect(date).toBe(((2026 - 1980) << 9) | (8 << 5) | 17);
    expect(time).toBe((12 << 11) | (34 << 5) | 28);
  });
});

describe('createZip — edge cases', () => {
  it('produces a bare EOCD for no entries', () => {
    const zip = createZip([]);
    expect(zip.length).toBe(22);
    expect(viewOf(zip).getUint32(0, true)).toBe(EOCD_SIG);
    expect(viewOf(zip).getUint16(8, true)).toBe(0);
  });

  it('flags UTF-8 names and leaves ASCII names unflagged', () => {
    const zip = createZip([
      { name: 'plain.wav', data: ascii('a') },
      { name: 'naïve.wav', data: ascii('b') },
    ]);
    const view = viewOf(zip);
    expect(view.getUint16(6, true) & 0x0800).toBe(0);
    const records = centralRecords(zip);
    const second = records[1] as { localOffset: number };
    expect(view.getUint16(second.localOffset + 6, true) & 0x0800).toBe(0x0800);
  });

  it('rejects duplicate and empty entry names', () => {
    expect(() =>
      createZip([
        { name: 'a.wav', data: ascii('x') },
        { name: 'a.wav', data: ascii('y') },
      ]),
    ).toThrow(/duplicate/);
    expect(() => createZip([{ name: '', data: ascii('x') }])).toThrow(/empty/);
  });
});
