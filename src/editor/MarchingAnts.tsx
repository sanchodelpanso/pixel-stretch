import { useEffect, useRef } from 'react';
import type { BBox } from '../types/segmentation';

interface MarchingAntsProps {
  /** Normalized bounding box (top-left origin, 0–1 fractions). */
  bbox: BBox;
  /** Canvas width in CSS pixels. */
  width: number;
  /** Canvas height in CSS pixels. */
  height: number;
}

/**
 * Animated dotted rectangle around the detected subject.
 * Port of the SwiftUI MarchingAnts view.
 */
export function MarchingAnts({ bbox, width, height }: MarchingAntsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const pad = 10;
    const rect = {
      x: bbox.x * width - pad,
      y: bbox.y * height - pad,
      w: bbox.w * width + pad * 2,
      h: bbox.h * height + pad * 2,
    };

    let startTime = performance.now();

    function draw(now: number) {
      const elapsed = (now - startTime) / 1000;
      const phase = (elapsed * 24) % 12;

      ctx.clearRect(0, 0, width, height);

      // Black dashes (offset)
      ctx.setLineDash([6, 6]);
      ctx.lineDashOffset = -(phase + 6);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

      // White dashes
      ctx.lineDashOffset = -phase;
      ctx.strokeStyle = 'white';
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(rafRef.current);
  }, [bbox, width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width,
        height,
        pointerEvents: 'none',
      }}
    />
  );
}
