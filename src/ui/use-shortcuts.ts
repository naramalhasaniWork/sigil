'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { SHORTCUTS, detectMac, parseKeys, type KeyCombo, type Shortcut } from './shortcuts';

/**
 * Global keyboard handling for SIGIL.
 *
 * Three rules this file exists to enforce:
 *   1. A shortcut never fires while the owner is typing — patch names, tuning
 *      cents, exact parameter entry. A stray key must never reach the machine.
 *   2. A shortcut never fires while a modal or a menu has focus. Those
 *      surfaces own the keyboard while they are open.
 *   3. `preventDefault` happens only for a combo we actually handled. Browser
 *      shortcuts we do not own stay the browser's.
 */

interface Binding {
  shortcut: Shortcut;
  combo: KeyCombo;
}

/** Built once: SHORTCUTS is static, so this never needs rebuilding per mount. */
const BINDINGS_BY_CODE: ReadonlyMap<string, readonly Binding[]> = (() => {
  const map = new Map<string, Binding[]>();
  for (const shortcut of SHORTCUTS) {
    const combo = parseKeys(shortcut.keys);
    if (combo === null) continue;
    const list = map.get(combo.code);
    if (list === undefined) map.set(combo.code, [{ shortcut, combo }]);
    else list.push({ shortcut, combo });
  }
  return map;
})();

/**
 * Controls that consume Space or Enter themselves. If one of these has focus,
 * Space belongs to it — pressing Space on the Power button must not also fire
 * the Power shortcut and toggle the context straight back off.
 */
const SELF_ACTIVATING = [
  'button', 'a[href]', 'select', 'summary', 'details',
  '[role="button"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]', '[role="option"]', '[role="tab"]',
  '[role="switch"]', '[role="checkbox"]', '[role="radio"]', '[role="slider"]',
].join(',');

/** Surfaces that trap the keyboard while open. */
const KEYBOARD_OWNERS = '[aria-modal="true"],[role="dialog"],[role="menu"],[role="menubar"]';

function isTypingTarget(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function ownedByOverlay(node: EventTarget | null): boolean {
  if (!(node instanceof Element)) return false;
  return node.closest(KEYBOARD_OWNERS) !== null;
}

/**
 * A trapped modal may hold focus on `document.body` for a frame after opening.
 * Checking the document as well as the event target closes that window.
 */
function modalIsOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

function focusIsSelfActivating(): boolean {
  const active = document.activeElement;
  return active instanceof Element && active.matches(SELF_ACTIVATING);
}

export interface ShortcutOptions {
  /** Default `true`. Set false to stand the whole map down. */
  enabled?: boolean;
  /**
   * The surface currently on screen, matched against `Shortcut.when`. Omit and
   * no context filtering happens at all — the handler map is the real gate.
   */
  context?: string;
}

/**
 * Binds every registered shortcut whose id appears in `handlers`. Ids with no
 * handler are inert, which is how a surface scopes itself: pass the Hunt
 * handlers only while Hunt is open.
 */
export function useShortcuts(
  handlers: Readonly<Record<string, () => void>>,
  opts?: ShortcutOptions,
): void {
  // Latest handlers/options without re-binding the listener every render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const isMac = detectMac();

    const onKeyDown = (e: KeyboardEvent): void => {
      const options = optsRef.current;
      if (options?.enabled === false) return;
      // One-shot actions only: holding a key must not re-fire it.
      if (e.repeat) return;
      if (e.isComposing) return;
      if (e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      if (ownedByOverlay(e.target)) return;
      if (modalIsOpen()) return;

      const candidates = BINDINGS_BY_CODE.get(e.code);
      if (candidates === undefined) return;

      // On Mac, Command is `mod` and Control is its own thing. Everywhere else
      // Control is `mod`, and a literal `ctrl+` binding would be the same key.
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const ctrl = isMac ? e.ctrlKey : false;

      for (const { shortcut, combo } of candidates) {
        if (combo.mod !== mod || combo.ctrl !== ctrl) continue;
        if (combo.shift !== e.shiftKey || combo.alt !== e.altKey) continue;

        const context = options?.context;
        const when = shortcut.when;
        if (when !== undefined && when !== 'always' && context !== undefined && when !== context) {
          continue;
        }

        const run = handlersRef.current[shortcut.id];
        if (run === undefined) continue;

        // Space/Enter belong to whatever control has focus.
        if ((e.code === 'Space' || e.code === 'Enter') && focusIsSelfActivating()) return;

        e.preventDefault();
        run();
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}

/**
 * Mac vs PC key glyphs. Resolved after mount so the server and the first
 * client render agree — the labels correct themselves a frame later rather
 * than throwing a hydration mismatch.
 */
export function useIsMac(): boolean {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(detectMac());
  }, []);
  return isMac;
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusablesIn(node: HTMLElement | null): readonly HTMLElement[] {
  if (node === null) return [];
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => el.getClientRects().length > 0);
}

/**
 * The dialog contract, shared by the command palette and the shortcut help so
 * they cannot drift apart: focus moves in on open, is trapped while open,
 * Escape closes, and focus returns to whatever had it before.
 *
 * The container needs `tabIndex={-1}` so it can hold focus when it has no
 * focusable children of its own.
 */
export function useDialogFocus(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const first = focusablesIn(node)[0];
    (first ?? node)?.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || node === null) return;

      const list = focusablesIn(node);
      const head = list[0];
      const tail = list[list.length - 1];
      if (head === undefined || tail === undefined) {
        e.preventDefault();
        node.focus();
        return;
      }
      const active = document.activeElement;
      const inside = active instanceof Node && node.contains(active);
      if (e.shiftKey && (!inside || active === head)) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && (!inside || active === tail)) {
        e.preventDefault();
        head.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return (): void => {
      document.removeEventListener('keydown', onKeyDown, true);
      previous?.focus();
    };
  }, [open, ref]);
}
