import { createZip, type ZipEntry } from './zip';

/**
 * The kit model: 16 pads of rendered samples, and the export that turns them
 * into a zip you drag into TE's EP Sample Tool.
 *
 * Everything here is pure and synchronous. A Kit holds finished WAV bytes
 * produced by `bouncePatch`; this module never encodes audio, it only names,
 * orders, and packages it.
 */

/** The KO II's sample memory. The UI warns against this, it is not enforced here. */
export const KO2_MEMORY_BYTES = 128 * 1024 * 1024;

/** The device addresses 999 sample slots; a kit is one 16-pad page of them. */
export const KO2_MAX_SLOTS = 999;

/** Default pads per kit — the KO II's 4x4 page. */
export const DEFAULT_KIT_SIZE = 16;

/**
 * The KO II's screen is small and its browser truncates. 24 characters is
 * about what stays readable there, and it keeps exported filenames short
 * enough to scan in a file dialog.
 */
const MAX_SAMPLE_NAME = 24;

/**
 * A truncation shorter than this is more confusing than a mid-word cut, so
 * below it we take the hard cut instead of backing up to a word boundary.
 */
const MIN_TRUNCATED_NAME = 14;

const NAME_FALLBACK = 'Sample';

/** Windows refuses these as bare filenames regardless of extension. */
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export interface KitSlot {
  index: number;
  name: string;
  wav: Uint8Array | null;
  durationMs: number;
}

export interface Kit {
  name: string;
  slots: KitSlot[];
}

/**
 * Reduce a human-typed name to something that survives every filesystem
 * between here and the device, and still reads as the name the owner typed.
 *
 * Diacritics fold to their base letter rather than being deleted, so "Café
 * Stab" becomes "Cafe Stab" and not "Caf Stab". Anything else outside
 * printable ASCII — emoji, CJK, control characters — becomes a space and then
 * collapses, because the KO II's screen font cannot draw it anyway.
 */
export function sanitiseSampleName(raw: string, fallback: string = NAME_FALLBACK): string {
  if (typeof raw !== 'string') return fallback;

  let s = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Non-printable / non-ASCII → space (surrogate halves each become a space,
  // which the whitespace collapse below cleans up).
  s = s.replace(/[^\x20-\x7E]/g, ' ');
  // Path separators and the Windows-illegal set.
  s = s.replace(/[/\\:*?"<>|]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // Leading dots hide files on unix; trailing dots are illegal on Windows.
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');

  if (s.length > MAX_SAMPLE_NAME) {
    // Back up to a word boundary where one is close enough: "Enormously Long"
    // is legible on the device's screen, "Enormously Long Cavernou" is not.
    const cut = s.slice(0, MAX_SAMPLE_NAME + 1);
    const lastSpace = cut.lastIndexOf(' ');
    s = lastSpace >= MIN_TRUNCATED_NAME ? cut.slice(0, lastSpace) : cut.slice(0, MAX_SAMPLE_NAME);
    s = s.replace(/[.\s]+$/, '');
  }
  if (s.length === 0) return fallback;
  if (RESERVED_NAMES.has(s.toUpperCase())) return `${s} 1`;
  return s;
}

function emptySlot(index: number): KitSlot {
  return { index, name: '', wav: null, durationMs: 0 };
}

export function createKit(name: string, size: number = DEFAULT_KIT_SIZE): Kit {
  const count = Math.max(1, Math.min(Math.floor(size), KO2_MAX_SLOTS));
  const slots: KitSlot[] = [];
  for (let i = 0; i < count; i++) slots.push(emptySlot(i));
  return { name: sanitiseSampleName(name, 'Kit'), slots };
}

function assertIndex(kit: Kit, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= kit.slots.length) {
    throw new RangeError(
      `kit: slot ${index} is outside 0..${kit.slots.length - 1}`,
    );
  }
}

/**
 * Returns a new Kit with one pad filled. The WAV bytes are referenced, not
 * copied — a full kit is tens of megabytes and copying it on every pad edit
 * would be the slowest thing in the app. Callers must not mutate bytes they
 * have handed over.
 */
export function setSlot(
  kit: Kit,
  index: number,
  name: string,
  wav: Uint8Array,
  durationMs: number,
): Kit {
  assertIndex(kit, index);
  const slots = kit.slots.slice();
  slots[index] = {
    index,
    name: sanitiseSampleName(name),
    wav,
    durationMs: Math.max(0, durationMs),
  };
  return { name: kit.name, slots };
}

export function clearSlot(kit: Kit, index: number): Kit {
  assertIndex(kit, index);
  const slots = kit.slots.slice();
  slots[index] = emptySlot(index);
  return { name: kit.name, slots };
}

/** Total WAV payload in bytes. Compare against KO2_MEMORY_BYTES before export. */
export function kitBytes(kit: Kit): number {
  let total = 0;
  for (const slot of kit.slots) {
    if (slot.wav) total += slot.wav.length;
  }
  return total;
}

/**
 * Zero-padded so the pads land in order in every file browser and in the EP
 * Sample Tool's import list, minimum two digits — a 16-pad kit reads "01".."16"
 * and never "1".."16", which sorts as 1, 10, 11, 12.
 *
 * Width comes from the highest pad number actually present as well as the kit
 * size, so a hand-assembled sparse kit still pads consistently.
 */
function numberWidth(kit: Kit): number {
  let highest = kit.slots.length;
  for (const slot of kit.slots) {
    if (slot.index + 1 > highest) highest = slot.index + 1;
  }
  return Math.max(2, String(highest).length);
}

function slotFilename(slot: KitSlot, width: number): string {
  const number = String(slot.index + 1).padStart(width, '0');
  const name = sanitiseSampleName(slot.name);
  return `${number} ${name}.wav`;
}

/**
 * Package the populated pads as a flat, deterministic zip.
 *
 * Flat and unfoldered on purpose: the EP Sample Tool imports a list of files,
 * and pad order is decided by the leading number, not by directory structure.
 * Empty pads are omitted entirely — a zero-byte or silent WAV would occupy a
 * sample slot on a device that only has 999 of them.
 */
export function kitToZip(kit: Kit): Uint8Array {
  const width = numberWidth(kit);
  const populated = kit.slots
    .filter((slot): slot is KitSlot & { wav: Uint8Array } =>
      slot.wav !== null && slot.wav.length > 0,
    )
    // Slot index, never insertion order: the pad number is the whole contract
    // with the device.
    .sort((a, b) => a.index - b.index);

  const entries: ZipEntry[] = populated.map((slot) => ({
    name: slotFilename(slot, width),
    data: slot.wav,
  }));
  return createZip(entries);
}
