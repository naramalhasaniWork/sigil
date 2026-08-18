'use client';

import type { JSX } from 'react';
import type { Sigil } from '@/dsp/signature';
import { Panel } from './panel';
import { Pressable } from './pressable';
import { SigilGlyph } from './sigil-glyph';

interface SigilCardProps {
  sigil: Sigil | null;
  /** The current sound's true name, read off its parameters. */
  trueName: string | null;
  /** The name the save prompt will arrive pre-filled with. */
  suggestedName: string;
  /** How this sound was found. Empty until there is a story. */
  trail: string;
  colour: string;
  onSave: (name: string) => void;
}

/**
 * The current sound, as a thing rather than as a parameter set.
 *
 * Its mark, its true name, and how it was found — all three read straight off the
 * patch, so they are correct the instant a macro moves and there is nothing to
 * keep in sync. `Name it` exists because the moment a sound impresses you is
 * exactly the wrong moment to be asked to invent a name cold: the prompt opens
 * already filled in with what the patch actually is, so keeping it is one press
 * and one confirmation, and the story goes with it.
 */
export function SigilCard({
  sigil, trueName, suggestedName, trail, colour, onSave,
}: SigilCardProps): JSX.Element {
  const name = (): void => {
    const chosen = window.prompt('Name this sigil', suggestedName);
    if (chosen !== null && chosen.trim() !== '') onSave(chosen.trim());
  };

  return (
    <Panel title="Sigil" accent={colour}>
      <div className="flex items-start gap-3">
        {sigil !== null && (
          <SigilGlyph
            sigil={sigil}
            colour={colour}
            size={72}
            title={trueName === null ? 'The current sound' : `The mark of ${trueName}`}
          />
        )}
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <span className="label" style={{ color: 'var(--ink)' }}>Reads as</span>
          <span
            className="text-[15px] font-bold uppercase tracking-[0.02em] leading-tight break-words"
            style={{ color: 'var(--ink)' }}
          >
            {trueName ?? '—'}
          </span>
          {trail !== '' && (
            <span
              className="text-[10px] font-bold leading-snug break-words"
              style={{ color: 'var(--ink)' }}
            >
              {trail}
            </span>
          )}
        </div>
      </div>

      <div className="mt-3">
        <Pressable onPress={name} colour={colour} ariaLabel="Name and keep this patch">
          Name it
        </Pressable>
      </div>
    </Panel>
  );
}
