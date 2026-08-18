'use client';

import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { MOTION, useReducedMotion } from '@/ui/motion';

/** Long enough to read a filename and a size, short enough to stay out of the way. */
const DISMISS_MS = 3800;

export interface ToastHostProps {
  /** The current message, or null for none. A new string re-arms the timer. */
  message: string | null;
  colour: string;
}

/**
 * Feedback you cannot miss. A status line tucked into a header is invisible to
 * anyone whose eyes are on the keys, which is everyone, always — so what the
 * machine did comes to the middle of the screen instead, and leaves on its own.
 *
 * Three deliberate constraints:
 *
 *  - The live region is always mounted. Assistive tech only announces changes
 *    inside a region that already existed, so mounting the region with the
 *    message would announce nothing at all.
 *  - `aria-live="polite"`, never `alert`: it is spoken after the current
 *    utterance and never takes focus away from the control you are holding.
 *  - `pointer-events: none` on the whole overlay. A toast can appear over the
 *    pads mid-phrase, and nothing that appears unbidden is allowed to eat a
 *    touch that was meant for a note.
 */
export function ToastHost({ message, colour }: ToastHostProps): JSX.Element {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState<string | null>(null);
  const [entered, setEntered] = useState(false);
  const timer = useRef<number | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (message === null || message === '') {
      setShown(null);
      setEntered(false);
      return;
    }

    setShown(message);
    // Mount off-position, then settle: two paints, one 2px move. Under reduced
    // motion it simply starts where it ends.
    setEntered(reduced);
    if (!reduced) {
      raf.current = requestAnimationFrame((): void => {
        raf.current = null;
        setEntered(true);
      });
    }
    timer.current = window.setTimeout((): void => {
      timer.current = null;
      setShown(null);
      setEntered(false);
    }, DISMISS_MS);

    return (): void => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      if (raf.current !== null) {
        cancelAnimationFrame(raf.current);
        raf.current = null;
      }
    };
  }, [message, reduced]);

  const region: CSSProperties = {
    position: 'fixed',
    top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 50,
    pointerEvents: 'none',
    maxWidth: 'min(420px, calc(100vw - 24px))',
  };

  const card: CSSProperties = {
    background: 'var(--panel)',
    borderColor: colour,
    color: 'var(--ink)',
    transform: entered ? 'translateY(0)' : 'translateY(2px)',
    transition: reduced ? 'none' : `transform ${MOTION.base}ms ease-out`,
  };

  return (
    <div role="status" aria-live="polite" aria-atomic="true" style={region}>
      {shown !== null && (
        <div className="flex items-stretch border-[3px]" style={card}>
          <span aria-hidden="true" className="w-2.5 shrink-0" style={{ background: colour }} />
          <span className="px-3 py-2.5 text-[12px] font-bold leading-snug">{shown}</span>
        </div>
      )}
    </div>
  );
}
