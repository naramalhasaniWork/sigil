'use client';

import { useCallback, useEffect, useRef, type JSX, type RefObject } from 'react';

/**
 * Surface tokens, kept as literals: a canvas cannot read CSS custom properties,
 * and these two views are the only place in the app that paints pixels directly.
 */
export const CANVAS_BG = '#0A0A0A';
export const CANVAS_GRID = '#2A2A28';
export const CANVAS_INK = '#F5F1E6';

/** Roughly 8fps when the viewer has asked for reduced motion. */
const REDUCED_FRAME_MS = 125;
const MAX_DPR = 3;
const TRACE_WIDTH = 3;

export type CanvasPainter = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dt: number,
) => void;

/**
 * Drives a canvas from requestAnimationFrame, keeping it sized to its container
 * at device pixel ratio. The painter is read through a ref so that changing
 * colour or analyser never tears down the frame loop.
 */
export function useCanvasPainter(paint: CanvasPainter): RefObject<HTMLCanvasElement | null> {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintRef = useRef<CanvasPainter>(paint);

  useEffect(() => {
    paintRef.current = paint;
  }, [paint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = motion.matches;
    const onMotion = (event: MediaQueryListEvent): void => {
      reduced = event.matches;
    };
    motion.addEventListener('change', onMotion);

    let cssWidth = 0;
    let cssHeight = 0;
    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const rect = canvas.getBoundingClientRect();
      cssWidth = Math.max(1, Math.round(rect.width));
      cssHeight = Math.max(1, Math.round(rect.height));
      const deviceWidth = Math.round(cssWidth * dpr);
      const deviceHeight = Math.round(cssHeight * dpr);
      if (canvas.width !== deviceWidth) canvas.width = deviceWidth;
      if (canvas.height !== deviceHeight) canvas.height = deviceHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    // A monitor or zoom change moves devicePixelRatio without changing CSS size.
    window.addEventListener('resize', resize);

    let frame = 0;
    let last = 0;
    const tick = (now: number): void => {
      frame = window.requestAnimationFrame(tick);
      if (reduced && last !== 0 && now - last < REDUCED_FRAME_MS) return;
      const dt = last === 0 ? 1 / 60 : Math.min(0.5, (now - last) / 1000);
      last = now;
      paintRef.current(ctx, cssWidth, cssHeight, dt);
    };
    frame = window.requestAnimationFrame(tick);

    return (): void => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', resize);
      motion.removeEventListener('change', onMotion);
    };
  }, []);

  return canvasRef;
}

/** Flat black field with a faint hard grid. Filled rects, never strokes, so edges stay exact. */
export function paintBackdrop(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  columns: number,
  rows: number,
): void {
  ctx.fillStyle = CANVAS_BG;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = CANVAS_GRID;
  for (let i = 1; i < columns; i += 1) {
    ctx.fillRect(Math.round((i * width) / columns), 0, 1, height);
  }
  for (let j = 1; j < rows; j += 1) {
    ctx.fillRect(0, Math.round((j * height) / rows), width, 1);
  }
}

const VAR_PATTERN = /^var\(\s*(--[\w-]+)\s*\)$/;

/**
 * Resolves a `var(--token)` colour against the document root once per change,
 * so the frame loop never triggers a style read. Literal colours pass through.
 */
export function useCssColour(colour: string): RefObject<string> {
  const resolved = useRef<string>(colour);
  useEffect(() => {
    const match = VAR_PATTERN.exec(colour);
    if (match === null) {
      resolved.current = colour;
      return;
    }
    const token = match[1] as string;
    const value = window.getComputedStyle(document.documentElement)
      .getPropertyValue(token)
      .trim();
    resolved.current = value.length > 0 ? value : colour;
  }, [colour]);
  return resolved;
}

interface CanvasFrameProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  label: string;
}

/** The bordered element itself: 3px ink frame, black field, no radius. */
export function CanvasFrame({ canvasRef, label }: CanvasFrameProps): JSX.Element {
  return (
    <div
      className="w-full h-full min-h-[112px] border-[3px]"
      style={{ borderColor: CANVAS_INK, background: CANVAS_BG }}
    >
      <canvas ref={canvasRef} role="img" aria-label={label} className="block w-full h-full" />
    </div>
  );
}

interface ScopeProps {
  analyser: AnalyserNode | null;
  colour: string;
}

/** Time-domain trace, triggered on a rising zero crossing so the wave stands still. */
export function Scope({ analyser, colour }: ScopeProps): JSX.Element {
  const samples = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const colourRef = useCssColour(colour);

  useEffect(() => {
    samples.current = analyser === null ? null : new Uint8Array(analyser.fftSize);
  }, [analyser]);

  const paint = useCallback<CanvasPainter>(
    (ctx, width, height) => {
      paintBackdrop(ctx, width, height, 8, 4);
      const mid = Math.round(height / 2) + 0.5;
      const buffer = samples.current;

      if (analyser === null || buffer === null || buffer.length < 2) {
        ctx.fillStyle = CANVAS_GRID;
        ctx.fillRect(0, Math.round(height / 2) - 1, width, TRACE_WIDTH);
        return;
      }

      analyser.getByteTimeDomainData(buffer);
      const count = Math.min(buffer.length, analyser.fftSize);
      const half = count >> 1;

      let start = 0;
      for (let i = 1; i < half; i += 1) {
        const previous = buffer[i - 1] as number;
        const current = buffer[i] as number;
        if (previous < 128 && current >= 128) {
          start = i;
          break;
        }
      }
      const span = Math.max(2, Math.min(half, count - start));
      const amplitude = Math.max(1, height / 2 - TRACE_WIDTH);
      const columns = Math.max(2, Math.floor(width));

      ctx.strokeStyle = colourRef.current;
      ctx.lineWidth = TRACE_WIDTH;
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
      ctx.miterLimit = 2;
      ctx.beginPath();
      for (let x = 0; x < columns; x += 1) {
        const index = start + Math.floor((x / (columns - 1)) * (span - 1));
        const value = buffer[index < count ? index : count - 1] as number;
        const y = mid - ((value - 128) / 128) * amplitude;
        const px = x + 0.5;
        if (x === 0) ctx.moveTo(px, y);
        else ctx.lineTo(px, y);
      }
      ctx.stroke();
    },
    [analyser, colourRef],
  );

  const canvasRef = useCanvasPainter(paint);

  return <CanvasFrame canvasRef={canvasRef} label="Waveform scope" />;
}
