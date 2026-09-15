import { useRef, useState } from 'react';
import type { Point, StretchSpec } from '../types/stretch';
import { DEFAULT_MOTION_SCATTER, DEFAULT_MOTION_SOFTNESS } from '../rendering/motion-streaks';
import {
  DEFAULT_PIXEL_SCATTER, DEFAULT_PIXEL_SIZE, MAX_PIXEL_SIZE, MIN_PIXEL_SIZE,
} from '../rendering/pixel-streaks';

interface ColorSimplifyGripProps {
  spec: StretchSpec;
  /** The pad's origin: where the grip rests with every colour kept and hard borders, in view pixels. */
  at: Point;
  onChange: (patch: Partial<StretchSpec>, transient: boolean) => void;
  onBeginDrag: () => void;
}

/** Side of the square the grip moves in, in view pixels — a comfortable thumb reach. */
const PAD = 120;
/** Softest border gradient, in band pixels. */
const MAX_BLEND = 24;
/** Within this much of the pad's left or bottom edge, snap back to every colour or hard borders. */
const SNAP = 0.06;
const MIN_COLORS = 2;

/**
 * Canvas grip for how the band's sampled colours are simplified, working as a
 * small XY pad: the grip stays under the finger, its distance to the right
 * merges colours into fewer stripes and its height softens the borders between
 * them. Both change together, and the pad shows while dragging so it's clear
 * which way does what. A pixel-style band uses the same pad for block size
 * (right is bigger) and scatter (up is more ragged); a motion-style band for
 * how much streak lengths vary (right) and how soft they are (up).
 */
export function ColorSimplifyGrip(props: ColorSimplifyGripProps) {
  if (props.spec.style === 'pixel') return <PixelStyleGrip {...props} />;
  if (props.spec.style === 'motion') return <MotionStyleGrip {...props} />;
  return <SmoothStyleGrip {...props} />;
}

/** Smooth style: right merges colours into fewer stripes, up softens the borders between them. */
function SmoothStyleGrip({ spec, at, onChange, onBeginDrag }: ColorSimplifyGripProps) {
  const columns = Math.max(MIN_COLORS, Math.round(Math.abs(spec.width)));
  const colors = Math.min(columns, spec.colorCount ?? columns);
  const blend = Math.max(0, Math.min(MAX_BLEND, spec.colorBlend ?? 0));
  const active = spec.colorCount !== undefined && spec.colorCount < columns;
  // Colours run on a log scale so the interesting few-stripe range gets room.
  const logSpan = Math.log(columns / MIN_COLORS);
  const across = logSpan > 0 ? Math.log(columns / colors) / logSpan : 0;

  return (
    <PadGrip
      at={at}
      value={{ x: Math.max(0, Math.min(1, across)), y: blend / MAX_BLEND }}
      labels={['Colours →', 'Soft ↑']}
      active={active}
      soft={active && blend > 0}
      glyph="M-6,-5 V5 M-2,-5 V5 M2,-5 V5 M6,-5 V5"
      title="Drag right for fewer colours · drag up for softer borders between them"
      onBeginDrag={onBeginDrag}
      onMove={(x, y) => {
        const count = Math.round(columns * Math.exp(-x * logSpan));
        const colorCount = x < SNAP || count >= columns ? undefined : Math.max(MIN_COLORS, count);
        const colorBlend = y < SNAP ? undefined : Math.round(y * MAX_BLEND * 4) / 4;
        if (colorCount !== spec.colorCount || colorBlend !== spec.colorBlend) {
          onChange({ colorCount, colorBlend }, true);
        }
      }}
    />
  );
}

