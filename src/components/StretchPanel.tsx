import { useCallback, useRef } from 'react';
import type { Layer } from '../types/layer';
import type { StretchSpec } from '../types/stretch';
import { chordAngle, isWarped, hasCurvedEdges, NO_WARP, NO_EDGE_WARP } from '../types/stretch';
import { FULL_TURN, clampRadius, isClosedArc } from '../types/arc-band';
import { toRadians } from '../utils/math-utils';
import { pathToPolyline, polylineLength } from '../rendering/sample-path';
import { toDegrees } from '../utils/math-utils';
import './StretchPanel.css';

interface StretchPanelProps {
  layer: Layer;
  spec: StretchSpec;
  /** Name of the layer the band samples from, for the readout. */
  sourceName: string | null;
  maxLength: number;
  onChange: (patch: Partial<StretchSpec>, transient: boolean) => void;
  onBeginEdit: () => void;
  /** Reopen the sample path for editing. */
  onEditPath: () => void;
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onInput: (value: number, transient: boolean) => void;
  onBeginEdit: () => void;
}

function Slider({ label, value, min, max, step, format, onInput, onBeginEdit }: SliderProps) {
  // A pointer drag is one undo step; a click or arrow key is its own.
  const dragging = useRef(false);

  return (
    <label className="property-row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={() => {
          onBeginEdit();
          dragging.current = true;
        }}
        onPointerUp={() => {
          // onBeginEdit snapshotted the pre-drag state; committing again here
          // would add a second undo entry for one gesture.
          dragging.current = false;
        }}
        onChange={(e) => onInput(Number(e.target.value), dragging.current)}
      />
      <span className="property-value">{format(value)}</span>
    </label>
  );
}

