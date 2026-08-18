/**
 * The shortcut registry — one table, one source of truth.
 *
 * The key map, the help overlay and the command palette all read from here, so
 * a shortcut cannot exist in this app without also being discoverable. Nothing
 * scatters `if (e.key === 'r')` around components.
 *
 * ## The reservation rule
 *
 * `use-computer-keyboard.ts` owns the *unmodified* note keys — Z S X D C V G B
 * H N J M Q W E R T Y U I, digits 2 3 5 6 7, and `,` / `.` for its octave
 * shift — and it only bails out on ctrl/meta/alt, never on shift. So:
 *
 *   - A bare (or shift-only) binding may use ONLY a key the note map does not
 *     claim: A F K L O P, digits 1 4 8 9 0, space, brackets, slash.
 *   - Anything else takes `alt+` (playing keys stay sacred) or `mod+` (a
 *     file-level action, which is what mod means everywhere else on the
 *     machine).
 *
 * Combos the browser owns are avoided deliberately: no `alt+d`/`alt+e`/`alt+f`
 * (Windows menu + address bar), no `alt+left`/`alt+right` (Windows history),
 * no `mod+shift+i/j/c/k/e` (devtools). `mod+s`, `mod+z` and `mod+k` are taken
 * knowingly — an app with focus is expected to own those.
 */

export interface Shortcut {
  id: string;
  keys: string;
  label: string;
  group: string;
  /**
   * Gate on the app's current surface. `undefined` and `'always'` are the same
   * thing. A gated shortcut fires when `useShortcuts` is given no context at
   * all, or a context that matches — the handler map is the real gate, this is
   * the safety net.
   */
  when?: 'always' | 'playing' | 'hunting';
}

/** Display order for the help overlay and the palette. */
export const SHORTCUT_GROUPS = ['Transport', 'Sound', 'Hunt', 'Kit', 'View', 'Help'] as const;

