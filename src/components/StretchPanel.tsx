import { useCallback, useRef } from 'react';
import type { Layer } from '../types/layer';
import type { StretchSpec } from '../types/stretch';
import { chordAngle, isWarped, hasCurvedEdges, NO_WARP, NO_EDGE_WARP } from '../types/stretch';
import { toRadians } from '../utils/math-utils';
import { pathToPolyline, polylineLength } from '../rendering/sample-path';
import { toDegrees } from '../utils/math-utils';
import { bendPreset } from '../types/stretch-presets';
import type { BendPreset } from '../types/stretch-presets';
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
  const arc = Math.round(polylineLength(pathToPolyline(spec.points)));
  const angle = Math.round(toDegrees(chordAngle(spec.points)));

  const flip = useCallback(() => {
    onChange({ length: -spec.length }, false);
  }, [spec.length, onChange]);

  const applyPreset = useCallback((preset: BendPreset) => {
    onChange(bendPreset(spec, preset), false);
  }, [spec, onChange]);

  return (
    <section className="panel-section stretch-section">
      <div className="panel-section-title">
        Stretch <span className="stretch-badge">{layer.name}</span>
      </div>

      <div className="stretch-readout">
        <span>
          Path {arc}px · {spec.points.length} point{spec.points.length === 1 ? '' : 's'} · {angle}°
        </span>
        {spec.rotation !== 0 && (
          <span>Rectangle turned {Math.round(toDegrees(spec.rotation))}° off the path</span>
        )}
        {spec.warpMode === 'curved' && (
          <span>Curved edges · drag the round handles to shape the bend</span>
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
      <div className="bend-controls">
        <div className="bend-controls-heading">
          <strong>3D Bend</strong>
          <span>Drag a corner to bend the sheet like paper. The other three corners stay pinned; the round handles then shape the bend.</span>
        </div>
        <div className="bend-presets" role="group" aria-label="3D bend presets">
          <button onClick={() => applyPreset('flat')}>Flat</button>
          <button onClick={() => applyPreset('cylinder')}>Cylinder</button>
          <button onClick={() => applyPreset('arc-left')}>Arc left</button>
          <button onClick={() => applyPreset('arc-right')}>Arc right</button>
          <button onClick={() => applyPreset('s-curve')}>S curve</button>
          <button onClick={() => applyPreset('taper')}>Taper</button>
        </div>
      </div>
      <Slider
        label="Wrap" value={spec.bend} min={-2} max={2} step={0.01}
        format={(v) => (v === 0 ? 'flat' : `${(1 / Math.abs(v)).toFixed(1)}×W`)}
        onInput={(v, t) => onChange({ bend: v }, t)}
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
          Reset 3D
        </button>
      </div>
    </section>
  );
}
