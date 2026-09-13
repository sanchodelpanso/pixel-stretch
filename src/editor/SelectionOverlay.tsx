import { useEffect, useRef } from 'react';

interface SelectionOverlayProps {
  /** Soft mask in the source layer's pixel space. */
  mask: Float32Array;
  maskWidth: number;
  maskHeight: number;
  /** Where the source layer sits in the document. */
  layerWidth: number;
  layerHeight: number;
  offsetX: number;
  offsetY: number;
  docWidth: number;
  docHeight: number;
  /** On-screen size in CSS pixels. */
  viewWidth: number;
  viewHeight: number;
}

/** Anything above this alpha is drawn as selected. */
const TINT_THRESHOLD = 0.5;

/**
 * Tints the selected pixels so it's obvious what "extract to layer" will take.
 * Sits above the composited canvas and swallows no pointer events.
 */
export function SelectionOverlay({
  mask,
  maskWidth,
  maskHeight,
  layerWidth,
  layerHeight,
  offsetX,
  offsetY,
  docWidth,
  docHeight,
  viewWidth,
  viewHeight,
}: SelectionOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !docWidth || !docHeight) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(viewWidth * dpr);
    canvas.height = Math.round(viewHeight * dpr);

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Paint the mask at its own resolution, then scale it into place.
    const tint = document.createElement('canvas');
    tint.width = maskWidth;
    tint.height = maskHeight;
    const tctx = tint.getContext('2d')!;
    const pixels = tctx.createImageData(maskWidth, maskHeight);
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] < TINT_THRESHOLD) continue;
      const o = i * 4;
      pixels.data[o] = 255;
      pixels.data[o + 1] = 255;
      pixels.data[o + 2] = 255;
      pixels.data[o + 3] = 72;
    }
    tctx.putImageData(pixels, 0, 0);

    const scale = (viewWidth / docWidth) * dpr;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tint, offsetX, offsetY, layerWidth, layerHeight);
  }, [mask, maskWidth, maskHeight, layerWidth, layerHeight, offsetX, offsetY, docWidth, docHeight, viewWidth, viewHeight]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: viewWidth,
        height: viewHeight,
        pointerEvents: 'none',
      }}
    />
  );
}
