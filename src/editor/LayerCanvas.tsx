import { useEffect, useRef } from 'react';
import type { LayerDocument } from '../types/layer';

interface LayerCanvasProps {
  doc: LayerDocument;
  /** On-screen size in CSS pixels. */
  viewWidth: number;
  viewHeight: number;
}

/** Transparency checkerboard, drawn once and reused as a fill pattern. */
function checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const tile = document.createElement('canvas');
  tile.width = 16;
  tile.height = 16;
  const tctx = tile.getContext('2d')!;
  tctx.fillStyle = '#1b1b20';
  tctx.fillRect(0, 0, 16, 16);
  tctx.fillStyle = '#232329';
  tctx.fillRect(0, 0, 8, 8);
  tctx.fillRect(8, 8, 8, 8);
  return ctx.createPattern(tile, 'repeat');
}

/**
 * Renders the composited layer stack. Everything above it — selection
 * overlays, handles — is positioned by the editor in the same wrapper.
 */
export function LayerCanvas({ doc, viewWidth, viewHeight }: LayerCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !doc.width || !doc.height) return;

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(viewWidth * dpr);
      canvas.height = Math.round(viewHeight * dpr);

      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const pattern = checkerPattern(ctx);
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      // Map document pixels onto the fitted, device-scaled canvas.
      const scale = (viewWidth / doc.width) * dpr;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.imageSmoothingQuality = 'high';

      // Composite without clearing — the checkerboard must show through.
      for (const layer of doc.layers) {
        if (!layer.visible || layer.opacity <= 0) continue;
        ctx.globalAlpha = layer.opacity;
        ctx.drawImage(layer.canvas, layer.x, layer.y);
      }
      ctx.globalAlpha = 1;
    });

    return () => cancelAnimationFrame(rafRef.current);
  }, [doc, viewWidth, viewHeight]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: viewWidth, height: viewHeight, display: 'block' }}
    />
  );
}
