import { useCallback, useRef } from 'react';
import type { StretchSpec, Point } from '../types/stretch';
import type { EdgeWarp } from '../types/stretch';
import {
  rectBasis, rectCenter, anchorForCentre, chordAngle,
  toEdgeOffset, isWarped, edgeCurves, pullCorner, skewCorner, NO_EDGE_WARP,
} from '../types/stretch';
import { bendPoint } from '../rendering/projection';
import { bandSurface } from '../rendering/surface';
import { clamp } from '../utils/math-utils';

/** Which edges a handle moves, in the rectangle's own frame. */
type HandleId =
  | 'nw' | 'n' | 'ne'
  | 'w' | 'e'
  | 'sw' | 's' | 'se';

/** Rotation snaps to this many degrees while shift is held. */
const SNAP_DEGREES = 15;

interface StretchRectHandlesProps {
  spec: StretchSpec;
  docWidth: number;
  viewWidth: number;
  viewHeight: number;
  onChange: (patch: Partial<StretchSpec>, transient: boolean) => void;
  onBeginDrag: () => void;
  /** Reopen the path for editing. */
  onUnlock: () => void;
}

/** Each edge's two Bézier controls, as flat descriptors for rendering. */
interface EdgeControlHandle {
  edge: number;
  control: 0 | 1;
  at: Point;
  /** The corner the tangent line runs back to. */
  anchor: Point;
}

/** Corner handles, in the order `bandCorners` returns them. */
const CORNER_ORDER: Record<string, number> = { nw: 0, ne: 1, se: 2, sw: 3 };

/** Handle position in normalised rect space, and which axes it drives. */
const HANDLES: Record<HandleId, { u: number; v: number; movesW: boolean; movesL: boolean }> = {
  nw: { u: 0, v: 0, movesW: true, movesL: true },
  n: { u: 0.5, v: 0, movesW: false, movesL: true },
  ne: { u: 1, v: 0, movesW: true, movesL: true },
  w: { u: 0, v: 0.5, movesW: true, movesL: false },
  e: { u: 1, v: 0.5, movesW: true, movesL: false },
  sw: { u: 0, v: 1, movesW: true, movesL: true },
  s: { u: 0.5, v: 1, movesW: false, movesL: true },
  se: { u: 1, v: 1, movesW: true, movesL: true },
};

/**
 * The locked band's transform box: eight handles in the rectangle's own
 * rotated frame, plus a live size readout. Dragging an edge moves only that
 * edge, so the opposite one stays put; dragging a corner bends the sheet, and
 * each edge's two round handles then reshape the bend.
 */