/** The XY pad itself: grip under the finger, both axes 0–1 from the bottom-left origin. */
function PadGrip({ at, value, labels, active, soft, glyph, title, onBeginDrag, onMove }: {
  at: Point;
  value: Point;
  labels: [string, string];
  active: boolean;
  soft: boolean;
  /** The grip's icon, drawn around its centre. */
  glyph: string;
  title: string;
  onBeginDrag: () => void;
  onMove: (x: number, y: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  /** Pointer offset from the grip's centre at grab, so it doesn't jump under the finger. */
  const grab = useRef<{ x: number; y: number; began: boolean } | null>(null);
  const grip = { x: at.x + PAD * value.x, y: at.y - PAD * value.y };

  const toSvg = (e: React.PointerEvent): Point | null => {
    const rect = (e.currentTarget as SVGElement).ownerSVGElement?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : null;
  };

  return (
    <g className="color-simplify-control">
      {dragging && (
        <g className="color-simplify-pad" aria-hidden="true">
          <rect x={at.x} y={at.y - PAD} width={PAD} height={PAD} rx={10} />
          <text x={at.x + PAD} y={at.y + 16} textAnchor="end">{labels[0]}</text>
          <text x={at.x - 8} y={at.y - PAD} textAnchor="end" dominantBaseline="hanging">{labels[1]}</text>
        </g>
      )}
      <line className="color-simplify-stem" x1={at.x} y1={at.y} x2={grip.x} y2={grip.y} />
      <g
        className={`color-simplify ${active ? 'active' : ''} ${soft ? 'soft' : ''}`}
        transform={`translate(${grip.x}, ${grip.y})`}
        onPointerDown={(e) => {
          // The canvas underneath would otherwise start drawing a new path.
          e.stopPropagation();
          e.preventDefault();
          const pointer = toSvg(e);
          if (!pointer) return;
          grab.current = { x: pointer.x - grip.x, y: pointer.y - grip.y, began: false };
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!grab.current) return;
          e.stopPropagation();
          const pointer = toSvg(e);
          if (!pointer) return;
          if (!grab.current.began) {
            grab.current.began = true;
            onBeginDrag();
          }
          onMove(
            Math.max(0, Math.min(1, (pointer.x - grab.current.x - at.x) / PAD)),
            Math.max(0, Math.min(1, (at.y - (pointer.y - grab.current.y)) / PAD)),
          );
        }}
        onPointerUp={(e) => {
          if (!grab.current) return;
          e.stopPropagation();
          grab.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          grab.current = null;
          setDragging(false);
        }}
      >
        <title>{title}</title>
        {/* Finger-sized hit area around the visible grip. */}
        <circle className="color-simplify-hit" r={22} />
        <circle r={12} />
        <path d={glyph} />
      </g>
    </g>
  );
}

/** Pixel style: right for bigger blocks, up for more ragged, broken streaks. */
function PixelStyleGrip({ spec, at, onChange, onBeginDrag }: ColorSimplifyGripProps) {
  const size = Math.max(MIN_PIXEL_SIZE, Math.min(MAX_PIXEL_SIZE, spec.pixelSize ?? DEFAULT_PIXEL_SIZE));
  const scatter = spec.pixelScatter ?? DEFAULT_PIXEL_SCATTER;
  // Block size on a log scale, so small blocks get as much room as big ones.
  const span = Math.log(MAX_PIXEL_SIZE / MIN_PIXEL_SIZE);
  const value = { x: Math.log(size / MIN_PIXEL_SIZE) / span, y: scatter };

  return (
    <PadGrip
      at={at}
      value={value}
      labels={['Blocks →', 'Scatter ↑']}
      active
      soft={false}
      glyph="M-6,-6 H-1 V-1 H-6 Z M1,1 H6 V6 H1 Z M1,-6 H6 V-1 M-6,1 V6 H-1"
      title="Drag right for bigger blocks · drag up for more ragged streaks"
      onBeginDrag={onBeginDrag}
      onMove={(x, y) => {
        const pixelSize = Math.round(MIN_PIXEL_SIZE * Math.exp(x * span));
        const pixelScatter = Math.round(y * 100) / 100;
        if (pixelSize !== spec.pixelSize || pixelScatter !== spec.pixelScatter) {
          onChange({ pixelSize, pixelScatter }, true);
        }
      }}
    />
  );
}

/** Motion style: right for more varied streak lengths, up for softer, longer fades. */
function MotionStyleGrip({ spec, at, onChange, onBeginDrag }: ColorSimplifyGripProps) {
  const scatter = spec.motionScatter ?? DEFAULT_MOTION_SCATTER;
  const softness = spec.motionSoftness ?? DEFAULT_MOTION_SOFTNESS;
  return (
    <PadGrip
      at={at}
      value={{ x: scatter, y: softness }}
      labels={['Scatter →', 'Soft ↑']}
      active
      soft={softness > 0}
      glyph="M-7,-4 H5 M-7,0 H7 M-7,4 H2"
      title="Drag right for more varied streak lengths · drag up for softer fades"
      onBeginDrag={onBeginDrag}
      onMove={(x, y) => {
        const motionScatter = Math.round(x * 100) / 100;
        const motionSoftness = Math.round(y * 100) / 100;
        if (motionScatter !== spec.motionScatter || motionSoftness !== spec.motionSoftness) {
          onChange({ motionScatter, motionSoftness }, true);
        }
      }}
    />
  );
}
