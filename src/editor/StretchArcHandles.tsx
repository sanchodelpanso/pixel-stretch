import { useCallback, useRef } from 'react';
import type { StretchSpec, Point } from '../types/stretch';
import type { ArcBand, ArcEdge, EdgeKnot } from '../types/arc-band';
import {
  arcCentre, arcEdgePoint, arcOutline, arcPoint, clampRadius, edgeInsertionPoints, edgeKnotAt,
  edgeOffset, isClosedArc, snapSweep, sweepToward,
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
  | { kind: 'knot'; edge: ArcEdge; index: number }
  | { kind: 'move'; last: Point };

/** Keeps a handle this far inside the view when its true spot is off-canvas. */
const EDGE_INSET = 18;

const EDGES: ArcEdge[] = ['inner', 'outer'];

/** Sort knots by `t`, reporting where the one at `index` ended up. */
function sortKnots(knots: EdgeKnot[], index: number): { knots: EdgeKnot[]; index: number } {
  const order = knots.map((knot, i) => ({ knot, i })).sort((a, b) => a.knot.t - b.knot.t);
  return { knots: order.map((entry) => entry.knot), index: order.findIndex((entry) => entry.i === index) };
}

function pathData(points: Point[], scale: number, close: boolean): string {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x * scale},${p.y * scale}`)
    .join(' ') + (close ? ' Z' : '');
}

/**
 * A swept band's handles: the centre sets the radius, the square at the start
 * edge's outer end sets the thickness, and the far end sets how far round it
 * goes — snapping shut into a ring near a full turn. Dragging the band itself
 * moves it off its path.
 *
 * Each edge also carries spline knots. Dragging a hollow marker on an edge
 * pulls a new knot out of it; double-clicking a knot removes it.
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

    if (drag.kind === 'knot') {
      const knots = [...(arc[drag.edge] ?? [])];
      knots[drag.index] = edgeKnotAt(arc, width, drag.edge, point);
      // A knot dragged past its neighbour simply swaps order with it.
      const sorted = sortKnots(knots, drag.index);
      drag.index = sorted.index;
      onChange({ arc: { ...arc, [drag.edge]: sorted.knots } }, true);
      return;
    }

    if (drag.kind === 'width') {
      const centre = arcCentre(arc);
      const distance = Math.hypot(point.x - centre.x, point.y - centre.y);
      // The handle rides the outer edge where it meets the start edge.
      const shaped = edgeOffset(arc.outer, 0, isClosedArc(arc));
      const next = Math.max(1, Math.min(2 * arc.radius, 2 * Math.abs(distance - arc.radius - shaped)));
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

  /** Pull a new knot out of an edge at `t`, exactly on the current curve. */
  const insertKnot = useCallback((edge: ArcEdge, t: number) => (e: React.PointerEvent) => {
    const knots = [...(arc[edge] ?? []), { t, offset: edgeOffset(arc[edge], t, isClosedArc(arc)) }];
    const sorted = sortKnots(knots, knots.length - 1);
    startDrag({ kind: 'knot', edge, index: sorted.index })(e);
    // The marker turns into a knot and unmounts mid-gesture, taking a capture
    // on itself with it; hold the gesture on the overlay instead.
    svgRef.current?.setPointerCapture(e.pointerId);
    onChange({ arc: { ...arc, [edge]: sorted.knots } }, true);
  }, [arc, startDrag, onChange]);

  const removeKnot = useCallback((edge: ArcEdge, index: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    const knots = (arc[edge] ?? []).filter((_, i) => i !== index);
    onChange({ arc: { ...arc, [edge]: knots.length ? knots : undefined } }, false);
  }, [arc, onChange]);

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

  const startInner = toView(arcEdgePoint(arc, width, 'inner', 0));
  const startOuter = toView(arcEdgePoint(arc, width, 'outer', 0));
  // Controls stand off past the outer end of the start edge, clear of the
  // centre handle however tight the curl.
  const unlockAt = {
    x: startOuter.x + Math.cos(arc.angle) * 34 - 14,
    y: startOuter.y + Math.sin(arc.angle) * 34 - 14,
  };
  const endMid = toView(arcPoint(arc, 0, 1));
  const widthAt = startOuter;
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

      {EDGES.flatMap((edge) => edgeInsertionPoints(arc, edge).map((t) => {
        const p = toView(arcEdgePoint(arc, width, edge, t));
        return (
          <rect
            key={`insert-${edge}-${t}`}
            className={`path-midpoint arc-edge-insert ${edge}`}
            x={p.x - 4.5} y={p.y - 4.5} width={9} height={9}
            transform={`rotate(45 ${p.x} ${p.y})`}
            onPointerDown={insertKnot(edge, t)}
          >
            <title>Drag to add a point to the {edge} edge</title>
          </rect>
        );
      }))}

      {EDGES.flatMap((edge) => (arc[edge] ?? []).map((knot, index) => {
        const p = toView(arcEdgePoint(arc, width, edge, knot.t));
        return (
          <circle
            key={`knot-${edge}-${index}`}
            className={`arc-knot ${edge}`}
            cx={p.x} cy={p.y} r={6}
            onPointerDown={startDrag({ kind: 'knot', edge, index })}
            onDoubleClick={removeKnot(edge, index)}
          >
            <title>Drag to reshape the {edge} edge · double-click to remove</title>
          </circle>
        );
      }))}

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
