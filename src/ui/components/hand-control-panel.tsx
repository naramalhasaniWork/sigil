'use client';

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useHandControl } from '@/ui/use-hand-control';

interface HandControlPanelProps {
  /** Called ~30 times a second while a hand is visible. Modulation only. */
  onReading: (x: number, y: number, pinch: number, spread: number) => void;
  /** What each signal is patched to, shown next to the bars. */
  targets?: { x: string; y: string; pinch: string; spread: string };
}

const PREVIEW_W = 240;
const PREVIEW_H = 180;
const INK = '#F5F1E6';
const GROUND = '#0A0A0A';
const ANALOG = '#FF6B6B';
const PHYSICAL = '#FFD93D';

/** MediaPipe hand skeleton: palm, then thumb, index, middle, ring, pinky. */
const BONES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
const TIPS = [4, 8, 12, 16, 20];

function Bar({ label, target, value, colour }: {
  label: string; target: string | undefined; value: number; colour: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="label">{target === undefined ? label : `${label} → ${target}`}</span>
        <span className="text-xs font-bold tabular-nums" style={{ color: colour }}>
          {Math.round(value * 100)}
        </span>
      </div>
      <div className="h-3 w-full border-[3px]" style={{ borderColor: INK, background: GROUND }}>
        <div
          className="h-full"
          style={{ width: `${Math.round(value * 100)}%`, background: colour }}
        />
      </div>
    </div>
  );
}

/**
 * Camera hand tracking as a modulation source. The camera is off until the
 * button below is pressed, and every frame is discarded after it is measured.
 */
export function HandControlPanel({ onReading, targets }: HandControlPanelProps): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const handleReading = useCallback(
    (x: number, y: number, pinch: number, spread: number): void => {
      onReading(x, y, pinch, spread);
    },
    [onReading],
  );

  const { supported, active, error, reading, videoRef, frameRef } = useHandControl({
    enabled,
    onReading: handleReading,
  });

  // Landmark overlay. Drawn from the hook's preallocated buffer, mirrored to
  // match the mirrored preview.
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = PREVIEW_W * dpr;
    canvas.height = PREVIEW_H * dpr;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';

    let handle = 0;
    const draw = (): void => {
      handle = window.requestAnimationFrame(draw);
      ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
      const frame = frameRef.current;
      if (!frame.present) return;
      const pts = frame.points;

      ctx.strokeStyle = INK;
      ctx.beginPath();
      for (let i = 0; i < BONES.length; i += 1) {
        const bone = BONES[i];
        if (bone === undefined) continue;
        const ax = (1 - (pts[bone[0] * 2] ?? 0)) * PREVIEW_W;
        const ay = (pts[bone[0] * 2 + 1] ?? 0) * PREVIEW_H;
        const bx = (1 - (pts[bone[1] * 2] ?? 0)) * PREVIEW_W;
        const by = (pts[bone[1] * 2 + 1] ?? 0) * PREVIEW_H;
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.stroke();

      ctx.fillStyle = ANALOG;
      for (let i = 0; i < TIPS.length; i += 1) {
        const idx = TIPS[i];
        if (idx === undefined) continue;
        const x = (1 - (pts[idx * 2] ?? 0)) * PREVIEW_W;
        const y = (pts[idx * 2 + 1] ?? 0) * PREVIEW_H;
        ctx.fillRect(x - 3, y - 3, 6, 6);
      }
    };
    handle = window.requestAnimationFrame(draw);
    return (): void => window.cancelAnimationFrame(handle);
  }, [active, frameRef]);

  const r = reading;
  const status = !enabled
    ? 'CAMERA OFF'
    : active ? (r === null ? 'NO HAND' : 'TRACKING') : error !== null ? 'STOPPED' : 'STARTING';

  return (
    <section
      className="flex w-full max-w-[280px] flex-col gap-3 border-[3px] p-3"
      style={{ borderColor: INK, background: GROUND }}
      aria-label="Hand control"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="label">HAND</span>
        <span className="label" style={{ color: active ? PHYSICAL : undefined }}>{status}</span>
      </div>

      <div
        className="relative overflow-hidden border-[3px]"
        style={{ borderColor: INK, background: GROUND, width: PREVIEW_W, height: PREVIEW_H }}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          className="h-full w-full object-cover"
          style={{ transform: 'scaleX(-1)', opacity: active ? 0.55 : 0 }}
        />
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
        {!active && (
          <div className="absolute inset-0 grid place-items-center px-4 text-center">
            <span className="label">{supported ? status : 'CAMERA UNAVAILABLE'}</span>
          </div>
        )}
      </div>

      <button
        type="button"
        disabled={!supported && !enabled}
        onClick={(): void => setEnabled((on) => !on)}
        className="hard border-[3px] px-3 py-2 text-xs font-bold tracking-[0.18em] uppercase disabled:opacity-40"
        style={{ borderColor: INK, background: enabled ? INK : GROUND, color: enabled ? GROUND : INK }}
      >
        {enabled ? 'Stop camera' : 'Start camera'}
      </button>

      {error !== null && (
        <p
          role="alert"
          className="border-[3px] p-2 text-xs font-bold"
          style={{ borderColor: ANALOG, color: ANALOG, background: GROUND }}
        >
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <Bar label="X" target={targets?.x} value={r?.x ?? 0} colour={ANALOG} />
        <Bar label="Y" target={targets?.y} value={r?.y ?? 0} colour={ANALOG} />
        <Bar label="PINCH" target={targets?.pinch} value={r?.pinch ?? 0} colour={PHYSICAL} />
        <Bar label="SPREAD" target={targets?.spread} value={r?.spread ?? 0} colour={PHYSICAL} />
      </div>

      <p className="text-[10px] leading-snug" style={{ color: '#7D786C' }}>
        Video is processed entirely on your device. Nothing is recorded and no frames are
        ever uploaded. Tracking lags by about a tenth of a second, so hand movement shapes
        the sound — it does not play the notes.
      </p>
    </section>
  );
}
