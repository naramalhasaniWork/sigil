'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import { identityFor, instanceLabel } from '@/ui/instance-identity';

/**
 * Which SIGIL this is.
 *
 * Drawn only inside the plugin, where there can be six of them and the DAW gives
 * every one the same device title. In a browser there is one instrument and a
 * badge saying so would be furniture.
 *
 * It is a button, not a label, because the dealt name is a starting point: the
 * whole value of "Bass", "Pad", "That awful one" is that the player chose it.
 * One click to edit, Enter or blur to keep, Escape to abandon. No dialog, no
 * settings panel, no confirm — this is a name, and the cost of getting it wrong
 * is clicking it again.
 */
export function InstanceBadge({ mark, name, onRename }: {
  mark: number;
  name: string;
  onRename: (next: string) => void;
}): JSX.Element {
  const identity = identityFor(mark);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // A rename arriving from the host — a project reload, or an undo — must land
  // in the field, but not while it is being typed in.
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const shared = {
    minHeight: 44,
    background: identity.tint,
    // The page's own ground, on the tint. Every entry in the table is light
    // enough for that to be the readable pairing.
    color: 'var(--bg)',
    borderColor: 'var(--ink)',
  } as const;

  const className = 'border-[3px] px-2.5 text-[11px] font-bold uppercase tracking-[0.16em]';

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        maxLength={24}
        aria-label="Name this SIGIL"
        className={className}
        style={{ ...shared, width: '11ch' }}
        onChange={(e): void => setDraft(e.target.value)}
        onBlur={(): void => {
          onRename(draft);
          setEditing(false);
        }}
        onKeyDown={(e): void => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onRename(draft);
            setEditing(false);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(name);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={className}
      style={{ ...shared, minWidth: 44 }}
      title="Click to rename this SIGIL"
      onClick={(): void => setEditing(true)}
    >
      {instanceLabel(mark, name)}
    </button>
  );
}
