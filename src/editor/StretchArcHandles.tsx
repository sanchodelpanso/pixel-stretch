import { useCallback, useRef } from 'react';
import type { StretchSpec, Point } from '../types/stretch';
import type { ArcBand } from '../types/arc-band';
import {
  arcCentre, arcOutline, arcPoint, clampRadius, isClosedArc, snapSweep, sweepToward,
} from '../types/arc-band';
import { toDegrees } from '../utils/math-utils';

interface StretchArcHandlesProps {
  spec: StretchSpec;
  arc: ArcBand;
  docWidth: number;
  viewWidth: number;
  viewHeight: number;
  onChange: (patch: Partial<StretchSpec>, transient: boolean) => void;
  onBeginDrag: () => void;
  /** Reopen the path for editing. */
  onUnlock: () => void;
}

type Drag =
  | { kind: 'radius'; start: Point; radius: number }
  | { kind: 'width' }
  | { kind: 'sweep' }
  | { kind: 'move'; last: Point };

/** Keeps a handle this far inside the view when its true spot is off-canvas. */
const EDGE_INSET = 18;

function pathData(points: Point[], scale: number, close: boolean): string {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x * scale},${p.y * scale}`)
    .join(' ') + (close ? ' Z' : '');
}

/**
 * A swept band's handles: the centre sets the radius, the outer edge sets the
 * thickness, and the far end sets how far round it goes — snapping shut into a
 * ring near a full turn. Dragging the band itself moves it off its path.
 */
export function StretchArcHandles({
  spec,
  arc,
  docWidth,
  viewWidth,
  viewHeight,
  onChange,
  onBeginDrag,
  onUnlock,
}: StretchArcHandlesProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<Drag | null>(null);
  const scale = viewWidth / docWidth;
  const toView = (p: Point) => ({ x: p.x * scale, y: p.y * scale });

  const toDoc = useCallback((clientX: number, clientY: number): Point | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect?.width) return null;
    const s = docWidth / rect.width;
    return { x: (clientX - rect.left) * s, y: (clientY - rect.top) * s };
  }, [docWidth]);

  const startDrag = useCallback((drag: Drag) => (e: React.PointerEvent) => {
    // The canvas underneath would otherwise start drawing a new path.
    e.stopPropagation();
    e.preventDefault();
    dragging.current = drag;
    onBeginDrag();
    (e.target as Element).setPointerCapture(e.pointerId);
  }, [onBeginDrag]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragging.current;
    if (!drag) return;
    e.stopPropagation();
    const point = toDoc(e.clientX, e.clientY);
    if (!point) return;
    const width = Math.abs(spec.width);

    if (drag.kind === 'move') {
      onChange({
        arc: {
          ...arc,
          origin: { x: arc.origin.x + point.x - drag.last.x, y: arc.origin.y + point.y - drag.last.y },
        },
      }, true);
      drag.last = point;
      return;
    }

    if (drag.kind === 'radius') {
      // The centre slides along the spoke through the start edge; that edge
      // stays put, so the band curls tighter or looser in place. Relative to
      // where the drag began, so a handle pinned at the view edge still works.
      const spoke = { x: Math.cos(arc.angle), y: Math.sin(arc.angle) };
      const moved = (point.x - drag.start.x) * spoke.x + (point.y - drag.start.y) * spoke.y;
      onChange({ arc: { ...arc, radius: clampRadius(drag.radius - moved, width) } }, true);
      return;
    }

    if (drag.kind === 'width') {
      const centre = arcCentre(arc);
      const distance = Math.hypot(point.x - centre.x, point.y - centre.y);
      const next = Math.max(1, Math.min(2 * arc.radius, 2 * Math.abs(distance - arc.radius)));
      onChange({ width: Math.round(next) }, true);
      return;
    }

    const sweep = sweepToward(arc, point);
    // Never let the end cross back over the start and flip direction.
    const kept = Math.sign(sweep) === Math.sign(arc.sweep) || sweep === 0
      ? sweep
      : Math.sign(arc.sweep) * 1e-3;
    onChange({ arc: { ...arc, sweep: snapSweep(kept) } }, true);
  }, [arc, spec.width, toDoc, onChange]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    e.stopPropagation();
    dragging.current = null;
  }, []);

  const width = Math.abs(spec.width);
  const closed = isClosedArc(arc);
  const outline = arcOutline(arc, width, 128);
  const centre = arcCentre(arc);
  const centreView = toView(centre);
  const pinned = {
    x: Math.min(viewWidth - EDGE_INSET, Math.max(EDGE_INSET, centreView.x)),
    y: Math.min(viewHeight - EDGE_INSET, Math.max(EDGE_INSET, centreView.y)),
  };
  const centreOffCanvas = pinned.x !== centreView.x || pinned.y !== centreView.y;

  const startInner = toView(arcPoint(arc, -width / 2, 0));
  const startOuter = toView(arcPoint(arc, width / 2, 0));
  // Controls stand off past the outer end of the start edge, clear of the
  // centre handle however tight the curl.
  const unlockAt = {
    x: startOuter.x + Math.cos(arc.angle) * 26 - 14,
    y: startOuter.y + Math.sin(arc.angle) * 26 - 14,
  };
  const endMid = toView(arcPoint(arc, 0, 1));
  const widthAt = toView(arcPoint(arc, width / 2, 0.5));
  const guide = toView(arcPoint(arc, 0, 0.5));
  const degrees = Math.round(toDegrees(Math.abs(arc.sweep)));

  return (
    <svg
      ref={svgRef}
      className="stretch-rect-handles stretch-arc-handles"
      width={viewWidth}
      height={viewHeight}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <path
        className="rect-outline"
        d={outline.map((loop) => pathData(loop, scale, true)).join(' ')}
        fillRule="evenodd"
        onPointerDown={(e) => {
          const point = toDoc(e.clientX, e.clientY);
          if (point) startDrag({ kind: 'move', last: point })(e);
        }}
      />
      <path className="arc-centreline" d={pathData(
        Array.from({ length: 97 }, (_, i) => arcPoint(arc, 0, i / 96)), scale, false,
      )} />
      {/* Where the pixels came from. */}
      <line className="rect-source-line" x1={startInner.x} y1={startInner.y} x2={startOuter.x} y2={startOuter.y} />

      {!centreOffCanvas && (
        <line className="arc-spoke" x1={centreView.x} y1={centreView.y} x2={startOuter.x} y2={startOuter.y} />
      )}
      {!centreOffCanvas && !closed && (
        <line className="arc-spoke" x1={centreView.x} y1={centreView.y} x2={endMid.x} y2={endMid.y} />
      )}
      <line className="arc-spoke" x1={guide.x} y1={guide.y} x2={widthAt.x} y2={widthAt.y} />

      <g
        className={`arc-radius-handle ${centreOffCanvas ? 'pinned' : ''}`}
        transform={`translate(${pinned.x}, ${pinned.y})`}
        onPointerDown={(e) => {
          const point = toDoc(e.clientX, e.clientY);
          if (point) startDrag({ kind: 'radius', start: point, radius: arc.radius })(e);
        }}
      >
        <title>Radius — drag toward the band to curl it tighter</title>
        <circle r={9} />
        <circle className="arc-radius-dot" r={2.5} />
      </g>

      <rect
        className="rect-handle arc-width-handle"
        x={widthAt.x - 6} y={widthAt.y - 6} width={12} height={12}
        onPointerDown={startDrag({ kind: 'width' })}
      >
        <title>Width — drag across the band</title>
      </rect>

      <circle
        className={`arc-sweep-handle ${closed ? 'closed' : ''}`}
        cx={endMid.x}
        cy={endMid.y}
        r={closed ? 11 : 8}
        onPointerDown={startDrag({ kind: 'sweep' })}
      >
        <title>{closed ? 'Ring — drag back to open it' : 'Sweep — drag round to the start to close a ring'}</title>
      </circle>

      <g className="rect-badge" transform={`translate(${unlockAt.x + 36}, ${unlockAt.y - 12})`}>
        <rect x={0} y={0} width={104} height={52} rx={8} />
        <text x={11} y={16}>R: {Math.round(arc.radius)} px</text>
        <text x={11} y={30}>W: {Math.round(width)} px</text>
        <text x={11} y={44}>{degrees >= 360 ? 'Ring 360°' : `${degrees}°`}</text>
      </g>

      <g
        className="rect-unlock"
        transform={`translate(${unlockAt.x}, ${unlockAt.y})`}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onUnlock();
        }}
      >
        <rect x={0} y={0} width={28} height={28} rx={7} />
        <g transform="translate(7, 7)" className="rect-unlock-glyph">
          <rect x={1.5} y={6} width={11} height={7.5} rx={1.5} />
          <path d="M4 6V4a3 3 0 0 1 5.8-1" />
        </g>
      </g>
    </svg>
  );
}
