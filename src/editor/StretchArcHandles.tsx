import { useCallback, useRef, useState } from 'react';
import type { StretchSpec, Point } from '../types/stretch';
import type { ArcBand, ArcEdge, EdgeKnot } from '../types/arc-band';
import {
  arcCentre, arcEdgePoint, arcOutline, arcPoint, clampRadius, edgeInsertionPoints, edgeKnotAt,
  edgeOffset, isClosedArc, snapSweep, sweepToward,
} from '../types/arc-band';
import { useDoubleTap } from './useDoubleTap';
import { CanvasHandle } from './CanvasHandle';
import type { StretchControl } from '../components/StretchTools';
import { ColorSimplifyGrip } from './ColorSimplifyGrip';

interface StretchArcHandlesProps {
  spec: StretchSpec;
  arc: ArcBand;
  docWidth: number;
  viewWidth: number;
  viewHeight: number;
  onChange: (patch: Partial<StretchSpec>, transient: boolean) => void;
  onBeginDrag: () => void;
  onOpenProperties: () => void;
  control: StretchControl;
}

type Drag =
  | { kind: 'radius'; start: Point; radius: number }
  | { kind: 'width' }
  | { kind: 'sweep' }
  | { kind: 'knot'; edge: ArcEdge; index: number }
  | { kind: 'move'; last: Point; started: boolean };

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
  onOpenProperties,
  control,
}: StretchArcHandlesProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const doubleTap = useDoubleTap(onOpenProperties);
  const dragging = useRef<Drag | null>(null);
  const [isDragging, setIsDragging] = useState(false);
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
    if (drag.kind !== 'move') { onBeginDrag(); setIsDragging(true); }
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
      // A tap opens no undo entry and small touch jitter must not move the band.
      if (!drag.started) {
        if (Math.hypot(point.x - drag.last.x, point.y - drag.last.y) * scale <= 8) return;
        onBeginDrag();
        drag.started = true;
        setIsDragging(true);
      }
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
  }, [arc, spec.width, toDoc, onChange, scale, onBeginDrag]);

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
    setIsDragging(false);
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
  const endMid = toView(arcPoint(arc, 0, 1));
  const widthAt = startOuter;

  return (
    <svg
      ref={svgRef}
      className={`stretch-rect-handles stretch-arc-handles ${isDragging ? 'is-dragging' : ''}`}
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
          doubleTap.onPointerDown(e);
          if (point) startDrag({ kind: 'move', last: point, started: false })(e);
        }}
        onPointerMove={doubleTap.onPointerMove}
        onPointerUp={doubleTap.onPointerUp}
        onPointerCancel={doubleTap.onPointerCancel}
        role="button"
        tabIndex={0}
        aria-label="Stretch properties"
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpenProperties();
          }
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

      <CanvasHandle
        className={`arc-radius-handle ${centreOffCanvas ? 'pinned' : ''}`}
        x={pinned.x} y={pinned.y} shape="pivot"
        label="Drag toward the band to curl it tighter"
        onPointerDown={(e) => {
          const point = toDoc(e.clientX, e.clientY);
          if (point) startDrag({ kind: 'radius', start: point, radius: arc.radius })(e);
        }}
      />


      {control === 'edges' && EDGES.flatMap((edge) => edgeInsertionPoints(arc, edge).map((t) => {
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

      {control === 'edges' && EDGES.flatMap((edge) => (arc[edge] ?? []).map((knot, index) => {
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

      <CanvasHandle
        className="rect-handle arc-width-handle"
        x={widthAt.x} y={widthAt.y} shape="edge"
        angle={arc.angle * 180 / Math.PI + 90}
        onPointerDown={startDrag({ kind: 'width' })}
        label="Drag across the band to adjust width"
      />

      <CanvasHandle
        className={`arc-sweep-handle ${closed ? 'closed' : ''}`}
        x={endMid.x} y={endMid.y}
        onPointerDown={startDrag({ kind: 'sweep' })}
        label={closed ? 'Drag back to open the ring' : 'Drag around to the start to close a ring'}
      />

      {control === 'colors' && (
        <ColorSimplifyGrip spec={spec} at={toView(arcPoint(arc, 0, 0.5))} onChange={onChange} onBeginDrag={onBeginDrag} />
      )}
    </svg>
  );
}
