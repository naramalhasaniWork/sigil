'use client';

import { useCallback, useEffect, useState, type JSX } from 'react';
import type { EngineHost, LatencyProfile } from '@/audio/engine-host';

/**
 * Buffer profile and measured latency.
 *
 * Both exist for the same reason: playing SIGIL against a DAW project. The
 * profile trades responsiveness for stability, and the readout is the number
 * you type into that DAW's track delay so what you record lands where you
 * played it.
 */

const PROFILES: readonly { id: LatencyProfile; label: string; what: string }[] = [
  {
    id: 'responsive',
    label: 'Responsive',
    what: 'Smallest buffer. Best for playing by hand. Can crackle on a busy machine.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    what: 'The browser picks. A reasonable default when you are doing both.',
  },
  {
    id: 'stable',
    label: 'Stable',
    what: 'Largest buffer. Use when recording or when anything is crackling. Noticeably laggier to play.',
  },
];

export function AudioSetup({ host, colour }: {
  host: EngineHost | null;
  colour: string;
}): JSX.Element {
  const [profile, setProfile] = useState<LatencyProfile>(host?.latencyProfile ?? 'responsive');
  const [busy, setBusy] = useState(false);
  const [latency, setLatency] = useState(host?.latency ?? null);

  /*
   * Poll rather than read once. outputLatency is not stable until the device
   * has actually started, and it changes if the user switches output mid
   * session — a stale number here is one that gets typed into a DAW and
   * trusted.
   */
  useEffect(() => {
    if (host === null) return;
    const read = (): void => setLatency(host.latency);
    read();
    const id = window.setInterval(read, 1000);
    return (): void => window.clearInterval(id);
  }, [host]);

  const choose = useCallback((next: LatencyProfile): void => {
    if (host === null || busy || next === profile) return;
    setBusy(true);
    setProfile(next);
    // Rebuilds the audio graph, so the sound stops for a moment. Nothing else
    // can be done about it: latencyHint is fixed when a context is constructed.
    void host.setLatencyProfile(next).finally(() => {
      setBusy(false);
      setLatency(host.latency);
    });
  }, [host, busy, profile]);

  return (
    <section className="flex flex-col gap-3" aria-label="Audio">
      <div className="label" style={{ color: 'var(--ink)' }}>Buffer</div>

      <div className="flex flex-wrap gap-2">
        {PROFILES.map((p) => {
          const active = p.id === profile;
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={active}
              disabled={host === null || busy}
              onClick={(): void => choose(p.id)}
              className="border-[3px] px-3 text-[10px] font-bold uppercase tracking-[0.16em] disabled:opacity-40"
              style={{
                minHeight: 44,
                borderColor: 'var(--ink)',
                background: active ? colour : 'transparent',
                color: active ? 'var(--bg)' : 'var(--ink)',
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <p className="text-[11px] leading-snug" style={{ color: 'var(--ink)' }}>
        {PROFILES.find((p) => p.id === profile)?.what}
      </p>

      {busy && (
        <p className="label" style={{ color: colour }} role="status">
          Rebuilding the audio graph…
        </p>
      )}

      <div className="label mt-2" style={{ color: 'var(--ink)' }}>Latency</div>

      {/*
        Never show a confident 0.0 ms. baseLatency and outputLatency are both
        optional in the Web Audio spec, and a made-up number here is worse than
        none because someone will type it into Live and trust it.
      */}
      {host === null || latency === null || !latency.reported ? (
        <p className="text-[11px] leading-snug" style={{ color: 'var(--ink)' }}>
          {host === null
            ? 'Power the instrument on to measure latency.'
            : 'This browser does not report audio latency, so there is no number to give you. Chrome does.'}
        </p>
      ) : (
        <>
          <div
            className="border-[3px] px-3 py-2 flex items-baseline gap-2"
            style={{ borderColor: 'var(--ink)', background: 'var(--panel)' }}
          >
            <span className="font-bold" style={{ fontSize: 26, color: colour }}>
              {latency.totalMs.toFixed(1)}
            </span>
            <span className="label" style={{ color: 'var(--ink)' }}>ms round trip</span>
          </div>
          <p className="text-[11px] leading-snug" style={{ color: 'var(--ink)' }}>
            Graph {latency.baseMs.toFixed(1)} ms + device {latency.outputMs.toFixed(1)} ms. Put this
            in your DAW&apos;s track delay so what you record lands where you played it. Routing
            SIGIL through a virtual audio device adds a little more on top of this.
          </p>
        </>
      )}
    </section>
  );
}