export const SHORTCUTS: readonly Shortcut[] = [
  // ── Transport ────────────────────────────────────────────────────────────
  { id: 'transport.power', keys: 'space', label: 'Power / suspend audio', group: 'Transport' },
  {
    id: 'transport.panic', keys: 'mod+period', label: 'Panic — all notes off',
    group: 'Transport',
  },
  {
    id: 'transport.record', keys: 'alt+r', label: 'Record on / off',
    group: 'Transport', when: 'playing',
  },
  {
    id: 'transport.bounce', keys: 'alt+b', label: 'Bounce held chord to WAV',
    group: 'Transport', when: 'playing',
  },
  {
    id: 'transport.octaveDown', keys: 'bracketleft', label: 'Octave down',
    group: 'Transport', when: 'playing',
  },
  {
    id: 'transport.octaveUp', keys: 'bracketright', label: 'Octave up',
    group: 'Transport', when: 'playing',
  },

  // ── Sound ────────────────────────────────────────────────────────────────
  { id: 'sound.engine1', keys: 'alt+1', label: 'Engine 1 — Analog', group: 'Sound' },
  { id: 'sound.engine2', keys: 'alt+2', label: 'Engine 2 — FM', group: 'Sound' },
  { id: 'sound.engine3', keys: 'alt+3', label: 'Engine 3 — Physical', group: 'Sound' },
  { id: 'sound.engine4', keys: 'alt+4', label: 'Engine 4 — Granular', group: 'Sound' },
  { id: 'sound.presetNext', keys: 'p', label: 'Next preset', group: 'Sound' },
  { id: 'sound.presetPrev', keys: 'shift+p', label: 'Previous preset', group: 'Sound' },
  { id: 'sound.random', keys: 'alt+n', label: 'New random patch', group: 'Sound' },
  { id: 'sound.save', keys: 'mod+s', label: 'Save patch', group: 'Sound' },
  { id: 'sound.undo', keys: 'mod+z', label: 'Undo', group: 'Sound' },
  { id: 'sound.redo', keys: 'mod+shift+z', label: 'Redo', group: 'Sound' },

  // ── Hunt ─────────────────────────────────────────────────────────────────
  { id: 'hunt.toggle', keys: 'alt+h', label: 'Open / close Hunt', group: 'Hunt' },
  {
    id: 'hunt.reroll', keys: 'f', label: 'Re-roll six variations',
    group: 'Hunt', when: 'hunting',
  },
  {
    id: 'hunt.breed', keys: 'shift+f', label: 'Breed kept variations',
    group: 'Hunt', when: 'hunting',
  },
  { id: 'hunt.tapeBack', keys: 'alt+comma', label: 'Tape — step back', group: 'Hunt' },
  { id: 'hunt.tapeForward', keys: 'alt+period', label: 'Tape — step forward', group: 'Hunt' },

  // ── Kit ──────────────────────────────────────────────────────────────────
  { id: 'kit.assign', keys: 'k', label: 'Assign patch to next free pad', group: 'Kit' },
  { id: 'kit.export', keys: 'shift+k', label: 'Export kit as .zip', group: 'Kit' },

  // ── View ─────────────────────────────────────────────────────────────────
  { id: 'view.palette', keys: 'mod+k', label: 'Command palette', group: 'View' },
  { id: 'view.deep', keys: 'a', label: 'Deep view — every parameter', group: 'View' },
  { id: 'view.visuals', keys: 'o', label: 'Visuals — scope & spectrum', group: 'View' },
  { id: 'view.layout', keys: 'l', label: 'Play surface — keys / pads', group: 'View' },

  // ── Help ─────────────────────────────────────────────────────────────────
  { id: 'help.shortcuts', keys: 'shift+slash', label: 'Keyboard shortcuts', group: 'Help' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

/** Token -> `KeyboardEvent.code`. Physical position, so AZERTY/Dvorak agree. */
const NAMED_CODE: ReadonlyMap<string, string> = new Map([
  ['space', 'Space'], ['escape', 'Escape'], ['enter', 'Enter'], ['tab', 'Tab'],
  ['backspace', 'Backspace'], ['delete', 'Delete'],
  ['slash', 'Slash'], ['backslash', 'Backslash'], ['comma', 'Comma'], ['period', 'Period'],
  ['semicolon', 'Semicolon'], ['quote', 'Quote'], ['backquote', 'Backquote'],
  ['minus', 'Minus'], ['equal', 'Equal'],
  ['bracketleft', 'BracketLeft'], ['bracketright', 'BracketRight'],
  ['left', 'ArrowLeft'], ['right', 'ArrowRight'], ['up', 'ArrowUp'], ['down', 'ArrowDown'],
  ['home', 'Home'], ['end', 'End'],
]);

/** Token -> printed glyph. */
const KEY_GLYPH: ReadonlyMap<string, string> = new Map([
  ['space', 'Space'], ['escape', 'Esc'], ['enter', 'Enter'], ['tab', 'Tab'],
  ['backspace', 'Bksp'], ['delete', 'Del'],
  ['slash', '/'], ['backslash', '\\'], ['comma', ','], ['period', '.'],
  ['semicolon', ';'], ['quote', "'"], ['backquote', '`'],
  ['minus', '-'], ['equal', '='],
  ['bracketleft', '['], ['bracketright', ']'],
  ['left', '←'], ['right', '→'], ['up', '↑'], ['down', '↓'],
  ['home', 'Home'], ['end', 'End'],
]);

/** Token -> spoken name, for screen readers that would read glyphs as junk. */
const KEY_SPOKEN: ReadonlyMap<string, string> = new Map([
  ['slash', 'slash'], ['backslash', 'backslash'], ['comma', 'comma'], ['period', 'period'],
  ['semicolon', 'semicolon'], ['quote', 'quote'], ['backquote', 'backtick'],
  ['minus', 'minus'], ['equal', 'equals'],
  ['bracketleft', 'left bracket'], ['bracketright', 'right bracket'],
  ['left', 'Left arrow'], ['right', 'Right arrow'],
  ['up', 'Up arrow'], ['down', 'Down arrow'],
]);

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'mod'] as const;
type Modifier = typeof MODIFIER_ORDER[number];

export interface KeyCombo {
  /** `KeyboardEvent.code` this combo listens for. */
  code: string;
  /** Command on Mac, Control everywhere else. */
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** Literal Control. Only meaningful on Mac; elsewhere `mod` covers it. */
  ctrl: boolean;
}

function codeForToken(token: string): string | null {
  if (/^[a-z]$/.test(token)) return `Key${token.toUpperCase()}`;
  if (/^[0-9]$/.test(token)) return `Digit${token}`;
  return NAMED_CODE.get(token) ?? null;
}

/** `"mod+shift+z"` -> a comparable combo, or `null` if the string is malformed. */
export function parseKeys(keys: string): KeyCombo | null {
  const parts = keys.toLowerCase().split('+').filter((p) => p.length > 0);
  const key = parts.at(-1);
  if (key === undefined) return null;
  const code = codeForToken(key);
  if (code === null) return null;

  const combo: KeyCombo = { code, mod: false, shift: false, alt: false, ctrl: false };
  for (const part of parts.slice(0, -1)) {
    if (part === 'mod') combo.mod = true;
    else if (part === 'shift') combo.shift = true;
    else if (part === 'alt') combo.alt = true;
    else if (part === 'ctrl') combo.ctrl = true;
    else return null;
  }
  return combo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Display
// ─────────────────────────────────────────────────────────────────────────────

function modGlyph(mod: Modifier, isMac: boolean): string {
  if (isMac) {
    if (mod === 'mod') return '⌘';
    if (mod === 'shift') return '⇧';
    if (mod === 'alt') return '⌥';
    return '⌃';
  }
  if (mod === 'mod' || mod === 'ctrl') return 'Ctrl';
  if (mod === 'shift') return 'Shift';
  return 'Alt';
}

function modSpoken(mod: Modifier, isMac: boolean): string {
  if (mod === 'mod') return isMac ? 'Command' : 'Control';
  if (mod === 'ctrl') return 'Control';
  if (mod === 'shift') return 'Shift';
  return isMac ? 'Option' : 'Alt';
}

function splitCombo(keys: string): { mods: readonly Modifier[]; key: string } {
  const parts = keys.toLowerCase().split('+').filter((p) => p.length > 0);
  const key = parts.at(-1) ?? '';
  const held = new Set(parts.slice(0, -1));
  return { mods: MODIFIER_ORDER.filter((m) => held.has(m)), key };
}

/**
 * One string per key cap, e.g. `["⌘", "⇧", "Z"]`. `shift+slash` collapses to a
 * single `?` cap, because that is the key everyone actually calls it.
 */
export function formatKeyTokens(keys: string, isMac: boolean): readonly string[] {
  if (keys.toLowerCase() === 'shift+slash') return ['?'];
  const { mods, key } = splitCombo(keys);
  const caps = mods.map((m) => modGlyph(m, isMac));
  caps.push(KEY_GLYPH.get(key) ?? key.toUpperCase());
  return caps;
}

/** `"mod+k"` -> `"⌘K"` on Mac, `"Ctrl+K"` elsewhere. */
export function formatKeys(keys: string, isMac: boolean): string {
  return formatKeyTokens(keys, isMac).join(isMac ? '' : '+');
}

/** Spoken form for assistive tech: `"Command plus K"`. Never glyphs. */
export function describeKeys(keys: string, isMac: boolean): string {
  if (keys.toLowerCase() === 'shift+slash') return 'Question mark';
  const { mods, key } = splitCombo(keys);
  const words = mods.map((m) => modSpoken(m, isMac));
  words.push(KEY_SPOKEN.get(key) ?? (KEY_GLYPH.get(key) ?? key.toUpperCase()));
  return words.join(' plus ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookups
// ─────────────────────────────────────────────────────────────────────────────

export function shortcutById(id: string): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

/** Keys for a shortcut id, or `undefined`. Handy when building palette rows. */
export function keysFor(id: string): string | undefined {
  return shortcutById(id)?.keys;
}

export interface ShortcutSection {
  group: string;
  items: readonly Shortcut[];
}

/** Grouped in {@link SHORTCUT_GROUPS} order; unknown groups fall in after. */
export function groupedShortcuts(
  shortcuts: readonly Shortcut[] = SHORTCUTS,
): readonly ShortcutSection[] {
  const order: string[] = [...SHORTCUT_GROUPS];
  for (const s of shortcuts) if (!order.includes(s.group)) order.push(s.group);
  const sections: ShortcutSection[] = [];
  for (const group of order) {
    const items = shortcuts.filter((s) => s.group === group);
    if (items.length > 0) sections.push({ group, items });
  }
  return sections;
}

/** True on Mac, iPad and iPhone — the three surfaces this app targets. */
export function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav: Navigator & { userAgentData?: { platform?: string } } = navigator;
  const platform = nav.userAgentData?.platform ?? nav.platform;
  return /mac|iphone|ipad|ipod/i.test(`${platform} ${nav.userAgent}`);
}
