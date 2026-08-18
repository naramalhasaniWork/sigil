'use client';

import {
  useCallback, useState,
  type CSSProperties, type JSX, type KeyboardEvent, type ReactNode,
} from 'react';
import { MOTION, useReducedMotion } from '@/ui/motion';

export interface PressableProps {
  onPress: () => void;
  disabled?: boolean;
  /** Identity colour: fills the face when solid, draws the border when outline. */
  colour?: string;
  variant?: 'solid' | 'outline';
  ariaLabel?: string;
  children: ReactNode;
}

/** The offset shadow that makes a control look like it is sitting above the panel. */
const SHADOW = '4px 4px 0 0 var(--ink)';

/**
 * The standard pressable thing. Every button in SIGIL should be one of these,
 * because the click is the instrument's only tactile channel: the face carries
 * a hard offset shadow, and pressing drops it 2px onto the panel so the shadow
 * disappears — a physical key bottoming out, not a web button lighting up.
 *
 * Only `transform` and `box-shadow` are animated, at 90ms ease-out. Fading
 * colour or opacity under the finger reads as mushy and, worse, as latency;
 * geometry moving reads as mechanism. Colour changes here are instant by
 * design.
 *
 * It is a real `<button>`, so Enter and Space, focus rings, screen readers and
 * form semantics all come for free — and 44px minimum in both axes, because
 * this gets played on a phone.
 */
export function Pressable({
  onPress, disabled = false, colour, variant = 'outline', ariaLabel, children,
}: PressableProps): JSX.Element {
  const reduced = useReducedMotion();
  const [down, setDown] = useState(false);

  const press = useCallback((): void => { if (!disabled) setDown(true); }, [disabled]);
  const release = useCallback((): void => setDown(false), []);

  // Visual state only — the key is never consumed, so nothing the player has
  // bound elsewhere (notes, transport) is swallowed by a focused button.
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.repeat || disabled) return;
    if (e.key === 'Enter' || e.key === ' ') setDown(true);
  }, [disabled]);

  const pressed = down && !disabled;
  const solid = variant === 'solid';

  const style: CSSProperties = {
    borderColor: solid ? 'var(--ink)' : (colour ?? 'var(--ink)'),
    background: solid ? (colour ?? 'var(--ink)') : 'transparent',
    // Never --muted: it fails AA on panel at this size. Ink, or the dark ground.
    color: solid ? 'var(--bg)' : 'var(--ink)',
    boxShadow: pressed || disabled ? 'none' : SHADOW,
    transform: pressed ? 'translate(2px, 2px)' : 'translate(0, 0)',
    transition: reduced
      ? 'none'
      : `transform ${MOTION.fast}ms ease-out, box-shadow ${MOTION.fast}ms ease-out`,
    opacity: disabled ? 0.4 : 1,
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
  };

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(): void => { if (!disabled) onPress(); }}
      onPointerDown={press}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onKeyDown={onKeyDown}
      onKeyUp={release}
      onBlur={release}
      className="inline-flex items-center justify-center gap-2 border-[3px] px-4
                 min-h-11 min-w-11 select-none
                 text-[10px] font-bold uppercase tracking-[0.16em] leading-none
                 disabled:cursor-not-allowed"
      style={style}
    >
      {children}
    </button>
  );
}
