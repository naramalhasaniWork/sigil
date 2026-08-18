'use client';

import { useCallback, useEffect, useState, type JSX } from 'react';

/**
 * Chromium fires `beforeinstallprompt` and lets us show our own Install button.
 * Safari never fires it and has no programmatic install at all, so iOS gets
 * written instructions instead — a button that silently does nothing on the
 * owner's primary device would be worse than no button.
 */
interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'sigil.installDismissed';

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    // iPadOS reports as a Mac, but a Mac with touch points is an iPad.
    || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

export function InstallPrompt({ colour }: { colour: string }): JSX.Element | null {
  const [deferred, setDeferred] = useState<InstallEvent | null>(null);
  const [showIosHelp, setShowIosHelp] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    // Already installed, or previously waved away — say nothing.
    if (isStandalone()) return;
    try {
      if (window.localStorage.getItem(DISMISSED_KEY) === '1') return;
    } catch { /* storage blocked; treat as not dismissed */ }
    setDismissed(false);

    const onPrompt = (e: Event): void => {
      e.preventDefault();          // keep Chrome's own banner out of the way
      setDeferred(e as InstallEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    const onInstalled = (): void => { setDeferred(null); setDismissed(true); };
    window.addEventListener('appinstalled', onInstalled);
    return (): void => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback((): void => {
    if (deferred === null) {
      setShowIosHelp(true);
      return;
    }
    void deferred.prompt();
    void deferred.userChoice.then(() => setDeferred(null));
  }, [deferred]);

  const hide = useCallback((): void => {
    setDismissed(true);
    try { window.localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* fine */ }
  }, []);

  if (dismissed) return null;
  // Nothing to offer: not iOS, and Chromium never said it was installable.
  if (deferred === null && !isIos()) return null;

  return (
    <div
      className="fixed z-50 border-[3px] px-3 py-2.5 flex flex-col gap-2"
      style={{
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(420px, calc(100vw - 24px))',
        background: 'var(--panel)',
        borderColor: 'var(--ink)',
        boxShadow: '5px 5px 0 0 var(--ink)',
      }}
    >
      {showIosHelp ? (
        <>
          <span className="label" style={{ color: 'var(--ink)' }}>Install on iPhone</span>
          <p className="text-[12px] leading-snug" style={{ color: 'var(--ink)' }}>
            Tap the Share button, then <strong>Add to Home Screen</strong>. SIGIL then opens
            like an app, without the browser bars.
          </p>
          <p className="text-[11px] leading-snug" style={{ color: 'var(--ink)', opacity: 0.75 }}>
            One thing worth knowing: iOS obeys the physical silent switch for web audio. If your
            ringer is off, SIGIL will be silent.
          </p>
        </>
      ) : (
        <p className="text-[12px] leading-snug" style={{ color: 'var(--ink)' }}>
          Install SIGIL for its own window and an icon — no download, and it keeps working
          offline once loaded.
        </p>
      )}

      <div className="flex gap-2">
        {!showIosHelp && (
          <button
            type="button"
            onClick={install}
            className="border-[3px] px-3 min-h-11 min-w-11 text-[10px] font-bold uppercase tracking-[0.16em]"
            style={{ borderColor: 'var(--ink)', background: colour, color: 'var(--bg)' }}
          >
            Install
          </button>
        )}
        <button
          type="button"
          onClick={hide}
          className="border-[3px] px-3 min-h-11 min-w-11 text-[10px] font-bold uppercase tracking-[0.16em]"
          style={{ borderColor: 'var(--muted)', color: 'var(--ink)' }}
        >
          {showIosHelp ? 'Got it' : 'Not now'}
        </button>
      </div>
    </div>
  );
}
