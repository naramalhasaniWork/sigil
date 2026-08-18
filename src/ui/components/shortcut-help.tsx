'use client';

import { useRef, type JSX } from 'react';
import {
  SHORTCUTS, describeKeys, formatKeyTokens, groupedShortcuts, type Shortcut,
} from '@/ui/shortcuts';
import { useDialogFocus, useIsMac } from '@/ui/use-shortcuts';

/**
 * A shortcut printed as hard-bordered key caps. The caps are decorative to
 * assistive tech — glyphs like ⌘ and ⇧ read as nonsense — so a spoken form
 * rides alongside them.
 */
export function KeyCaps({ keys, isMac }: { keys: string; isMac: boolean }): JSX.Element {
  const tokens = formatKeyTokens(keys, isMac);
  return (
    <span className="flex items-center gap-1 shrink-0">
      <span className="sr-only">{describeKeys(keys, isMac)}</span>
      <span aria-hidden="true" className="flex items-center gap-1">
        {tokens.map((token, i) => (
          <kbd
            key={`${token}-${String(i)}`}
            className="border-[2px] px-1.5 py-1 min-w-6 text-center text-[10px]
                       font-bold leading-none tracking-[0.06em]"
            style={{ borderColor: 'var(--ink)', color: 'var(--ink)', background: 'var(--bg)' }}
          >
            {token}
          </kbd>
        ))}
      </span>
    </span>
  );
}

export interface ShortcutHelpProps {
  open: boolean;
  onClose: () => void;
  /** Defaults to the whole registry. Pass a subset to scope the sheet. */
  shortcuts?: readonly Shortcut[];
}

/**
 * The `?` overlay. Everything the keyboard can do, on one surface, grouped the
 * way the app is grouped — this is the map a power user builds their muscle
 * memory from, and the reassurance for someone who does not know synthesis
 * that nothing is hidden.
 */
export function ShortcutHelp({
  open, onClose, shortcuts = SHORTCUTS,
}: ShortcutHelpProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const isMac = useIsMac();
  useDialogFocus(open, dialogRef, onClose);

  if (!open) return null;
  const sections = groupedShortcuts(shortcuts);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      style={{ background: 'rgba(14, 14, 14, 0.92)' }}
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sigil-shortcut-help-title"
        tabIndex={-1}
        className="w-full max-w-5xl border-[3px]"
        style={{ borderColor: 'var(--ink)', background: 'var(--panel)' }}
        onMouseDown={(e): void => e.stopPropagation()}
      >
        <header
          className="flex items-center justify-between gap-4 border-b-[3px] px-4 py-3"
          style={{ borderColor: 'var(--ink)' }}
        >
          <h2
            id="sigil-shortcut-help-title"
            className="label"
            style={{ color: 'var(--ink)' }}
          >
            Keyboard
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="hard border-[3px] px-3 py-2 text-[10px] font-bold uppercase
                       tracking-[0.16em]"
            style={{ borderColor: 'var(--ink)', color: 'var(--ink)' }}
          >
            Close
          </button>
        </header>

        <div className="p-4 columns-1 sm:columns-2 lg:columns-3 gap-6">
          {sections.map((section) => (
            <section key={section.group} className="mb-6 break-inside-avoid">
              <h3
                className="label border-b-[3px] pb-1.5 mb-2"
                style={{ color: 'var(--ink)', borderColor: 'var(--ink)' }}
              >
                {section.group}
              </h3>
              <ul>
                {section.items.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-3 py-1.5 border-b-[2px]"
                    style={{ borderColor: '#2A2A28' }}
                  >
                    <span className="text-[11px] leading-snug" style={{ color: 'var(--ink)' }}>
                      {s.label}
                    </span>
                    <KeyCaps keys={s.keys} isMac={isMac} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <footer
          className="border-t-[3px] px-4 py-2.5"
          style={{ borderColor: 'var(--ink)' }}
        >
          <p className="text-[10px] leading-relaxed" style={{ color: 'var(--ink)', opacity: 0.75 }}>
            Unmodified letters play notes. Anything that would land on a playing
            key takes Alt, and file-level actions take {isMac ? 'Command' : 'Ctrl'}.
          </p>
        </footer>
      </div>
    </div>
  );
}
