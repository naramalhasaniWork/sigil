'use client';

import {
  useEffect, useMemo, useRef, useState,
  type JSX, type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { SHORTCUT_GROUPS } from '@/ui/shortcuts';
import { useDialogFocus, useIsMac } from '@/ui/use-shortcuts';
import { KeyCaps } from './shortcut-help';

export interface Command {
  id: string;
  label: string;
  group: string;
  /** Registry key string, e.g. `"mod+s"`. Rendered as caps on the right. */
  keys?: string;
  run: () => void;
}

/**
 * Subsequence match with a bias toward runs and word starts, so "sv" finds
 * "Save patch" and "eng2" finds "Engine 2". Returns null when the query does
 * not fit at all.
 */
function fuzzyScore(text: string, query: string): number | null {
  if (query.length === 0) return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  let cursor = 0;
  let run = 0;

  for (const ch of query.toLowerCase()) {
    if (ch === ' ') continue;
    const at = haystack.indexOf(ch, cursor);
    if (at === -1) return null;
    if (at === cursor && cursor > 0) {
      run += 1;
      score += 10 + run * 3;
    } else {
      run = 0;
      score += 2;
    }
    const before = at === 0 ? ' ' : haystack.charAt(at - 1);
    if (before === ' ' || before === '-' || before === '—') score += 8;
    score -= Math.min(at - cursor, 8);
    cursor = at + 1;
  }
  return score;
}

interface Scored {
  command: Command;
  score: number;
}

interface Section {
  group: string;
  items: readonly Command[];
}

function groupOrder(group: string): number {
  const i = (SHORTCUT_GROUPS as readonly string[]).indexOf(group);
  return i === -1 ? SHORTCUT_GROUPS.length : i;
}

function buildSections(commands: readonly Command[], query: string): readonly Section[] {
  const scored: Scored[] = [];
  for (const command of commands) {
    const score = fuzzyScore(`${command.group} ${command.label}`, query.trim());
    if (score !== null) scored.push({ command, score });
  }

  const byGroup = new Map<string, Scored[]>();
  for (const entry of scored) {
    const list = byGroup.get(entry.command.group);
    if (list === undefined) byGroup.set(entry.command.group, [entry]);
    else list.push(entry);
  }

  const searching = query.trim().length > 0;
  const sections: { group: string; items: Command[]; best: number }[] = [];
  for (const [group, entries] of byGroup) {
    if (searching) entries.sort((a, b) => b.score - a.score);
    const best = entries.reduce((m, e) => Math.max(m, e.score), -Infinity);
    sections.push({ group, items: entries.map((e) => e.command), best });
  }
  sections.sort((a, b) => (searching ? b.best - a.best : groupOrder(a.group) - groupOrder(b.group)));
  return sections;
}

export interface CommandPaletteProps {
  open: boolean;
  commands: readonly Command[];
  onClose: () => void;
}

/**
 * Every command in the app, one keystroke away. This is the power-user path —
 * and the discovery path for someone who does not yet know the shortcut,
 * because each row prints the keys that would have got them here directly.
 *
 * Deliberately a bordered box, not a floating card: flat, hard-edged, opaque.
 */
export function CommandPalette({ open, commands, onClose }: CommandPaletteProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const isMac = useIsMac();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  useDialogFocus(open, dialogRef, onClose);

  const sections = useMemo(() => buildSections(commands, query), [commands, query]);
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const activeCommand = flat[Math.min(active, flat.length - 1)];
  const activeId = activeCommand === undefined ? undefined : `sigil-cmd-${activeCommand.id}`;

  useEffect(() => {
    if (activeId === undefined) return;
    listRef.current?.querySelector(`#${CSS.escape(activeId)}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  if (!open) return null;

  const move = (delta: number): void => {
    if (flat.length === 0) return;
    setActive((i) => (i + delta + flat.length) % flat.length);
  };

  const runCommand = (command: Command): void => {
    onClose();
    command.run();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(Math.max(0, flat.length - 1)); }
    else if (e.key === 'Enter' && activeCommand !== undefined) {
      e.preventDefault();
      runCommand(activeCommand);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-12"
      style={{ background: 'rgba(14, 14, 14, 0.92)' }}
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        className="w-full max-w-2xl border-[3px] flex flex-col max-h-[75vh]"
        style={{ borderColor: 'var(--ink)', background: 'var(--panel)' }}
        onMouseDown={(e): void => e.stopPropagation()}
      >
        <div className="border-b-[3px] flex items-center gap-3 px-4" style={{ borderColor: 'var(--ink)' }}>
          <span aria-hidden="true" className="label shrink-0" style={{ color: 'var(--ink)' }}>Run</span>
          <input
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="sigil-command-list"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label="Search commands"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search commands…"
            value={query}
            onChange={(e): void => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className="flex-1 min-h-12 bg-transparent text-sm font-medium"
            style={{ color: 'var(--ink)' }}
          />
        </div>

        <div id="sigil-command-list" role="listbox" aria-label="Commands" ref={listRef} className="overflow-y-auto">
          {flat.length === 0 && (
            <p className="px-4 py-6 text-[11px]" style={{ color: 'var(--ink)', opacity: 0.75 }}>
              Nothing matches “{query}”.
            </p>
          )}

          {sections.map((section) => (
            <div key={section.group} role="group" aria-label={section.group}>
              <div
                aria-hidden="true"
                className="label px-4 py-2 border-b-[2px]"
                style={{ color: 'var(--ink)', borderColor: '#2A2A28' }}
              >
                {section.group}
              </div>
              {section.items.map((command) => {
                const selected = activeCommand !== undefined && command.id === activeCommand.id;
                return (
                  <div
                    key={command.id}
                    id={`sigil-cmd-${command.id}`}
                    role="option"
                    aria-selected={selected}
                    onMouseDown={(e): void => e.preventDefault()}
                    onMouseMove={(): void => {
                      const index = flat.findIndex((c) => c.id === command.id);
                      if (index !== -1) setActive(index);
                    }}
                    onClick={(): void => runCommand(command)}
                    className="flex items-center justify-between gap-4 px-4 min-h-11 cursor-pointer"
                    style={{
                      background: selected ? 'var(--ink)' : 'transparent',
                      color: selected ? 'var(--bg)' : 'var(--ink)',
                    }}
                  >
                    <span className="text-[12px] font-medium leading-snug">{command.label}</span>
                    {command.keys !== undefined && (
                      <KeyCaps keys={command.keys} isMac={isMac} />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div
          className="border-t-[3px] px-4 py-2 flex items-center gap-4"
          style={{ borderColor: 'var(--ink)' }}
        >
          <span className="label" style={{ color: 'var(--ink)' }}>↑↓ Move</span>
          <span className="label" style={{ color: 'var(--ink)' }}>↵ Run</span>
          <span className="label" style={{ color: 'var(--ink)' }}>Esc Close</span>
        </div>
      </div>
    </div>
  );
}