export function StretchRectHandles({
  spec,
  docWidth,
  viewWidth,
  viewHeight,
  onChange,
  onBeginDrag,
  onUnlock,
}: StretchRectHandlesProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  type Drag =
    | { kind: 'handle'; id: HandleId }
    | { kind: 'warp'; corner: number }
    | { kind: 'edge'; edge: number; control: 0 | 1 }
    | { kind: 'bend'; start: Point; initial: number }
    | { kind: 'move'; last: Point }
    | { kind: 'rotate' };
  const dragging = useRef<Drag | null>(null);

  const scale = viewWidth / docWidth;
  const toView = (p: Point) => ({ x: p.x * scale, y: p.y * scale });
  const { along, out } = rectBasis(spec);

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

    if (drag.kind === 'move') {
      // Only the rectangle moves; the path keeps sampling where it was.
      onChange({
        anchor: {
          x: spec.anchor.x + (point.x - drag.last.x),
          y: spec.anchor.y + (point.y - drag.last.y),
        },
      }, true);
      drag.last = point;
      return;
    }

    if (drag.kind === 'warp') {
      onChange(
        spec.warpMode === 'curved'
          ? pullCorner(spec, drag.corner, point)
          : skewCorner(spec, drag.corner, point),
        true,
      );
      return;
    }

    if (drag.kind === 'edge') {
      const edges = (spec.edges ?? NO_EDGE_WARP).map((e) => [...e]) as EdgeWarp;
      edges[drag.edge][drag.control] = toEdgeOffset(spec, drag.edge, drag.control, point);
      onChange({ edges, warpMode: 'curved' }, true);
      return;
    }

    if (drag.kind === 'bend') {
      const side = spec.length < 0 ? -1 : 1;
      const dx = point.x - drag.start.x;
      const dy = point.y - drag.start.y;
      const distance = (dx * out.x + dy * out.y) * side;
      const sensitivity = Math.max(Math.abs(spec.length) * 0.14, 24);
      onChange({ bend: clamp(drag.initial + distance / sensitivity, -2, 2) }, true);
      return;
    }

    if (drag.kind === 'rotate') {
      const centre = rectCenter(spec);
      // The grip stands off the rectangle's -out side, a quarter turn ahead
      // of its `along` axis, so back that quarter turn out of the cursor angle.
      let angle = Math.atan2(point.y - centre.y, point.x - centre.x) - Math.PI / 2;
      if (e.shiftKey) {
        const step = (SNAP_DEGREES * Math.PI) / 180;
        angle = Math.round(angle / step) * step;
      }
      const rotation = angle - chordAngle(spec.points);
      onChange({ rotation, anchor: anchorForCentre(spec, centre, rotation) }, true);
      return;
    }

    const handle = HANDLES[drag.id];
    // Pointer position in the rectangle's own frame, relative to the anchor.
    const rel = { x: point.x - spec.anchor.x, y: point.y - spec.anchor.y };
    const u = rel.x * along.x + rel.y * along.y;
    const v = rel.x * out.x + rel.y * out.y;

    const patch: Partial<StretchSpec> = {};
    let anchor = { ...spec.anchor };

    if (handle.movesW) {
      if (handle.u === 0) {
        // Dragging the near edge moves the anchor and shrinks the span.
        patch.width = spec.width - u;
        anchor = { x: anchor.x + along.x * u, y: anchor.y + along.y * u };
      } else {
        patch.width = u;
      }
    }
    if (handle.movesL) {
      if (handle.v === 0) {
        patch.length = spec.length - v;
        anchor = { x: anchor.x + out.x * v, y: anchor.y + out.y * v };
      } else {
        patch.length = v;
      }
    }
    if (anchor.x !== spec.anchor.x || anchor.y !== spec.anchor.y) patch.anchor = anchor;

    onChange(patch, true);
  }, [spec, along, out, toDoc, onChange]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    e.stopPropagation();
    // onBeginDrag already snapshotted the pre-drag state for undo.
    dragging.current = null;
  }, []);

  const curvedMode = spec.warpMode === 'curved';
  const curves = edgeCurves(spec);

  const surfaceAt = bandSurface(spec);
  const projectedPoint = (u: number, v: number): Point => {
    const uv = bendPoint(u, v, spec.bend);
    return surfaceAt(uv.x, uv.y);
  };

  // Sample the same surface as the renderer for both the outline and the
  // grid lines at the thirds. More samples smooth the curves, not the grid.
  const boundarySteps = 32;
  const outlinePoints: Point[] = [];
  for (let i = 0; i <= boundarySteps; i++) outlinePoints.push(projectedPoint(i / boundarySteps, 0));
  for (let i = 1; i <= boundarySteps; i++) outlinePoints.push(projectedPoint(1, i / boundarySteps));
  for (let i = 1; i <= boundarySteps; i++) outlinePoints.push(projectedPoint(1 - i / boundarySteps, 1));
  for (let i = 1; i < boundarySteps; i++) outlinePoints.push(projectedPoint(0, 1 - i / boundarySteps));
  const outlinePath = outlinePoints
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x * scale},${point.y * scale}`)
    .join(' ') + ' Z';
  const sourcePath = Array.from({ length: boundarySteps + 1 }, (_, i) => projectedPoint(i / boundarySteps, 0))
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x * scale},${point.y * scale}`)
    .join(' ');
  const gridLines = [
    ...Array.from({ length: 2 }, (_, index) => {
      const u = (index + 1) / 3;
      return Array.from({ length: boundarySteps + 1 }, (_, i) => projectedPoint(u, i / boundarySteps));
    }),
    ...Array.from({ length: 2 }, (_, index) => {
      const v = (index + 1) / 3;
      return Array.from({ length: boundarySteps + 1 }, (_, i) => projectedPoint(i / boundarySteps, v));
    }),
  ];

  /** The eight edge controls, each paired with the corner it hangs off. */
  const edgeHandles: EdgeControlHandle[] = curvedMode
    ? curves.flatMap((edge, i) => [
        { edge: i, control: 0 as const, at: edge[1], anchor: edge[0] },
        { edge: i, control: 1 as const, at: edge[2], anchor: edge[3] },
      ])
    : [];

  const badgeAt = toView(projectedPoint(0.5, 0));
  const unlockAt = toView(projectedPoint(0, 0));
  const depthBase = surfaceAt(0.5, 0.5);
  const depthAt = projectedPoint(0.5, 0.5);
  const depthBaseView = toView(depthBase);
  const depthView = toView(depthAt);
  // Rotate grip stands off the edge the badge sits on, clear of the handles.
  const rotateAt = {
    x: badgeAt.x - out.x * 34 * (spec.length < 0 ? -1 : 1),
    y: badgeAt.y - out.y * 34 * (spec.length < 0 ? -1 : 1),
  };

  return (
    <svg
      ref={svgRef}
      className="stretch-rect-handles"
      width={viewWidth}
      height={viewHeight}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <path
        className={`rect-outline ${isWarped(spec) || curvedMode ? 'warped' : ''}`}
        d={outlinePath}
        onPointerDown={(e) => {
          const point = toDoc(e.clientX, e.clientY);
          if (point) startDrag({ kind: 'move', last: point })(e);
        }}
      />
      <g className="rect-grid" aria-hidden="true">
        {gridLines.map((line, index) => (
          <path
            key={index}
            d={line.map((point, pointIndex) => {
              const viewPoint = toView(point);
              return `${pointIndex === 0 ? 'M' : 'L'} ${viewPoint.x},${viewPoint.y}`;
            }).join(' ')}
          />
        ))}
      </g>
      {/* Where the pixels came from. */}
      <path
        className="rect-source-line"
        d={sourcePath}
        fill="none"
      />

      {edgeHandles.map((h) => {
        const a = toView(h.anchor);
        const p = toView(h.at);
        return (
          <line
            key={`tan-${h.edge}-${h.control}`}
            className="edge-tangent"
            x1={a.x} y1={a.y} x2={p.x} y2={p.y}
          />
        );
      })}

      {edgeHandles.map((h) => {
        const p = toView(h.at);
        return (
          <circle
            key={`ctrl-${h.edge}-${h.control}`}
            className="edge-control"
            cx={p.x} cy={p.y} r={6}
            onPointerDown={startDrag({ kind: 'edge', edge: h.edge, control: h.control })}
            onDoubleClick={(e) => {
              e.stopPropagation();
              const edges = (spec.edges ?? NO_EDGE_WARP).map((x) => [...x]) as EdgeWarp;
              edges[h.edge][h.control] = { u: 0, v: 0 };
              onChange({ edges }, false);
            }}
          />
        );
      })}

      {(Object.keys(HANDLES) as HandleId[]).map((id) => {
        const { u, v } = HANDLES[id];
        const p = toView(projectedPoint(u, v));
        return (
          <rect
            key={id}
            className="rect-handle"
            x={p.x - 5} y={p.y - 5} width={10} height={10}
            onPointerDown={(e) => {
              const cornerIndex = CORNER_ORDER[id];
              startDrag(cornerIndex === undefined
                ? { kind: 'handle', id }
                : { kind: 'warp', corner: cornerIndex })(e);
            }}
          />
        );
      })}

      <line
        className="bend-depth-stem"
        x1={depthBaseView.x} y1={depthBaseView.y}
        x2={depthView.x} y2={depthView.y}
      />
      <g
        className={`bend-depth ${spec.bend !== 0 ? 'active' : ''}`}
        transform={`translate(${depthView.x}, ${depthView.y})`}
        onPointerDown={(e) => {
          const point = toDoc(e.clientX, e.clientY);
          if (point) startDrag({ kind: 'bend', start: point, initial: spec.bend })(e);
        }}
      >
        <title>Drag along the band to adjust 3D depth</title>
        <circle r={12} />
        <path d="M-6,2 C-3,-4 3,-4 6,2 M-5,5 C-2,1 2,1 5,5" />
      </g>

      <line className="rect-rotate-stem" x1={badgeAt.x} y1={badgeAt.y} x2={rotateAt.x} y2={rotateAt.y} />
      <g
        className="rect-rotate"
        transform={`translate(${rotateAt.x}, ${rotateAt.y})`}
        onPointerDown={startDrag({ kind: 'rotate' })}
      >
        <circle r={11} />
        <path d="M-4.5,-1.5 A4.5,4.5 0 1 1 -1.5,4.3" />
        <path d="M-7,-3.4 L-4.5,-1.2 L-2.1,-3.9" />
      </g>

      <g className="rect-badge" transform={`translate(${badgeAt.x + 14}, ${badgeAt.y - 40})`}>
        <rect x={0} y={0} width={92} height={38} rx={8} />
        <text x={11} y={16}>W: {Math.round(Math.abs(spec.width))} px</text>
        <text x={11} y={30}>H: {Math.round(Math.abs(spec.length))} px</text>
      </g>

      <g
        className={`rect-mode ${curvedMode ? 'on' : ''}`}
        transform={`translate(${unlockAt.x - 36}, ${unlockAt.y + 20})`}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onChange({
            warpMode: curvedMode ? 'straight' : 'curved',
            // Enter either shape mode on a flat 2D surface. The dedicated
            // canvas depth grip can still add the cylindrical effect directly.
            bend: 0,
          }, false);
        }}
      >
        <title>{curvedMode
          ? 'Curved shape — click for straight 2D skew'
          : 'Straight 2D skew — click for curved wave controls'}</title>
        <rect x={0} y={0} width={28} height={28} rx={7} />
        <g transform="translate(6, 7)" className="rect-mode-glyph">
          {curvedMode
            ? <path d="M0,11 C4,11 4,3 8,3 C12,3 12,11 16,11" />
            : <path d="M0,11 L16,3" />}
        </g>
      </g>

      <g
        className="rect-unlock"
        transform={`translate(${unlockAt.x - 36}, ${unlockAt.y - 14})`}
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
