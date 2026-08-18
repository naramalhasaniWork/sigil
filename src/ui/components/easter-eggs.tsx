'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Pressable } from '@/ui/components/pressable';

/**
 * Class the app puts on its root while ritual mode is on. The styling lives in
 * globals.css so the mode is a skin, not a second UI.
 */
export const RITUAL_CLASS = 'sigil-ritual';

/**
 * Physical codes, so the sequence is the same shape on AZERTY and Dvorak.
 * KeyB and KeyA are note keys — they are *observed* here and never consumed,
 * so finishing the code plays the notes it always played. Nothing in this file
 * calls preventDefault or stopPropagation on anything.
 */
const KONAMI: readonly string[] = [
  'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'KeyB', 'KeyA',
];

const HOLD_MS = 5000;
const TRITONE_MS = 3000;
const TRITONE_SEMITONES = 6;

const TRITONE_LINE =
  'Tritone — the "diabolus in musica" theory teachers spent centuries steering singers away from, and the interval every siren, blues turnaround and metal riff is built on.';

export interface HoldProps {
  onPointerDown: () => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onKeyDown: (e: { key: string; repeat: boolean }) => void;
  onKeyUp: () => void;
}

export interface EasterEggOptions {
  /** Called once per reveal. The app decides how to show it — usually the toast. */
  onReveal: (id: string, label: string) => void;
  /** Currently sounding notes. Omit it and the interval egg simply stays asleep. */
  held?: ReadonlySet<number>;
}

export interface EasterEggs {
  /** Ritual mode. Entering the code again turns it off. */
  konami: boolean;
  /** `RITUAL_CLASS` while ritual mode is on, otherwise empty. */
  ritualClass: string;
  /** Spread onto the SIGIL mark's button: a five-second hold opens the credits. */
  holdProps: HoldProps;
  credits: boolean;
  closeCredits: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Three things you can find, all earned by doing something with the instrument
 * rather than by clicking a "secrets" button.
 *
 * Every one is harmless and reversible: ritual mode toggles off with the same
 * code, the interval line is a passing toast, the credits panel closes. None of
 * them touch audio, and none of them consume a key event — a secret that eats a
 * note would be a bug wearing a costume.
 */
export function useEasterEggs(opts: EasterEggOptions): EasterEggs {
  const revealRef = useRef(opts.onReveal);
  revealRef.current = opts.onReveal;

  const [konami, setKonami] = useState(false);
  const [credits, setCredits] = useState(false);

  // ---- 1. The code -------------------------------------------------------
  useEffect(() => {
    let idx = 0;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) { idx = 0; return; }
      if (e.code === KONAMI[idx]) idx += 1;
      else idx = e.code === KONAMI[0] ? 1 : 0;
      if (idx < KONAMI.length) return;
      idx = 0;
      setKonami((prev) => !prev);
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Announced from an effect rather than the updater, so a double-invoked
  // updater in development cannot announce twice.
  const firstKonami = useRef(true);
  useEffect(() => {
    if (firstKonami.current) { firstKonami.current = false; return; }
    revealRef.current(
      'konami',
      konami
        ? 'Ritual mode. Enter the code again to put everything back.'
        : 'Ritual mode off.',
    );
  }, [konami]);

  // ---- 2. The interval ---------------------------------------------------
  // A key that only exists while exactly a tritone is sounding: it changes when
  // the interval breaks, which restarts the timer, so the reveal fires once per
  // sustained hold rather than once per note event.
  const tritoneKey = useMemo((): string => {
    const held = opts.held;
    if (held === undefined || held.size !== 2) return '';
    const notes = Array.from(held).sort((a, b) => a - b);
    const lo = notes[0];
    const hi = notes[1];
    if (lo === undefined || hi === undefined) return '';
    return hi - lo === TRITONE_SEMITONES ? `${lo}:${hi}` : '';
  }, [opts.held]);

  useEffect(() => {
    if (tritoneKey === '') return;
    const t = window.setTimeout((): void => {
      revealRef.current('tritone', TRITONE_LINE);
    }, TRITONE_MS);
    return (): void => window.clearTimeout(t);
  }, [tritoneKey]);

  // ---- 3. The mark -------------------------------------------------------
  const holdTimer = useRef<number | null>(null);

  const clearHold = useCallback((): void => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);

  const beginHold = useCallback((): void => {
    clearHold();
    holdTimer.current = window.setTimeout((): void => {
      holdTimer.current = null;
      setCredits(true);
      revealRef.current('credits', 'Credits. Close them with Escape.');
    }, HOLD_MS);
  }, [clearHold]);

  useEffect(() => clearHold, [clearHold]);

  const closeCredits = useCallback((): void => setCredits(false), []);

  useEffect(() => {
    if (!credits) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCredits(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, [credits]);

  const holdProps = useMemo<HoldProps>(() => ({
    onPointerDown: beginHold,
    onPointerUp: clearHold,
    onPointerLeave: clearHold,
    onPointerCancel: clearHold,
    onKeyDown: (e): void => {
      if (e.repeat) return;
      if (e.key === 'Enter' || e.key === ' ') beginHold();
    },
    onKeyUp: clearHold,
  }), [beginHold, clearHold]);

  return {
    konami,
    ritualClass: konami ? RITUAL_CLASS : '',
    holdProps,
    credits,
    closeCredits,
  };
}

const BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev';

const CREDIT_LINES: readonly string[] = [
  'A browser instrument for making material — one-shots, chords and phrases that end up on a KO II.',
  'Four engines behind one set of four macros, so your hands learn one instrument rather than four.',
  'Every parameter has to explain itself before it is allowed to ship.',
  'Audio is plain TypeScript in an AudioWorklet. Nothing allocates while a note is sounding.',
];

/**
 * The reward for holding the mark. Deliberately not modal: it takes no focus,
 * covers no keys, and the instrument keeps playing underneath it.
 */
export function CreditsPanel(
  { open, onClose }: { open: boolean; onClose: () => void },
): JSX.Element | null {
  if (!open) return null;

  return (
    <section
      aria-label="Build and credits"
      className="fixed z-[60] border-[3px] w-[min(360px,calc(100vw-32px))]"
      style={{
        top: 'calc(env(safe-area-inset-top, 0px) + 72px)',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'var(--panel)',
        borderColor: 'var(--ink)',
      }}
    >
      <header
        className="flex items-center justify-between border-b-[3px] px-3 py-2"
        style={{ borderColor: 'var(--ink)' }}
      >
        <span className="label" style={{ color: 'var(--ink)' }}>Sigil · Build {BUILD}</span>
      </header>

      <div className="flex flex-col gap-2.5 p-3">
        {CREDIT_LINES.map((line) => (
          <p key={line} className="text-[12px] leading-snug" style={{ color: 'var(--ink)' }}>
            {line}
          </p>
        ))}
        <p className="text-[12px] leading-snug" style={{ color: 'var(--ink)' }}>
          You found this by holding the mark for five seconds. There are two more.
        </p>
        <div className="pt-1">
          <Pressable onPress={onClose} ariaLabel="Close credits">Close</Pressable>
        </div>
      </div>
    </section>
  );
}
