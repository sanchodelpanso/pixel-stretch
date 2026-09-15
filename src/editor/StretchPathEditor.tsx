import { useCallback, useRef, useState } from 'react';
import type { Point } from '../types/stretch';
import { CanvasHandle } from './CanvasHandle';
import { pathToPolyline } from '../rendering/sample-path';

interface StretchPathEditorProps {
  points: Point[];
  /** On-screen size in CSS pixels. */
  viewWidth: number;
  viewHeight: number;
  docWidth: number;
  onChange: (points: Point[]) => void;
  /** Commit the path and move on to dragging the band out. */
  onLock: () => void;
}

/** A real control point, or the hollow midpoint that becomes one when dragged. */
type Grab =
  | { kind: 'point'; index: number }
  | { kind: 'midpoint'; index: number };

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Edits the sample path: the control points, the smooth curve through them,
 * and a hollow handle on each segment that turns into a new point when
 * dragged. The path only chooses which pixels get read — the band it produces
 * is always a straight rectangle.
 */
export function StretchPathEditor({
  points,
  viewWidth,
  viewHeight,
  docWidth,
  onChange,
  onLock,
}: StretchPathEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const grab = useRef<Grab | null>(null);
  const [hoverMid, setHoverMid] = useState<number | null>(null);

  const scale = viewWidth / docWidth;
  const toView = (p: Point) => ({ x: p.x * scale, y: p.y * scale });

  const toDoc = useCallback((clientX: number, clientY: number): Point | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect?.width) return null;
    const s = docWidth / rect.width;
    return { x: (clientX - rect.left) * s, y: (clientY - rect.top) * s };
  }, [docWidth]);

  const startGrab = useCallback((target: Grab) => (e: React.PointerEvent) => {
    // The canvas underneath would otherwise start drawing a new path.
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);

    if (target.kind === 'midpoint') {
      // Materialise the hollow handle into a real point, then drag that.
      const inserted = [...points];
      inserted.splice(target.index + 1, 0, midpoint(points[target.index], points[target.index + 1]));
      onChange(inserted);
      grab.current = { kind: 'point', index: target.index + 1 };
    } else {
      grab.current = target;
    }
  }, [points, onChange]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!grab.current) return;
    e.stopPropagation();
    const point = toDoc(e.clientX, e.clientY);
    if (!point) return;
    const next = [...points];
    next[grab.current.index] = point;
    onChange(next);
  }, [points, toDoc, onChange]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!grab.current) return;
    e.stopPropagation();
    grab.current = null;
  }, []);

  /** Double-clicking an interior point removes it again. */
  const removePoint = useCallback((index: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (points.length <= 2) return;
    if (index === 0 || index === points.length - 1) return;
    onChange(points.filter((_, i) => i !== index));
  }, [points, onChange]);

  const curve = pathToPolyline(points).map(toView);
  const viewPoints = points.map(toView);
  const last = viewPoints[viewPoints.length - 1];

  return (
    <svg
      ref={svgRef}
      className="stretch-path-editor"
      width={viewWidth}
      height={viewHeight}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <polyline
        className="path-curve-shadow"
        points={curve.map((p) => `${p.x},${p.y}`).join(' ')}
      />
      <polyline
        className="path-curve"
        points={curve.map((p) => `${p.x},${p.y}`).join(' ')}
      />

      {/* Hollow midpoint per segment — drag it to bend the path there. */}
      {points.slice(0, -1).map((p, i) => {
        const m = toView(midpoint(p, points[i + 1]));
        return (
          <CanvasHandle
            key={`mid-${i}`}
            className={`path-midpoint ${hoverMid === i ? 'hover' : ''}`}
            x={m.x} y={m.y} label="Drag to add a curve point"
            onPointerDown={startGrab({ kind: 'midpoint', index: i })}
            onPointerEnter={() => setHoverMid(i)}
            onPointerLeave={() => setHoverMid(null)}
          />
        );
      })}

      {viewPoints.map((p, i) => (
        <CanvasHandle
          key={`pt-${i}`}
          className="path-point"
          x={p.x} y={p.y} label="Drag to shape the sample path"
          onPointerDown={startGrab({ kind: 'point', index: i })}
          onDoubleClick={removePoint(i)}
        />
      ))}

      {/* Lock the shape and move on to pulling the band out. */}
      <g
        className="path-lock"
        transform={`translate(${last.x + 34}, ${last.y})`}
        role="button" tabIndex={0} aria-label="Finish sample path"
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onLock(); } }}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onLock();
        }}
      >
        <title>Finish sample path</title>
        <circle className="canvas-handle-hit" r={22} />
        <circle r={15} />
        <path className="path-lock-glyph" d="m-6 0 4 4L7-5" />
      </g>
    </svg>
  );
}
