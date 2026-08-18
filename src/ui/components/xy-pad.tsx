'use client';

import { useCallback, useEffect, useRef, type JSX } from 'react';

export interface XYPadProps {
  xLabel: string;
  yLabel: string;
  /** Normalised 0..1. */
  x: number;
  /** Normalised 0..1, 0 at the bottom. */
  y: number;
  colour: string;
  onChange: (x: number, y: number) => void;
  trail?: boolean;
}

const TRAIL_LEN = 24;
const GRID_DIVS = 8;
const PUCK = 26;
const INK = '#F5F1E6';
const PAD_BG = '#0A0A0A';
const GRID = '#2A2A28';

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function XYPad({
  xLabel, yLabel, x, y, colour, onChange, trail = true,
}: XYPadProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const box = useRef({ left: 0, top: 0, width: 0, height: 0 });
  const pos = useRef({ x: clamp01(x), y: clamp01(y) });
  const last = useRef({ x: -1, y: -1 });
  const pointer = useRef<number | null>(null);
  // Preallocated ring buffer of recent positions: [x0, y0, x1, y1, ...] normalised.
  const buf = useRef<Float32Array>(new Float32Array(TRAIL_LEN * 2));
  const head = useRef(0);
  const count = useRef(0);
  const still = useRef(0);
  const raf = useRef(0);
  const reduced = useRef(false);
  const trailOn = useRef(trail);
  const hue = useRef(colour);

  const draw = useCallback((): void => {
    const ctx = ctxRef.current;
    const { w, h, dpr } = size.current;
    if (!ctx || w === 0 || h === 0) return;
    const snap = (v: number): number => Math.round(v * dpr) / dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = PAD_BG;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = GRID;
    for (let i = 1; i < GRID_DIVS; i += 1) {
      const t = i === GRID_DIVS / 2 ? 2 : 1;
      ctx.fillRect(snap((i / GRID_DIVS) * w), 0, t, h);
      ctx.fillRect(0, snap((i / GRID_DIVS) * h), w, t);
    }

    const m = PUCK / 2;
    const spanX = Math.max(1, w - PUCK);
    const spanY = Math.max(1, h - PUCK);
    const toPx = (nx: number): number => m + nx * spanX;
    const toPy = (ny: number): number => m + (1 - ny) * spanY;

    if (trailOn.current && !reduced.current && count.current > 1) {
      const n = count.current;
      const first = (head.current - n + TRAIL_LEN) % TRAIL_LEN;
      const data = buf.current;
      ctx.lineWidth = 2;
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
      ctx.strokeStyle = hue.current;
      for (let i = 1; i < n; i += 1) {
        const a = ((first + i - 1) % TRAIL_LEN) * 2;
        const b = ((first + i) % TRAIL_LEN) * 2;
        ctx.globalAlpha = (i / n) * 0.6;
        ctx.beginPath();
        ctx.moveTo(toPx(data[a] ?? 0), toPy(data[a + 1] ?? 0));
        ctx.lineTo(toPx(data[b] ?? 0), toPy(data[b + 1] ?? 0));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    const cx = snap(toPx(pos.current.x));
    const cy = snap(toPy(pos.current.y));

    ctx.fillStyle = hue.current;
    ctx.globalAlpha = 0.45;
    ctx.fillRect(0, snap(cy - 1), cx, 2);
    ctx.fillRect(snap(cx - 1), cy, 2, h - cy);
    ctx.globalAlpha = 1;

    const px = snap(cx - m);
    const py = snap(cy - m);
    ctx.fillRect(px, py, PUCK, PUCK);
    ctx.lineWidth = 3;
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = INK;
    ctx.strokeRect(px + 1.5, py + 1.5, PUCK - 3, PUCK - 3);
  }, []);

  const tick = useCallback((): void => {
    raf.current = 0;
    const p = pos.current;
    const moved = p.x !== last.current.x || p.y !== last.current.y;
    last.current.x = p.x;
    last.current.y = p.y;
    still.current = moved ? 0 : still.current + 1;

    const data = buf.current;
    const hd = head.current;
    data[hd * 2] = p.x;
    data[hd * 2 + 1] = p.y;
    head.current = (hd + 1) % TRAIL_LEN;
    if (count.current < TRAIL_LEN) count.current += 1;

    draw();
    const settling = trailOn.current && !reduced.current && still.current < TRAIL_LEN;
    if (settling || pointer.current !== null) raf.current = requestAnimationFrame(tick);
  }, [draw]);

  const kick = useCallback((): void => {
    if (raf.current === 0) raf.current = requestAnimationFrame(tick);
  }, [tick]);

  const measure = useCallback((): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    box.current.left = r.left;
    box.current.top = r.top;
    box.current.width = r.width;
    box.current.height = r.height;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    size.current.w = r.width;
    size.current.h = r.height;
    size.current.dpr = dpr;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    ctxRef.current = canvas.getContext('2d');
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced.current = mql.matches;
    const onMotion = (): void => { reduced.current = mql.matches; };
    mql.addEventListener('change', onMotion);

    const ro = new ResizeObserver((): void => { measure(); draw(); });
    ro.observe(canvas);
    measure();
    draw();

    return (): void => {
      if (raf.current !== 0) cancelAnimationFrame(raf.current);
      raf.current = 0;
      ro.disconnect();
      mql.removeEventListener('change', onMotion);
      ctxRef.current = null;
    };
  }, [draw, measure]);

  useEffect(() => {
    pos.current.x = clamp01(x);
    pos.current.y = clamp01(y);
    hue.current = colour;
    trailOn.current = trail;
    kick();
  }, [x, y, colour, trail, kick]);

  const emit = useCallback((clientX: number, clientY: number): void => {
    const r = box.current;
    if (r.width === 0 || r.height === 0) return;
    const m = PUCK / 2;
    const nx = clamp01((clientX - r.left - m) / Math.max(1, r.width - PUCK));
    const ny = clamp01(1 - (clientY - r.top - m) / Math.max(1, r.height - PUCK));
    onChange(nx, ny);
  }, [onChange]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (pointer.current !== null) return;
    e.preventDefault();
    pointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    hostRef.current?.focus({ preventScroll: true });
    measure();
    emit(e.clientX, e.clientY);
    kick();
  }, [emit, kick, measure]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (pointer.current !== e.pointerId) return;
    emit(e.clientX, e.clientY);
  }, [emit]);

  const endPointer = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (pointer.current !== e.pointerId) return;
    pointer.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 0.005 : 0.02;
    let dx = 0;
    let dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = step;
    else if (e.key === 'ArrowDown') dy = -step;
    else return;
    e.preventDefault();
    onChange(clamp01(pos.current.x + dx), clamp01(pos.current.y + dy));
  }, [onChange]);

  const xi = Math.round(clamp01(x) * 100);
  const yi = Math.round(clamp01(y) * 100);

  return (
    <div
      ref={hostRef}
      role="application"
      tabIndex={0}
      aria-label={`${xLabel} and ${yLabel} pad`}
      aria-valuetext={`${xLabel} ${xi}, ${yLabel} ${yi}`}
      className="relative w-full aspect-square select-none"
      style={{
        border: `3px solid ${INK}`,
        background: PAD_BG,
        touchAction: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        cursor: 'crosshair',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onKeyDown={onKeyDown}
      onContextMenu={(e): void => e.preventDefault()}
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
      <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-0.5">
        <span className="label">{yLabel}</span>
        <span className="text-xs font-bold" style={{ color: colour }}>{yi}</span>
      </div>
      <div className="pointer-events-none absolute right-2 bottom-2 flex flex-col items-end gap-0.5">
        <span className="label">{xLabel}</span>
        <span className="text-xs font-bold" style={{ color: colour }}>{xi}</span>
      </div>
    </div>
  );
}