/** Controls for the selected generative stretch layer. */
export function StretchPanel({
  layer,
  spec,
  sourceName,
  maxLength,
  onChange,
  onBeginEdit,
  onEditPath,
}: StretchPanelProps) {
  const arcLength = Math.round(polylineLength(pathToPolyline(spec.points)));
  const angle = Math.round(toDegrees(chordAngle(spec.points)));

  const flip = useCallback(() => {
    onChange({ length: -spec.length }, false);
  }, [spec.length, onChange]);

  if (spec.arc) {
    const arc = spec.arc;
    const closed = isClosedArc(arc);
    const turnSign = arc.sweep < 0 ? -1 : 1;
    const edgeKnots = (arc.inner?.length ?? 0) + (arc.outer?.length ?? 0);
    return (
      <section className="panel-section stretch-section">
        <div className="panel-section-title">
          Stretch <span className="stretch-badge">{layer.name}</span>
        </div>

        <div className="stretch-readout">
          <span>
            Path {arcLength}px · swept {closed ? 'into a ring' : `${Math.round(toDegrees(Math.abs(arc.sweep)))}°`}
          </span>
          {edgeKnots > 0 && (
            <span>Edges shaped by {edgeKnots} point{edgeKnots === 1 ? '' : 's'} · double-click one to remove it</span>
          )}
          {sourceName ? (
            <span>from {sourceName}</span>
          ) : (
            <span className="stretch-warning">source layer is gone</span>
          )}
        </div>

        <Slider
          label="Width" value={spec.width} min={1} max={Math.max(1, Math.round(arc.radius * 2))} step={1}
          format={(v) => `${Math.round(v)}px`}
          onInput={(v, t) => onChange({ width: v }, t)}
          onBeginEdit={onBeginEdit}
        />
        <Slider
          label="Radius" value={Math.round(arc.radius)}
          min={Math.ceil(Math.abs(spec.width) / 2)} max={Math.max(maxLength * 2, Math.round(arc.radius))} step={1}
          format={(v) => `${Math.round(v)}px`}
          onInput={(v, t) => onChange({ arc: { ...arc, radius: clampRadius(v, spec.width) } }, t)}
          onBeginEdit={onBeginEdit}
        />
        <Slider
          label="Sweep" value={Math.round(toDegrees(Math.abs(arc.sweep)))} min={1} max={360} step={1}
          format={(v) => `${Math.round(v)}°`}
          onInput={(v, t) => onChange({ arc: { ...arc, sweep: turnSign * toRadians(v) } }, t)}
          onBeginEdit={onBeginEdit}
        />
        <Slider
          label="Fade" value={spec.fade} min={0} max={1} step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onInput={(v, t) => onChange({ fade: v }, t)}
          onBeginEdit={onBeginEdit}
        />
        <Slider
          label="Softness" value={spec.edgeSoftness} min={0} max={0.5} step={0.005}
          format={(v) => `${Math.round(v * 100)}%`}
          onInput={(v, t) => onChange({ edgeSoftness: v }, t)}
          onBeginEdit={onBeginEdit}
        />

        <div className="stretch-actions">
          <button onClick={onEditPath}>Edit path</button>
          <button onClick={() => onChange({ arc: { ...arc, sweep: -arc.sweep } }, false)}>Flip direction</button>
          <button
            onClick={() => onChange({ arc: { ...arc, sweep: turnSign * (closed ? Math.PI : FULL_TURN) } }, false)}
          >
            {closed ? 'Open ring' : 'Close ring'}
          </button>
          <button
            disabled={edgeKnots === 0}
            onClick={() => onChange({ arc: { ...arc, inner: undefined, outer: undefined } }, false)}
          >
            Reset edges
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="panel-section stretch-section">
      <div className="panel-section-title">
        Stretch <span className="stretch-badge">{layer.name}</span>
      </div>

      <div className="stretch-readout">
        <span>
          Path {arcLength}px · {spec.points.length} point{spec.points.length === 1 ? '' : 's'} · {angle}°
        </span>
        {spec.rotation !== 0 && (
          <span>Rectangle turned {Math.round(toDegrees(spec.rotation))}° off the path</span>
        )}
        {spec.warpMode === 'curved' && (
          <span>Curved shape · round handles make a flat wave · corners keep the fold effect</span>
        )}
        {spec.warpMode !== 'curved' && isWarped(spec) && (
          <span>2D skew · drag any corner while the edges are straight</span>
        )}
        {sourceName ? (
          <span>from {sourceName}</span>
        ) : (
          <span className="stretch-warning">source layer is gone</span>
        )}
      </div>

      <Slider
        label="Width" value={spec.width} min={1} max={maxLength} step={1}
        format={(v) => `${Math.round(v)}px`}
        onInput={(v, t) => onChange({ width: v }, t)}
        onBeginEdit={onBeginEdit}
      />
      <Slider
        label="Length" value={spec.length} min={-maxLength} max={maxLength} step={1}
        format={(v) => `${Math.round(v)}px`}
        onInput={(v, t) => onChange({ length: v }, t)}
        onBeginEdit={onBeginEdit}
      />
      <Slider
        label="Rotate" value={Math.round(toDegrees(spec.rotation))} min={-180} max={180} step={1}
        format={(v) => `${Math.round(v)}°`}
        onInput={(v, t) => onChange({ rotation: toRadians(v) }, t)}
        onBeginEdit={onBeginEdit}
      />
      <Slider
        label="Fade" value={spec.fade} min={0} max={1} step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
        onInput={(v, t) => onChange({ fade: v }, t)}
        onBeginEdit={onBeginEdit}
      />
      <Slider
        label="Softness" value={spec.edgeSoftness} min={0} max={0.5} step={0.005}
        format={(v) => `${Math.round(v * 100)}%`}
        onInput={(v, t) => onChange({ edgeSoftness: v }, t)}
        onBeginEdit={onBeginEdit}
      />

      <div className="stretch-actions">
        <button onClick={onEditPath}>Edit path</button>
        <button onClick={flip}>Flip side</button>
        <button
          disabled={spec.rotation === 0}
          onClick={() => onChange({ rotation: 0 }, false)}
        >
          Unrotate
        </button>
        <button
          disabled={!isWarped(spec) && spec.bend === 0 && !hasCurvedEdges(spec)}
          onClick={() => onChange({ warp: NO_WARP, edges: NO_EDGE_WARP, bend: 0 }, false)}
        >
          Reset shape
        </button>
      </div>
    </section>
  );
}
