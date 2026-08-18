/**
 * A minimal, dependency-free ZIP writer — store only (compression method 0).
 *
 * WHY STORE-ONLY: the payload is 16-bit PCM WAV. Deflate buys a few percent on
 * audio at best, and often nothing, so the only thing compression would add
 * here is a compressor to audit. Everything below is plain arithmetic against
 * the PKZIP APPNOTE layout, which means the output is inspectable with `unzip
 * -l`, `zipinfo`, and a hex editor.
 *
 * Determinism is a feature, not an accident: the timestamp is a parameter with
 * a fixed default, so the same kit exports byte-identical every time. That is
 * what makes the export testable and makes "did anything actually change?"
 * answerable by comparing bytes.
 */

export interface ZipEntry {
  /** Path inside the archive. Forward slashes only; must be non-empty. */
  name: string;
  data: Uint8Array;
}

/** MS-DOS timestamps cannot represent anything before 1980-01-01. */
export const ZIP_DOS_EPOCH_MS = Date.UTC(1980, 0, 1, 0, 0, 0);

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;

/** 2.0 — the minimum that understands the modern header layout. */
const VERSION_NEEDED = 20;
/** General-purpose bit 11: filename is UTF-8, not CP437. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;

const MAX_UINT32 = 0xffffffff;
const MAX_UINT16 = 0xffff;

let table: Uint32Array | null = null;

/** The standard IEEE 802.3 CRC-32 table (polynomial 0xEDB88320), built once. */
function crcTable(): Uint32Array {
  if (table) return table;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  table = t;
  return t;
}

/**
 * CRC-32 of a byte range, as an unsigned 32-bit number.
 * Known vector: crc32(ascii("123456789")) === 0xCBF43926.
 */
export function crc32(data: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = (t[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Pack a wall-clock instant into the two 16-bit MS-DOS fields.
 * UTC, deliberately: local-time conversion would make an export depend on the
 * exporter's timezone, and then "byte-identical" stops being true.
 */
function dosDateTime(timestampMs: number): { date: number; time: number } {
  const d = new Date(Math.max(timestampMs, ZIP_DOS_EPOCH_MS));
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  const date =
    ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const time =
    (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  return { date: date & MAX_UINT16, time: time & MAX_UINT16 };
}

const encoder = new TextEncoder();

interface PreparedEntry {
  nameBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
  flags: number;
  localOffset: number;
}

function prepare(entries: readonly ZipEntry[]): PreparedEntry[] {
  const seen = new Set<string>();
  const prepared: PreparedEntry[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = entry.name;
    if (name.length === 0) throw new Error('zip: entry name must not be empty');
    if (seen.has(name)) throw new Error(`zip: duplicate entry name "${name}"`);
    seen.add(name);

    const nameBytes = encoder.encode(name);
    if (nameBytes.length > MAX_UINT16) {
      throw new Error(`zip: entry name too long: "${name}"`);
    }
    if (entry.data.length > MAX_UINT32) {
      throw new Error(`zip: entry "${name}" exceeds the 4 GB ZIP32 limit`);
    }

    prepared.push({
      nameBytes,
      data: entry.data,
      crc: crc32(entry.data),
      // Only claim UTF-8 when the name actually needs it, so plain ASCII
      // archives stay byte-for-byte what an old tool expects.
      flags: nameBytes.length === name.length ? 0 : FLAG_UTF8,
      localOffset: offset,
    });
    offset += LOCAL_HEADER_SIZE + nameBytes.length + entry.data.length;
    if (offset > MAX_UINT32) throw new Error('zip: archive exceeds the 4 GB ZIP32 limit');
  }

  if (prepared.length > MAX_UINT16) {
    throw new Error('zip: more than 65535 entries requires ZIP64');
  }
  return prepared;
}

/**
 * Build a complete .zip: local file headers, payloads, central directory, and
 * end-of-central-directory record.
 *
 * `timestampMs` defaults to the DOS epoch so output is deterministic. Pass
 * `Date.now()` explicitly if a real modification time actually matters.
 */
export function createZip(
  entries: readonly ZipEntry[],
  timestampMs: number = ZIP_DOS_EPOCH_MS,
): Uint8Array {
  const prepared = prepare(entries);
  const { date, time } = dosDateTime(timestampMs);

  let localSize = 0;
  let centralSize = 0;
  for (const e of prepared) {
    localSize += LOCAL_HEADER_SIZE + e.nameBytes.length + e.data.length;
    centralSize += CENTRAL_HEADER_SIZE + e.nameBytes.length;
  }

  const out = new Uint8Array(localSize + centralSize + EOCD_SIZE);
  const view = new DataView(out.buffer);
  let p = 0;

  for (const e of prepared) {
    view.setUint32(p, LOCAL_HEADER_SIG, true);
    view.setUint16(p + 4, VERSION_NEEDED, true);
    view.setUint16(p + 6, e.flags, true);
    view.setUint16(p + 8, METHOD_STORE, true);
    view.setUint16(p + 10, time, true);
    view.setUint16(p + 12, date, true);
    view.setUint32(p + 14, e.crc, true);
    view.setUint32(p + 18, e.data.length, true); // compressed === stored
    view.setUint32(p + 22, e.data.length, true); // uncompressed
    view.setUint16(p + 26, e.nameBytes.length, true);
    view.setUint16(p + 28, 0, true); // no extra field
    p += LOCAL_HEADER_SIZE;
    out.set(e.nameBytes, p);
    p += e.nameBytes.length;
    out.set(e.data, p);
    p += e.data.length;
  }

  const centralStart = p;
  for (const e of prepared) {
    view.setUint32(p, CENTRAL_HEADER_SIG, true);
    view.setUint16(p + 4, VERSION_NEEDED, true); // version made by
    view.setUint16(p + 6, VERSION_NEEDED, true); // version needed
    view.setUint16(p + 8, e.flags, true);
    view.setUint16(p + 10, METHOD_STORE, true);
    view.setUint16(p + 12, time, true);
    view.setUint16(p + 14, date, true);
    view.setUint32(p + 16, e.crc, true);
    view.setUint32(p + 20, e.data.length, true);
    view.setUint32(p + 24, e.data.length, true);
    view.setUint16(p + 28, e.nameBytes.length, true);
    view.setUint16(p + 30, 0, true); // extra field length
    view.setUint16(p + 32, 0, true); // comment length
    view.setUint16(p + 34, 0, true); // disk number start
    view.setUint16(p + 36, 0, true); // internal attributes
    view.setUint32(p + 38, 0, true); // external attributes
    view.setUint32(p + 42, e.localOffset, true);
    p += CENTRAL_HEADER_SIZE;
    out.set(e.nameBytes, p);
    p += e.nameBytes.length;
  }

  view.setUint32(p, EOCD_SIG, true);
  view.setUint16(p + 4, 0, true); // this disk
  view.setUint16(p + 6, 0, true); // disk with central directory
  view.setUint16(p + 8, prepared.length, true);
  view.setUint16(p + 10, prepared.length, true);
  view.setUint32(p + 12, centralSize, true);
  view.setUint32(p + 16, centralStart, true);
  view.setUint16(p + 20, 0, true); // comment length

  return out;
}
