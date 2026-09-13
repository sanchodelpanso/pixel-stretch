import { useRef, useCallback, useState, useEffect, useLayoutEffect } from 'react';
import './BrushTool.css';

interface BrushToolProps {
  /** Canvas width in CSS pixels. */
  width: number;
  /** Canvas height in CSS pixels. */
  height: number;
  /** Image dimensions for mask output. */
  imageWidth: number;
  imageHeight: number;
  /** Called when user finishes painting. */
  onBrushComplete: (mask: Uint8Array, width: number, height: number) => void;
  /** Whether brush tool is active. */
  active: boolean;
}

/**
 * Canvas overlay for painting a rough selection mask.
 * The painted region is sent to SAM as a box prompt for refinement.
 */
export function BrushTool({
  width,
  height,
  imageWidth,
  imageHeight,
  onBrushComplete,
  active,
}: BrushToolProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawing = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const [brushSize, setBrushSize] = useState(30);
  const [isEraser, setIsEraser] = useState(false);

  // Size the newly mounted canvas before the first stroke can reach it.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
  }, [width, height, active]);

  const getPos = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  const drawStroke = useCallback((x: number, y: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    if (isEraser) {
      ctx.globalCompositeOperation = 'destination-out';
    } else {
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = brushSize;
    ctx.lineCap = 'round';
    if (lastPoint.current) {
      ctx.beginPath();
      ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    lastPoint.current = { x, y };
    ctx.beginPath();
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
  }, [brushSize, isEraser]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!active) return;
    e.stopPropagation();
    lastPoint.current = null;
    isDrawing.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const { x, y } = getPos(e);
    drawStroke(x, y);
  }, [active, getPos, drawStroke]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDrawing.current) return;
    const { x, y } = getPos(e);
    drawStroke(x, y);
  }, [getPos, drawStroke]);

  const handlePointerUp = useCallback(() => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    lastPoint.current = null;

    // Extract the painted mask
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Downscale to image dimensions
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = imageWidth;
    tempCanvas.height = imageHeight;
    const tctx = tempCanvas.getContext('2d')!;
    tctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, imageWidth, imageHeight);
    const scaled = tctx.getImageData(0, 0, imageWidth, imageHeight);

    // Extract alpha channel as mask
    const mask = new Uint8Array(imageWidth * imageHeight);
    for (let i = 0; i < mask.length; i++) {
      mask[i] = scaled.data[i * 4 + 3]; // Alpha channel
    }

    onBrushComplete(mask, imageWidth, imageHeight);
  }, [imageWidth, imageHeight, onBrushComplete]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setBrushSize((prev) => Math.max(5, Math.min(200, prev - e.deltaY * 0.5)));
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Alt') setIsEraser(true);
  }, []);

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Alt') setIsEraser(false);
  }, []);

  useEffect(() => {
    if (!active) return;
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [active, handleKeyDown, handleKeyUp]);

  const clearBrush = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
      onBrushComplete(new Uint8Array(imageWidth * imageHeight), imageWidth, imageHeight);
  }, [imageWidth, imageHeight, onBrushComplete]);

  if (!active) return null;

  return (
    <div className="brush-tool-container">
      <canvas
        ref={canvasRef}
        className="brush-canvas"
        style={{
          width,
          height,
          cursor: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${brushSize}' height='${brushSize}'%3E%3Ccircle cx='${brushSize / 2}' cy='${brushSize / 2}' r='${brushSize / 2 - 1}' fill='none' stroke='white' stroke-width='1.5'/%3E%3C/svg%3E") ${brushSize / 2} ${brushSize / 2}, crosshair`,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => { isDrawing.current = false; lastPoint.current = null; }}
        onWheel={handleWheel}
      />
      <div className="brush-controls">
        <label>
          Size: {brushSize}px
          <input
            type="range"
            min={5}
            max={200}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
          />
        </label>
        <button onClick={clearBrush} className="brush-clear-btn">
          Clear
        </button>
        <span className="brush-hint">
          {isEraser ? '🧹 Eraser (release Alt)' : '🖌️ Brush (hold Alt for eraser)'}
        </span>
      </div>
    </div>
  );
}
