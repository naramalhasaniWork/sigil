'use client';

import { useCallback, useEffect, useRef, type JSX } from 'react';
import {
  CANVAS_GRID,
  CANVAS_INK,
  CanvasFrame,
  paintBackdrop,
  useCanvasPainter,
  useCssColour,
  type CanvasPainter,
} from '@/ui/components/scope';

const MIN_HZ = 30;
const MAX_HZ = 18000;
const MAX_BARS = 64;
const MIN_BARS = 12;
/** Slot width in CSS pixels: bar plus gap. Chunky on purpose. */
const SLOT_PX = 14;
const BAR_GAP = 3;
const CAP_HEIGHT = 3;
/** Peak caps fall by this fraction of full scale per second. */
const CAP_FALL = 0.9;
const DECADES = [100, 1000, 10000] as const;

interface SpectrumProps {
  analyser: AnalyserNode | null;
  colour: string;
}

/** Log-frequency magnitude display: hard rectangles, visible gaps, ink peak caps. */
export function Spectrum({ analyser, colour }: SpectrumProps): JSX.Element {
  const bins = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const caps = useRef<Float32Array | null>(null);
  const colourRef = useCssColour(colour);

  useEffect(() => {
    bins.current = analyser === null ? null : new Uint8Array(analyser.frequencyBinCount);
    caps.current = new Float32Array(MAX_BARS);
  }, [analyser]);

  const paint = useCallback<CanvasPainter>(
    (ctx, width, height, dt) => {
      paintBackdrop(ctx, width, height, 0, 4);
      const buffer = bins.current;
      const peaks = caps.current;

      if (analyser === null || buffer === null || peaks === null || buffer.length < 2) {
        ctx.fillStyle = CANVAS_GRID;
        ctx.fillRect(0, height - CAP_HEIGHT, width, CAP_HEIGHT);
        return;
      }

      const binCount = Math.min(buffer.length, analyser.frequencyBinCount);
      const nyquist = analyser.context.sampleRate / 2;
      const hzPerBin = nyquist / binCount;
      const topHz = Math.min(MAX_HZ, nyquist);
      const ratio = topHz / MIN_HZ;
      const logRatio = Math.log(ratio);

      // Decade rules sit behind the bars, on the same log axis.
      ctx.fillStyle = CANVAS_GRID;
      for (let d = 0; d < DECADES.length; d += 1) {
        const hz = DECADES[d] as number;
        if (hz >= topHz) continue;
        ctx.fillRect(Math.round((Math.log(hz / MIN_HZ) / logRatio) * width), 0, 1, height);
      }

      analyser.getByteFrequencyData(buffer);

      const bars = Math.max(MIN_BARS, Math.min(MAX_BARS, Math.floor(width / SLOT_PX)));
      const slot = width / bars;
      const barWidth = Math.max(2, Math.floor(slot) - BAR_GAP);
      const usable = Math.max(1, height - CAP_HEIGHT - 1);
      const fall = CAP_FALL * dt;

      for (let b = 0; b < bars; b += 1) {
        const lowHz = MIN_HZ * Math.pow(ratio, b / bars);
        const highHz = MIN_HZ * Math.pow(ratio, (b + 1) / bars);
        let first = Math.floor(lowHz / hzPerBin);
        let last = Math.ceil(highHz / hzPerBin);
        if (first < 0) first = 0;
        if (last <= first) last = first + 1;
        if (last > binCount) last = binCount;

        let loudest = 0;
        for (let i = first; i < last; i += 1) {
          const value = buffer[i] as number;
          if (value > loudest) loudest = value;
        }
        const magnitude = loudest / 255;

        const previous = peaks[b] as number;
        const decayed = previous - fall;
        const held = magnitude > decayed ? magnitude : decayed;
        const cap = held > 0 ? held : 0;
        peaks[b] = cap;

        const x = Math.round(b * slot) + (BAR_GAP >> 1);
        const barHeight = Math.max(2, Math.round(magnitude * usable));
        ctx.fillStyle = colourRef.current;
        ctx.fillRect(x, height - barHeight, barWidth, barHeight);

        if (cap > 0.02) {
          const capY = height - CAP_HEIGHT - Math.round(cap * usable);
          ctx.fillStyle = CANVAS_INK;
          ctx.fillRect(x, capY, barWidth, CAP_HEIGHT);
        }
      }
    },
    [analyser, colourRef],
  );

  const canvasRef = useCanvasPainter(paint);

  return <CanvasFrame canvasRef={canvasRef} label="Frequency spectrum" />;
}
